// PreToolUse(Bash) guard. Reads the hook JSON from stdin, never evaluates the command.
// Denies: git --no-verify, force push, rm -rf outside the project (temp dirs allowed), reading .env, hand-editing lockfiles.
// Anything else (and any input it cannot parse) is allowed. Deny = exit 2 + reason on stderr.
import { tmpdir } from 'node:os';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const TOKEN = /"([^"]*)"|'([^']*)'|(&&|\|\||;|\||\n)|([^\s;|&]+|&)/g;
const SEPARATORS = new Set(['&&', '||', ';', '|', '\n']);
const WRAPPERS = new Set(['sudo', 'env', 'command', 'nohup', 'time']);
const SHELLS = new Set(['bash', 'sh', 'zsh']);
const ENV_READERS = new Set(['cat', 'type', 'less', 'more', 'head', 'tail', 'grep', 'rg', 'sed', 'awk', 'bat', 'get-content', 'gc', 'source', '.']);
const ENV_FILE = /^\.env(\..+)?$/;
const ENV_TEMPLATE = /\.(example|sample|template)$/;
const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb']);
// rm is allowed on lockfiles (delete and reinstall is a normal fix); cp only writes its last argument.
const FILE_WRITERS = new Set(['mv', 'cp', 'tee', 'truncate']);
const HEREDOC = /(<<-?\s*(['"]?)(\w+)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g;
const SAFE_TEMP_ROOTS = ['/tmp', '/private/tmp', tmpdir()];
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const REDIRECT = /^\d?>>?/;

const allow = () => ({ allow: true });
const deny = (reason) => ({ allow: false, reason });

/** Command text -> list of segments, each a list of unquoted-word tokens (quotes stripped, operators split). */
export function segments(command) {
  const out = [[]];
  // Heredoc bodies are data, not commands: drop them so prose lines are not read as `rm` or `git`.
  for (const m of command.replace(HEREDOC, '$1').matchAll(TOKEN)) {
    if (m[3] !== undefined) {
      if (SEPARATORS.has(m[3])) out.push([]);
      continue;
    }
    out.at(-1).push(m[1] ?? m[2] ?? m[4]);
  }
  return out.filter((s) => s.length);
}

const flagsOf = (args) => args.filter((a) => a.startsWith('-'));
const isEnvFile = (p) => ENV_FILE.test(basename(p)) && !ENV_TEMPLATE.test(basename(p));
const isLockfile = (p) => LOCKFILES.has(basename(p));

function checkGit(args) {
  const words = [...args];
  while (words[0]?.startsWith('-')) words.splice(0, GIT_VALUE_OPTIONS.has(words[0]) ? 2 : 1); // `git -C dir commit -n`
  const [sub, ...rest] = words;
  const flags = flagsOf(rest);
  // -n is the short form of --no-verify for commit (also inside clusters such as -nm)
  const shortNoVerify = sub === 'commit' && flags.some((f) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(f));
  if (flags.includes('--no-verify') || shortNoVerify) return deny('git --no-verify skips the hooks; fix the hook failure instead');
  if (sub === 'push' && flags.some((f) => f === '--force' || f === '-f')) return deny('force push is blocked; use --force-with-lease after confirming with the owner');
  return allow();
}

/** Git Bash paths (`/c/Users/x`) -> `C:/Users/x` on Windows; unchanged elsewhere. */
const nativePath = (p) => (process.platform === 'win32' ? p.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:') : p);

const isUnder = (root, target) => {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

function insideProject(target, cwd, project) {
  if (target.startsWith('~') || target.includes('$')) return false;
  const abs = resolve(cwd, nativePath(target));
  return isUnder(project, abs) || SAFE_TEMP_ROOTS.some((root) => isUnder(root, abs));
}

function checkRm(args, cwd, project) {
  const recursive = flagsOf(args).some((f) => /^--recursive$|^-[a-zA-Z]*[rR]/.test(f));
  if (!recursive) return allow();
  const outside = args.filter((a) => !a.startsWith('-')).find((t) => !insideProject(t, cwd, project));
  return outside === undefined ? allow() : deny(`rm -r outside the project is blocked (${outside})`);
}

function checkEnvRead(cmd, args) {
  if (!ENV_READERS.has(cmd.toLowerCase())) return allow();
  const hit = args.find((a) => !a.startsWith('-') && isEnvFile(a));
  return hit === undefined ? allow() : deny(`reading ${basename(hit)} is blocked; ask the owner for the value`);
}

function redirectTargets(tokens) {
  const out = [];
  tokens.forEach((t, i) => {
    if (!REDIRECT.test(t)) return;
    const rest = t.replace(REDIRECT, '');
    const target = rest || tokens[i + 1];
    if (target) out.push(target);
  });
  return out;
}

function checkLockfileEdit(cmd, args) {
  const inPlace = ['sed', 'perl'].includes(cmd) && flagsOf(args).some((f) => /^-[a-zA-Z]*i/.test(f));
  const writes = FILE_WRITERS.has(cmd) || inPlace;
  const written = cmd === 'cp' ? args.filter((a) => !a.startsWith('-')).slice(-1) : args;
  const touched = [...(writes ? written : []), ...redirectTargets(args)].find(isLockfile);
  return touched === undefined ? allow() : deny(`${basename(touched)} is generated; run the package manager instead of editing it`);
}

function checkSegment(tokens, cwd, project) {
  let i = 0;
  while (i < tokens.length && (WRAPPERS.has(tokens[i]) || /^\w+=/.test(tokens[i]))) i++;
  const [cmd, ...args] = tokens.slice(i);
  if (cmd === undefined) return allow();
  if (SHELLS.has(cmd) && args[0] === '-c' && args[1]) return decide(args[1], { cwd, project });
  const checks = [
    () => (cmd === 'git' ? checkGit(args) : allow()),
    () => (cmd === 'rm' ? checkRm(args, cwd, project) : allow()),
    () => checkEnvRead(cmd, args),
    () => checkLockfileEdit(cmd, args),
  ];
  for (const check of checks) {
    const r = check();
    if (!r.allow) return r;
  }
  return allow();
}

/** Pure decision: { allow: true } or { allow: false, reason }. `project` and `cwd` are absolute paths. */
export function decide(command, { cwd = process.cwd(), project = cwd } = {}) {
  for (const seg of segments(command)) {
    const r = checkSegment(seg, cwd, project);
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
