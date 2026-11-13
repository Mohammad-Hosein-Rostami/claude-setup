// PreToolUse(Bash) guard. Reads the hook JSON from stdin, never evaluates the command.
// Exports: decide(command, {cwd, project, prodHosts}) -> {allow} | {allow:false, reason} | {allow:false, ask:true, reason};
// segments(command) -> string[][]. Parsing lives in lib/shell-words.mjs and lib/command-of.mjs.
// Three outcomes. DENY (exit 2, reason on stderr): git --no-verify (and unique prefixes), `git -c core.hooksPath`,
// `HUSKY=0 git`, force push (incl. -fu clusters and +refspec), `push --mirror`, remote branch delete; rm -r outside the
// project (temp dirs allowed, `cd` tracked within one command line, `cd` to `~`, `$HOME` and `$(git rev-parse
// --show-toplevel)` (from inside the project only) is resolved, as are leading `~`/`$HOME`/`$TMPDIR`/`$CLAUDE_PROJECT_DIR`
// and `VAR=$(mktemp ...)` variables in rm targets; $HOME, `/` and a drive root never count as the project); hand-editing
// lockfiles; a literal secret in the command (lib/secrets.mjs; the message never repeats it).
// ASK (exit 0 + permissionDecision "ask": the user is prompted even in bypassPermissions mode, verified on CLI 2.1.323):
// `git push` (not --dry-run), `gh release *`, `gh pr merge`, package publish (lib/outward.mjs), and ssh/scp/rsync/psql/mysql
// that write to a production host (lib/remote.mjs; list in ~/.claude/private/prod-hosts). A deny anywhere wins over an ask.
// ALLOW + LOG: `sed -i`, heredoc and inline-interpreter writes to code files are allowed; their paths go to the edit log
// so the Stop typecheck gate covers them (lib/code-writes.mjs, lib/edit-log.mjs).
// Everything else (and any input it cannot parse) is allowed. Reading files, `.env` included, is never blocked.
//
// This is a safety net against model mistakes, not a sandbox. Invariants: it never executes the command, it fails open on
// its own errors (except the secret deny), and it prefers a missed block over a false block of a normal dev command.
// Handled: `& && || ; |` and newlines as separators; `( ) {` groups, `$(...)` and backticks (also inside double
// quotes) re-checked as commands; leading `! if then do else elif while until`; command matched by basename
// (`/bin/rm`, `\rm`) through wrappers command/builtin/env/sudo/doas/nohup/xargs/exec/nice/timeout/stdbuf/time/sshpass;
// `bash -c '...'` is decided recursively.
// Known limits (not detected): other variables and aliases, `eval`, interpreter code (`node -e`, `python -c`), brace
// expansion, an unquoted backtick/`$()` used as an rm target, stdin to shells (`| bash`, `bash <<<`, heredoc to bash),
// unlisted wrappers (watch, chroot, parallel, `script -c`, `env -S`, busybox, fish/pwsh -c), rimraf, `find -delete`, `xargs`
// paths read from stdin, `$(...)` inside heredoc bodies, `cd` scoping in subshells (treated as global: extra denies
// only), an ssh alias that hides a production host, and the PowerShell tool (the hook matcher covers Bash only).
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { bashCodeWrites } from './lib/code-writes.mjs';
import { commandOf } from './lib/command-of.mjs';
import { editLogPath, recordEdit } from './lib/edit-log.mjs';
import { outwardAsk, pushAsk } from './lib/outward.mjs';
import { readProdHosts, remoteAsk } from './lib/remote.mjs';
import { findLiteralSecret } from './lib/secrets.mjs';
import { GIT_TOPLEVEL_WORD, QUOTED_MARK, basenameOf, flagsOf, segments, tokenize } from './lib/shell-words.mjs';

export { segments };

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
// an ask is a non-allow that the hook turns into a prompt instead of a block
const ask = (reason) => ({ allow: false, ask: true, reason });
const askOrAllow = (reason) => (reason === undefined ? allow() : ask(reason));

const isLockfile = (p) => LOCKFILES.has(basenameOf(p));

const ASK_OWNER = 'ask the owner first';
const NO_VERIFY = '--no-verify';
const MIN_NO_VERIFY_PREFIX = 8; // `--no-ver`: git accepts any unique prefix of a long option
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
  return deletes ? deny(`deleting a remote branch or tag is blocked; ${ASK_OWNER}`) : askOrAllow(pushAsk(flags));
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
  return sub === 'push' ? checkGitPush(rest, flags) : allow();
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

const VAR_PREFIX = /^\$\{?(\w+)\}?(?=\/|$)/;
const MKTEMP_ASSIGN = /\b(\w+)=["']?(?:\$\(\s*mktemp\b([^)]*)\)|`\s*mktemp\b([^`]*)`)/g;
const MKTEMP_LEAVES_TEMP = /[/~]|(?:^|\s)-p|--tmpdir=/; // an explicit directory or template can point anywhere
const MKTEMP_DIR = 'mktemp-variable';

/**
 * Variables whose value is known to be inside the project or a temp dir: `VAR=$(mktemp ...)` assigned in the same command
 * (default location only), `$TMPDIR`, `$CLAUDE_PROJECT_DIR`, and `$PWD` when the directory is known.
 * @returns {Map<string, string>} name -> absolute path
 */
function knownVars(command, cwd, project) {
  const vars = new Map([['TMPDIR', tmpdir()], ['CLAUDE_PROJECT_DIR', project]]);
  if (cwd !== null) vars.set('PWD', cwd);
  for (const [, name, inner = '', backtick = ''] of command.matchAll(MKTEMP_ASSIGN)) {
    if (!MKTEMP_LEAVES_TEMP.test(inner + backtick)) vars.set(name, join(tmpdir(), MKTEMP_DIR));
  }
  return vars;
}

const expandVars = (target, vars) => target.replace(VAR_PREFIX, (whole, name) => vars.get(name) ?? whole);

/** `cwd` is null when an earlier `cd` could not be resolved: then only absolute targets can be judged. */
function insideProject(rawTarget, cwd, project, vars) {
  const target = expandVars(expandHome(rawTarget), vars);
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

function checkRm(args, { cwd, project, vars }) {
  const recursive = flagsOf(args).some((f) => /^--recursive$|^-[a-zA-Z]*[rR]/.test(f));
  if (!recursive) return allow();
  const outside = withoutRedirects(args).filter((a) => !a.startsWith('-')).find((t) => !insideProject(t, cwd, project, vars));
  return outside === undefined ? allow() : deny(`rm -r outside the project is blocked (${outside.replace(QUOTED_MARK, '')})`);
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

function checkCommand({ cmd, args, assigns }, env) {
  if (SHELLS.has(cmd) && /^-[a-zA-Z]*c$/.test(args[0] ?? '') && args[1]) return decide(args[1], env);
  const checks = [
    () => (cmd === 'git' ? checkGit(args, assigns) : allow()),
    () => (cmd === 'rm' ? checkRm(args, env) : allow()),
    () => checkLockfileEdit(cmd, args),
    () => askOrAllow(outwardAsk(cmd, args) ?? remoteAsk(cmd, args, assigns, env.prodHosts)),
  ];
  let asking;
  for (const check of checks) {
    const r = check();
    if (r.ask) asking ??= r;
    else if (!r.allow) return r;
  }
  return asking ?? allow();
}

/**
 * Pure decision for one Bash command line. A deny anywhere in the line wins over an ask.
 * @param {string} command raw command text
 * @param {{cwd?: string|null, project?: string, prodHosts?: string[]}} ctx absolute paths (cwd null means "unknown
 *   directory") and the private production-host list (see lib/remote.mjs)
 * @returns {{allow: true} | {allow: false, reason: string} | {allow: false, ask: true, reason: string}}
 */
export function decide(command, { cwd = process.cwd(), project = cwd, prodHosts = [] } = {}) {
  const secret = findLiteralSecret(command);
  if (secret !== undefined) return deny(`the command contains ${secret}; keep secrets out of commands (use an env var or a file the tool reads) and ask the owner`);
  const vars = knownVars(command, cwd, project);
  const { segs, nested } = tokenize(command);
  let dir = cwd;
  let asking;
  const consider = (r) => {
    if (r.ask) asking ??= r;
    return r.ask || r.allow ? undefined : r;
  };
  for (const seg of segs) {
    const parsed = commandOf(seg);
    if (parsed.cmd === undefined) continue;
    const denied = consider(checkCommand(parsed, { cwd: dir, project, vars, prodHosts }));
    if (denied) return denied;
    dir = nextCwd(parsed.cmd, parsed.args, dir, project);
  }
  for (const inner of nested) {
    const denied = consider(decide(inner, { cwd, project, prodHosts }));
    if (denied) return denied;
  }
  return asking ?? allow();
}

/** Code files this command may rewrite go to the edit log, so the Stop typecheck gate covers them. Never throws. */
function logCodeWrites(command, input, cwd) {
  try {
    const logPath = editLogPath(input.session_id, input.agent_id);
    if (logPath) for (const file of bashCodeWrites(command, cwd)) recordEdit(logPath, file);
  } catch {
    // logging is best effort: a failure here must never block a command
  }
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
  let r;
  try {
    r = decide(command, { cwd, project, prodHosts: readProdHosts() });
  } catch {
    r = allow(); // fail open: the secret scan is the first step of decide(), so an error here means it found none
  }
  if (r.ask) {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: r.reason } })}\n`);
  } else if (!r.allow) {
    process.stderr.write(`Blocked by pre-bash-guard: ${r.reason}\n`);
    process.exitCode = 2;
  } else {
    logCodeWrites(command, input, cwd);
  }
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
