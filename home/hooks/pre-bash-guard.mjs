// PreToolUse(Bash) guard. Reads the hook JSON from stdin, never evaluates the command.
// Exports: decide(command, {cwd, project}) -> {allow} | {allow:false, reason}; segments(command) -> string[][].
// Parsing lives in lib/shell-words.mjs, `.env` read detection (a reader denylist) in lib/env-files.mjs.
// Denies: git --no-verify (and unique prefixes), `git -c core.hooksPath`, `HUSKY=0 git`, force push (incl. -fu clusters
// and +refspec), `push --mirror`, remote branch delete; rm -r outside the project (temp dirs allowed, `cd` tracked within
// one command line, `cd` to `~`, `$HOME` and `$(git rev-parse --show-toplevel)` (from inside the project only) is resolved,
// as are leading `~`/`$HOME` in rm targets; $HOME, `/` and a drive
// root never count as the project); reading .env (quoted, globbed, `< .env`, uploads, copies, `git show rev:.env`;
// output redirects such as `cat > .env` are writes and allowed); hand-editing lockfiles.
// Anything else (and any input it cannot parse) is allowed. Deny = exit 2 + reason on stderr.
//
// This is a safety net against model mistakes, not a sandbox. Invariants: it never executes the command, and it
// prefers a missed block over a false block of a normal dev command.
// Handled: `& && || ; |` and newlines as separators; `( ) {` groups, `$(...)` and backticks (also inside double
// quotes) re-checked as commands; leading `! if then do else elif while until`; command matched by basename
// (`/bin/rm`, `\rm`) through wrappers command/builtin/env/sudo/doas/nohup/xargs/exec/nice/timeout/stdbuf/time.
// Known limits (not detected): variables and aliases, `eval`, interpreter code (`node -e`, `python -c`), brace expansion,
// an unquoted backtick/`$()` used as an rm target, stdin to shells (`| bash`, `bash <<<`, heredoc to bash), unlisted
// wrappers (watch, chroot, parallel, `script -c`, `env -S`, busybox, fish/pwsh -c), rimraf, `find -delete`, `xargs`
// paths read from stdin, `$(...)` inside heredoc bodies, `cd` scoping in subshells (treated as global: extra denies
// only), and the PowerShell tool (the hook matcher covers Bash only). On Windows there is no OS sandbox, so this hook
// is the only .env guard there.
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, parse, relative, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { envReadHit, isEnvFile } from './lib/env-files.mjs';
import { GIT_TOPLEVEL_WORD, QUOTED_MARK, basenameOf, flagsOf, segments, stripOutputRedirects, tokenize } from './lib/shell-words.mjs';

export { segments };

const KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'do', 'else', 'elif', 'while', 'until']);
// wrapper -> options that consume the next token as their value
const WRAPPERS = new Map([
  ['command', new Set()], ['builtin', new Set()], ['nohup', new Set()], ['exec', new Set()], ['time', new Set()],
  ['sudo', new Set(['-u', '-g', '-C', '-h', '-p', '-r', '-t', '-U'])], ['doas', new Set(['-u', '-C'])],
  ['env', new Set(['-u', '-C'])], ['nice', new Set(['-n'])], ['timeout', new Set(['-s', '-k'])],
  ['xargs', new Set(['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a'])], ['stdbuf', new Set(['-i', '-o', '-e'])],
]);
const DURATION = /^\d+(\.\d+)?[smhd]?$/;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb']);
// rm is allowed on lockfiles (delete and reinstall is a normal fix); cp only writes its last argument.
const FILE_WRITERS = new Set(['mv', 'cp', 'tee', 'truncate']);
const SAFE_TEMP_ROOTS = ['/tmp', '/private/tmp', tmpdir()];
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const REDIRECT = /^(\d?>>?|&>>?)/;
const REDIRECT_START = /^(\d*>>?|\d*<|&>>?)/;
const REDIRECT_OPERATOR_ONLY = /^(\d*>>?|\d*<{1,2}|&>>?)$/;
const UNKNOWN_CD_TARGET = /^-|[~$`*?[\]{}]/;
const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;

const allow = () => ({ allow: true });
const deny = (reason) => ({ allow: false, reason });

const isLockfile = (p) => LOCKFILES.has(basenameOf(p));

const ASK_OWNER = 'ask the owner first';
const NO_VERIFY = '--no-verify';
const MIN_NO_VERIFY_PREFIX = 8; // `--no-ver`: git accepts any unique prefix of a long option
const REV_PATH_READERS = new Set(['show', 'cat-file', 'diff']);
const isHooksPathConfig = (value = '') => /^core\.hookspath=/i.test(value);

/** `git -c core.hooksPath=x` / `--config-env=core.hooksPath=x` replace the repo hooks for one command. */
function usesHooksPathOverride(words) {
  for (let i = 0; words[i]?.startsWith('-'); i += GIT_VALUE_OPTIONS.has(words[i]) ? 2 : 1) {
    const opt = words[i];
    const config = opt === '-c' ? words[i + 1] : opt.startsWith('-c') ? opt.slice(2) : opt.replace(/^--config-env=/, '');
    if (isHooksPathConfig(config)) return true;
  }
  return false;
}

function checkGitPush(rest, flags) {
  // `-f`, `-fu`, `-uf`; `--force-with-lease` does not match the single-dash cluster and stays allowed
  if (flags.some((f) => f === '--force' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(f))) return deny('force push is blocked; use --force-with-lease after confirming with the owner');
  if (rest.some((a) => /^\+[^\s]/.test(a))) return deny('a +refspec push is a force push; use --force-with-lease after confirming with the owner');
  if (flags.includes('--mirror')) return deny(`git push --mirror overwrites the remote; ${ASK_OWNER}`);
  const deletes = flags.includes('--delete') || flags.some((f) => /^-[a-zA-Z]*d[a-zA-Z]*$/.test(f)) || rest.some((a) => /^:[^\s]/.test(a));
  return deletes ? deny(`deleting a remote branch or tag is blocked; ${ASK_OWNER}`) : allow();
}

function checkGit(args, assigns = []) {
  if (assigns.includes('HUSKY=0')) return deny(`HUSKY=0 skips the git hooks; ${ASK_OWNER}`);
  if (usesHooksPathOverride(args)) return deny(`git -c core.hooksPath bypasses the hooks; ${ASK_OWNER}`);
  const words = [...args];
  while (words[0]?.startsWith('-')) words.splice(0, GIT_VALUE_OPTIONS.has(words[0]) ? 2 : 1); // `git -C dir commit -n`
  const [sub, ...rest] = words;
  const flags = flagsOf(rest);
  // -n is the short form of --no-verify for commit (also inside clusters such as -nm)
  const shortNoVerify = sub === 'commit' && flags.some((f) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(f));
  const prefixNoVerify = flags.some((f) => f.length >= MIN_NO_VERIFY_PREFIX && NO_VERIFY.startsWith(f.split('=')[0]));
  if (prefixNoVerify || shortNoVerify) return deny(`git ${NO_VERIFY} skips the hooks; fix the hook failure instead (${ASK_OWNER})`);
  if (sub === 'push') return checkGitPush(rest, flags);
  const revPath = REV_PATH_READERS.has(sub) ? rest.find((a) => a.includes(':') && isEnvFile(a.slice(a.lastIndexOf(':') + 1))) : undefined;
  return revPath === undefined ? allow() : deny(`reading ${basenameOf(revPath)} from git is blocked; ask the owner for the value`);
}

/** Git Bash paths (`/c/Users/x`) -> `C:/Users/x` on Windows; unchanged elsewhere. */
const nativePath = (p) => (process.platform === 'win32' ? p.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:') : p);

const isUnder = (root, target) => {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};
const sameFile = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const GIT_BASH_DRIVE_ROOT = /^\/[a-zA-Z]$/;

/** $HOME, `/`, a drive root (`C:\`, `/c/`) are never "the project": a session started there would allow rm -r anywhere. */
function isBroadRoot(project) {
  const path = resolve(nativePath(project));
  return sameFile(path, parse(path).root) || sameFile(path, resolve(homedir())) || GIT_BASH_DRIVE_ROOT.test(path);
}

/** `cwd` is null when an earlier `cd` could not be resolved: then only absolute targets can be judged. */
function insideProject(rawTarget, cwd, project) {
  const target = expandHome(rawTarget);
  if (target.startsWith('~') || target.includes('$')) return false;
  const native = nativePath(target);
  if (cwd === null && !isAbsolute(native)) return false;
  const abs = resolve(cwd ?? project, native);
  return (!isBroadRoot(project) && isUnder(project, abs)) || SAFE_TEMP_ROOTS.some((root) => isUnder(root, abs));
}

/** Drops redirections (`2>&1`, `> file`) so they are not mistaken for rm targets. */
function withoutRedirects(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (!REDIRECT_START.test(args[i])) out.push(args[i]);
    else if (REDIRECT_OPERATOR_ONLY.test(args[i])) i++; // the operator stands alone: its target is the next word
  }
  return out;
}

function checkRm(args, cwd, project) {
  const recursive = flagsOf(args).some((f) => /^--recursive$|^-[a-zA-Z]*[rR]/.test(f));
  if (!recursive) return allow();
  const outside = withoutRedirects(args).filter((a) => !a.startsWith('-')).find((t) => !insideProject(t, cwd, project));
  return outside === undefined ? allow() : deny(`rm -r outside the project is blocked (${outside.replace(QUOTED_MARK, '')})`);
}

function checkEnvRead(cmd, args, tokens) {
  // `cat > .env <<EOF`, `sort a > .env.sorted`: output targets are written, not read
  const hit = envReadHit(cmd, stripOutputRedirects(args), stripOutputRedirects(tokens));
  return hit === undefined ? allow() : deny(`reading ${basenameOf(hit)} is blocked; ask the owner for the value`);
}

function redirectTargets(tokens) {
  const out = [];
  tokens.forEach((t, i) => {
    if (!REDIRECT.test(t)) return;
    const target = t.replace(REDIRECT, '') || tokens[i + 1];
    if (target) out.push(target);
  });
  return out;
}

function checkLockfileEdit(cmd, args) {
  const inPlace = ['sed', 'perl'].includes(cmd) && flagsOf(args).some((f) => /^-[a-zA-Z]*i/.test(f));
  const writes = FILE_WRITERS.has(cmd) || inPlace;
  const written = cmd === 'cp' ? args.filter((a) => !a.startsWith('-')).slice(-1) : args;
  const touched = [...(writes ? written : []), ...redirectTargets(args)].find(isLockfile);
  return touched === undefined ? allow() : deny(`${basenameOf(touched)} is generated; run the package manager instead of editing it`);
}

/** Command word -> bare name: `/bin/rm`, `\rm` and `rm.exe` all become `rm` (lowercased on Windows). */
function commandName(word) {
  const name = basenameOf(word).replace(/\.exe$/i, '');
  return process.platform === 'win32' ? name.toLowerCase() : name;
}

/** Index of the first word after a wrapper's own options (`sudo -u me`, `timeout -s KILL 5`, `--`). */
function skipWrapperOptions(tokens, start, valueOptions, isTimeout) {
  let i = start;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '--') return i + 1;
    if (t.startsWith('-') && t.length > 1) i += valueOptions.has(t) ? 2 : 1;
    else if (isTimeout && DURATION.test(t)) i += 1;
    else break;
  }
  return i;
}

/** Segment tokens -> the real command, its arguments and the `VAR=x` words before it, looking through keywords and wrappers. */
function commandOf(tokens) {
  const assigns = [];
  let i = 0;
  while (i < tokens.length) {
    const word = tokens[i];
    const name = commandName(word);
    if (/^\w+=/.test(word)) assigns.push(word);
    if (KEYWORDS.has(word) || /^\w+=/.test(word)) i += 1;
    else if (WRAPPERS.has(name)) i = skipWrapperOptions(tokens, i + 1, WRAPPERS.get(name), name === 'timeout');
    else return { cmd: name, args: tokens.slice(i + 1), assigns };
  }
  return { cmd: undefined, args: [], assigns };
}

/** `~`, `~/x`, `$HOME`, `${HOME}` -> the home directory. Other words are unchanged. */
const expandHome = (target) => target.replace(HOME_PREFIX, homedir());

/** Like expandHome; the git top-level word -> the project, but only from inside it (elsewhere the top-level is unknown). */
function expandCdTarget(target, cwd, project) {
  if (target !== GIT_TOPLEVEL_WORD && !target.startsWith(`${GIT_TOPLEVEL_WORD}/`)) return expandHome(target);
  const root = resolve(nativePath(project));
  const inside = sameFile(resolve(cwd), root) || isUnder(root, resolve(cwd));
  return inside ? root + target.slice(GIT_TOPLEVEL_WORD.length) : target;
}

/** Working directory after `cd`/`pushd`/`popd`: literal targets are resolved, anything else makes it unknown (null). */
function nextCwd(cmd, args, cwd, project) {
  if (cmd === 'popd') return null;
  if (cmd !== 'cd' && cmd !== 'pushd') return cwd;
  if (cwd === null || args.length !== 1) return null;
  const target = expandCdTarget(args[0], cwd, project);
  return UNKNOWN_CD_TARGET.test(target) ? null : resolve(cwd, nativePath(target));
}

function checkCommand({ cmd, args, assigns, tokens }, cwd, project) {
  if (SHELLS.has(cmd) && /^-[a-zA-Z]*c$/.test(args[0] ?? '') && args[1]) return decide(args[1], { cwd, project });
  const checks = [
    () => (cmd === 'git' ? checkGit(args, assigns) : allow()),
    () => (cmd === 'rm' ? checkRm(args, cwd, project) : allow()),
    () => checkEnvRead(cmd, args, tokens),
    () => checkLockfileEdit(cmd, args),
  ];
  for (const check of checks) {
    const r = check();
    if (!r.allow) return r;
  }
  return allow();
}

/**
 * Pure decision for one Bash command line.
 * @param {string} command raw command text
 * @param {{cwd?: string|null, project?: string}} ctx absolute paths; cwd null means "unknown directory"
 * @returns {{allow: true} | {allow: false, reason: string}}
 */
export function decide(command, { cwd = process.cwd(), project = cwd } = {}) {
  const { segs, nested } = tokenize(command);
  let dir = cwd;
  for (const seg of segs) {
    const parsed = commandOf(seg);
    const { cmd, args } = parsed;
    if (cmd === undefined) continue;
    const r = checkCommand({ ...parsed, tokens: seg }, dir, project);
    if (!r.allow) return r;
    dir = nextCwd(cmd, args, dir, project);
  }
  for (const inner of nested) {
    const r = decide(inner, { cwd, project });
    if (!r.allow) return r;
  }
  return allow();
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return; // not hook JSON: nothing to guard
  }
  const command = input?.tool_input?.command;
  if (typeof command !== 'string') return;
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const project = process.env.CLAUDE_PROJECT_DIR || cwd;
  const r = decide(command, { cwd, project });
  if (!r.allow) {
    process.stderr.write(`Blocked by pre-bash-guard: ${r.reason}\n`);
    process.exitCode = 2;
  }
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
