// Setup-mode hook (normal | medium | high). One script, dispatches on `hook_event_name`:
//   SessionStart         -> prints the active mode and its playbook; prunes stale state files.
//   UserPromptExpansion  -> for `/mode <m>`: records the mode for this session, prints the playbook.
//   UserPromptSubmit     -> one reminder line when the active mode is not medium.
// State is per session: files in ~/.claude/state/modes/ keyed by session id and by the owning `claude` process
// (`pid-<n>`, so a mode survives /clear, which starts a new session id in the same process); the hook never writes
// settings files. Every SessionStart saves the session's mode, so a resumed session keeps it. Start mode on startup
// or resume = explicit env CLAUDE_MODE (set by `ccm <mode>`) -> the session's saved mode -> medium; both state
// files are overwritten then, so a reused pid never inherits a mode. Otherwise active mode = session file ->
// process file -> env CLAUDE_MODE -> medium. Stdout of these events is added to the model context. Invariants: never
// blocks (always exit 0); unreadable input produces no output; an unsafe session_id is never used in a path.
// Windows has no `ps`, so there is no process key there and a /mode switch does not survive /clear.
// Exports pure helpers for tests.
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const MODES = ['normal', 'medium', 'high'];
export const DEFAULT_MODE = 'medium';
const SESSION_ID_PATTERN = /^[\w-]+$/;
const STATE_MAX_AGE_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const USAGE = 'Usage: /mode normal|medium|high';
const MAX_ANCESTOR_DEPTH = 6; // hook -> shell -> claude is 2 levels; leave room for wrappers
const PS_TIMEOUT_MS = 1000;
const INIT_PID = 1;
const CLAUDE_COMMAND = /^claude/;
const LAUNCH_ENV_SOURCES = ['startup', 'resume']; // sources where the launch env picks the mode; clear/compact/fork continue the current one

const modesDir = () => join(homedir(), '.claude', 'modes');
const stateDir = () => join(homedir(), '.claude', 'state', 'modes');

/**
 * Whether a value is one of the three mode words.
 * @param {unknown} word - candidate mode.
 * @returns {boolean} true for normal, medium or high.
 */
export function isMode(word) {
  return typeof word === 'string' && MODES.includes(word);
}

/**
 * First word of the `/mode` arguments, lowercased.
 * @param {unknown} commandArgs - `command_args` from the hook input.
 * @returns {string} the word, or '' when there is none.
 */
export function parseModeArg(commandArgs) {
  if (typeof commandArgs !== 'string') return '';
  return commandArgs.trim().split(/\s+/)[0].toLowerCase();
}

/**
 * Whether a state file is older than the retention window.
 * @param {number} mtimeMs - file modification time.
 * @param {number} nowMs - current time.
 * @returns {boolean} true when it should be deleted.
 */
export function isStale(mtimeMs, nowMs) {
  return nowMs - mtimeMs > STATE_MAX_AGE_DAYS * MS_PER_DAY;
}

/**
 * Walk up the process tree to the `claude` process that owns this hook.
 * @param {number} startPid - first pid to inspect (the hook's parent).
 * @param {(pid: number) => {ppid: number, command: string} | undefined} lookup - process info for a pid.
 * @returns {number | undefined} the owner pid, or undefined when none is found within MAX_ANCESTOR_DEPTH.
 */
export function findOwnerPid(startPid, lookup) {
  let pid = startPid;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && pid > INIT_PID; depth += 1) {
    const info = lookup(pid);
    if (!info) return undefined;
    if (CLAUDE_COMMAND.test(basename(info.command))) return pid;
    pid = info.ppid;
  }
  return undefined;
}

function psLookup(pid) {
  try {
    const line = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: PS_TIMEOUT_MS,
    }).trim();
    const match = /^(\d+)\s+(.+)$/.exec(line);
    return match ? { ppid: Number(match[1]), command: match[2] } : undefined;
  } catch (error) {
    process.stderr.write(`mode hook: ps failed, mode will not survive /clear: ${error.message}\n`);
    return undefined;
  }
}

/** State key for the owning claude process, or undefined (Windows has no `ps`: session id only). */
function processKey() {
  if (process.platform === 'win32') return undefined;
  const pid = findOwnerPid(process.ppid, psLookup);
  return pid === undefined ? undefined : `pid-${pid}`;
}

async function readPlaybook(mode) {
  try {
    return (await readFile(join(modesDir(), `${mode}.md`), 'utf8')).trimEnd();
  } catch (error) {
    return `(playbook for ${mode} unreadable: ${error.code ?? error.message})`;
  }
}

async function readStateMode(key) {
  if (!key) return undefined;
  try {
    const word = (await readFile(join(stateDir(), key), 'utf8')).trim();
    return isMode(word) ? word : undefined;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    process.stderr.write(`mode hook: cannot read state: ${error.message}\n`);
    return undefined;
  }
}

function launchMode() {
  return isMode(process.env.CLAUDE_MODE) ? process.env.CLAUDE_MODE : DEFAULT_MODE;
}

async function activeMode(sessionId, procKey) {
  return (await readStateMode(sessionId)) || (await readStateMode(procKey)) || launchMode();
}

async function pruneState() {
  try {
    const dir = stateDir();
    const now = Date.now();
    for (const name of await readdir(dir)) {
      const file = join(dir, name);
      if (isStale((await stat(file)).mtimeMs, now)) await unlink(file);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') process.stderr.write(`mode hook: prune failed: ${error.message}\n`);
  }
}

/** Write the mode under each defined key; returns false (and reports to stderr) when a write fails. */
async function saveMode(mode, keys) {
  try {
    await mkdir(stateDir(), { recursive: true });
    for (const key of keys.filter(Boolean)) await writeFile(join(stateDir(), key), `${mode}\n`);
    return true;
  } catch (error) {
    process.stderr.write(`mode hook: cannot save state: ${error.message}\n`);
    return false;
  }
}

async function startMode(source, sessionId, procKey) {
  if (!LAUNCH_ENV_SOURCES.includes(source)) return activeMode(sessionId, procKey);
  if (isMode(process.env.CLAUDE_MODE)) return process.env.CLAUDE_MODE;
  return (source === 'resume' && (await readStateMode(sessionId))) || DEFAULT_MODE;
}

async function onSessionStart(input, sessionId, procKey) {
  const current = await startMode(input.source, sessionId, procKey);
  await saveMode(current, [sessionId, procKey]);
  const launched = isMode(process.env.CLAUDE_MODE) ? process.env.CLAUDE_MODE : 'default';
  console.log(`Mode: ${current} (launched as ${launched})\n\n${await readPlaybook(current)}`);
  await pruneState();
}

async function onExpansion(input, sessionId, procKey) {
  if (input.command_name !== 'mode') return;
  const target = parseModeArg(input.command_args);
  if (target === '') {
    const current = await activeMode(sessionId, procKey);
    console.log(`Active mode: ${current}. Switch with /mode normal|medium|high.`);
    return;
  }
  if (!isMode(target)) {
    console.log(USAGE);
    return;
  }
  if (!sessionId || !(await saveMode(target, [sessionId, procKey]))) {
    console.log(`Mode NOT switched: the state file could not be saved. Tell the user; the mode stays as it was.`);
    return;
  }
  console.log(`Mode switched to ${target} (this session only).\n\n${await readPlaybook(target)}`);
}

async function onPromptSubmit(sessionId, procKey) {
  const current = await activeMode(sessionId, procKey);
  if (current !== DEFAULT_MODE) console.log(`Mode: ${current} - follow ~/.claude/modes/${current}.md`);
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return; // not hook JSON: stay silent, never block
  }
  const id = input?.session_id;
  const sessionId = typeof id === 'string' && SESSION_ID_PATTERN.test(id) ? id : undefined;
  const event = input?.hook_event_name;
  if (!['SessionStart', 'UserPromptExpansion', 'UserPromptSubmit'].includes(event)) return;
  const procKey = processKey();
  switch (event) {
    case 'SessionStart':
      return onSessionStart(input, sessionId, procKey);
    case 'UserPromptExpansion':
      return onExpansion(input, sessionId, procKey);
    case 'UserPromptSubmit':
      return onPromptSubmit(sessionId, procKey);
    default:
      return;
  }
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`mode hook: ${error.message}\n`);
  }
}
