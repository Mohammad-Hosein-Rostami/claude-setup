// Setup-mode hook (normal | medium | high | extra-high | ultra-high). One script, dispatches on `hook_event_name`:
//   SessionStart         -> prints the active mode, the lead-only rules (modes/_lead.md; nothing when missing) and the
//                           mode's playbook (plus a lead note when an extra-high / ultra-high session was not launched
//                           with `ccm <mode>` or its model does not match; a line when the project's agent files set maxTurns, shadow the owner's agents or cannot be judged (lib/project-agents.mjs, run in a child process with a 2 s limit by lib/project-agents-timed.mjs: when it fails the line says "not checked" and everything else is still printed); on `compact`, lib/compact-notes.mjs lines incl. the Standing rules re-read and backfill, the status file to re-read); prunes state.
//   UserPromptExpansion  -> for `/mode <m>`: records the mode for this session, prints the playbook (plus a lead note
//                           when the switch moves the lead to or from Opus max / Fable high).
//   UserPromptSubmit     -> one reminder line when the mode is not medium, plus a once-per-session "/clear or new session" line (lib/big-context.mjs).
// State is per session: files in ~/.claude/state/modes/ keyed by session id and by the owning `claude` process
// (`pid-<n>`, so a mode survives /clear, which starts a new session id in the same process); the hook never writes
// settings files. Every SessionStart saves the session's mode, so a resumed session keeps it. Start mode on startup
// or resume = explicit env CLAUDE_MODE (set by `ccm <mode>`) -> the session's saved mode -> medium; both state
// files are overwritten then, so a reused pid never inherits a mode. Otherwise active mode = session file ->
// process file -> env CLAUDE_MODE -> medium. Stdout of these events is added to the model context. Invariants: never
// blocks (always exit 0); unreadable input produces no output; an unsafe session_id is never used in a path.
// The lead model and effort of extra-high / ultra-high are set by `ccm` at launch (a hook cannot change them), so the lead note only names the `ccm` line.
// The process key is computed lazily (`ps` runs only when the session file cannot answer or a mode is saved); Windows
// has no `ps`, so a /mode switch does not survive /clear there. Exports pure helpers for tests.
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { bigContextNote } from './lib/big-context.mjs';
import { compactNotes } from './lib/compact-notes.mjs';
import { leadNote } from './lib/lead-note.mjs';
import { timedProjectAgentNote } from './lib/project-agents-timed.mjs';

export { leadNote };

export const MODES = ['normal', 'medium', 'high', 'extra-high', 'ultra-high'];
export const DEFAULT_MODE = 'medium';
export const SESSION_ID_PATTERN = /^[\w-]+$/;
const STATE_MAX_AGE_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const USAGE = `Usage: /mode ${MODES.join('|')}`;
const MAX_ANCESTOR_DEPTH = 6; // hook -> shell -> claude is 2 levels; leave room for wrappers
const PS_TIMEOUT_MS = 1000;
const INIT_PID = 1;
const CLAUDE_COMMAND = /^claude/;
const LAUNCH_ENV_SOURCES = ['startup', 'resume']; // sources where the launch env picks the mode; clear/compact/fork continue the current one
const LEAD_RULES_FILE = '_lead.md';

const modesDir = () => join(homedir(), '.claude', 'modes');
const stateDir = () => join(homedir(), '.claude', 'state', 'modes');

/**
 * Whether a value is one of the mode words.
 * @param {unknown} word - candidate mode.
 * @returns {boolean} true for a word in MODES.
 */
export function isMode(word) {
  return typeof word === 'string' && MODES.includes(word);
}

/**
 * The mode named by the `/mode` arguments, lowercased: the whole text with whitespace runs joined by `-` when that
 * is a mode (`extra high` -> `extra-high`), else the first word.
 * @param {unknown} commandArgs - `command_args` from the hook input.
 * @returns {string} the word, or '' when there is none.
 */
export function parseModeArg(commandArgs) {
  if (typeof commandArgs !== 'string') return '';
  const text = commandArgs.trim().toLowerCase();
  const joined = text.split(/\s+/).join('-');
  return isMode(joined) ? joined : text.split(/\s+/)[0];
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

/**
 * Lazy state key for the owning claude process: `ps` runs only when the key is first asked for (so never when the
 * session file answers) and the result is cached. Windows has no `ps`: the key is undefined (session id only).
 * @returns {() => string | undefined} getter for `pid-<n>`, or undefined when there is no owner process.
 */
export function lazyProcessKey() {
  let computed = false;
  let key;
  return () => {
    if (!computed) {
      computed = true;
      if (process.platform !== 'win32') {
        const pid = findOwnerPid(process.ppid, psLookup);
        key = pid === undefined ? undefined : `pid-${pid}`;
      }
    }
    return key;
  };
}

/**
 * The lead-only rules (`modes/_lead.md`). SessionStart output reaches only the lead session, so workers never see it.
 * @returns {Promise<string>} the text, or '' when the file is missing or unreadable (never throws).
 */
async function readLeadRules() {
  try {
    return (await readFile(join(modesDir(), LEAD_RULES_FILE), 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') process.stderr.write(`mode hook: cannot read ${LEAD_RULES_FILE}: ${error.message}\n`);
    return '';
  }
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

export async function activeMode(sessionId, getProcKey) {
  return (await readStateMode(sessionId)) || (await readStateMode(getProcKey())) || launchMode();
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

async function startMode(source, sessionId, getProcKey) {
  if (!LAUNCH_ENV_SOURCES.includes(source)) return activeMode(sessionId, getProcKey);
  if (isMode(process.env.CLAUDE_MODE)) return process.env.CLAUDE_MODE;
  return (source === 'resume' && (await readStateMode(sessionId))) || DEFAULT_MODE;
}

/**
 * Everything the SessionStart event prints; it also saves the session's mode.
 * @param {object} input - the hook input (`source`, `model`, `cwd`, `transcript_path`).
 * @param {string | undefined} sessionId - the checked session id.
 * @param {() => string | undefined} getProcKey - from lazyProcessKey().
 * @param {{ script?: string, timeoutMs?: number }} [agentNoteOptions] - for tests: see timedProjectAgentNote.
 * @returns {Promise<string>} the text for stdout.
 */
export async function sessionStartText(input, sessionId, getProcKey, agentNoteOptions) {
  const current = await startMode(input.source, sessionId, getProcKey);
  await saveMode(current, [sessionId, getProcKey()]);
  const launchedAs = process.env.CLAUDE_MODE ?? '';
  const note = leadNote({ mode: current, model: input.model, launchedAs });
  const leadRules = await readLeadRules();
  const agentNote = timedProjectAgentNote(input.cwd, join(homedir(), '.claude', 'agents'), agentNoteOptions);
  return `Mode: ${current} (launched as ${isMode(launchedAs) ? launchedAs : 'default'})\n\n${leadRules ? `${leadRules}\n\n` : ''}${await readPlaybook(current)}${note ? `\n\n${note}` : ''}${agentNote ? `\n\n${agentNote}` : ''}${input.source === 'compact' ? `\n\n${await compactNotes(stateDir(), sessionId, input.transcript_path)}` : ''}`;
}

async function onSessionStart(input, sessionId, getProcKey) {
  console.log(await sessionStartText(input, sessionId, getProcKey));
  await pruneState();
}

async function onExpansion(input, sessionId, getProcKey) {
  if (input.command_name !== 'mode') return;
  const target = parseModeArg(input.command_args);
  if (target === '') {
    const current = await activeMode(sessionId, getProcKey);
    console.log(`Active mode: ${current}. Switch with /mode ${MODES.join('|')}.`);
    return;
  }
  if (!isMode(target)) {
    console.log(USAGE);
    return;
  }
  const previousMode = await activeMode(sessionId, getProcKey);
  if (!sessionId || !(await saveMode(target, [sessionId, getProcKey()]))) {
    console.log('Mode NOT switched: the state file could not be saved. Tell the user; the mode stays as it was.');
    return;
  }
  const note = leadNote({ mode: target, previousMode, launchedAs: process.env.CLAUDE_MODE ?? '' });
  console.log(`Mode switched to ${target} (this session only).\n\n${await readPlaybook(target)}${note ? `\n\n${note}` : ''}`);
}

async function onPromptSubmit(input, sessionId, getProcKey) {
  const current = await activeMode(sessionId, getProcKey);
  if (current !== DEFAULT_MODE) console.log(`Mode: ${current} - follow ~/.claude/modes/${current}.md`);
  const big = await bigContextNote({ prompt: input.prompt, transcriptPath: input.transcript_path, dir: stateDir(), sessionId });
  if (big) console.log(big);
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
  const getProcKey = lazyProcessKey();
  switch (event) {
    case 'SessionStart':
      return onSessionStart(input, sessionId, getProcKey);
    case 'UserPromptExpansion':
      return onExpansion(input, sessionId, getProcKey);
    case 'UserPromptSubmit':
      return onPromptSubmit(input, sessionId, getProcKey);
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
