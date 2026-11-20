// Setup-mode hook (normal | medium | high | extra-high | ultra-high). One script, dispatches on `hook_event_name`:
//   SessionStart         -> prints the active mode, the lead-only rules (modes/_lead.md; nothing when missing) and the
//                           mode's playbook (plus a lead note when an extra-high / ultra-high session was not launched
//                           with `ccm <mode>` or its model does not match; a line when the project's agent files set maxTurns, shadow the owner's agents or cannot be judged (lib/project-agents.mjs, run in a child process by lib/project-agents-timed.mjs: when it fails or the budget is used up the line says "not checked" and everything else is still printed); on `compact`, lib/compact-notes.mjs lines incl. the Standing rules re-read and backfill, the status file to re-read); prunes state.
//                           Inside a subagent (isSubagentStart: `agent_id` is a non-empty string, any other value is the lead): only the
//                           compact notes on `compact` and nothing on any other source; no `ps` walk, no child, no state save, no
//                           prune; its compactions are counted under `<session_id>-<agent_id>`, never under the lead's id.
//   UserPromptExpansion  -> for `/mode <m>`: records the mode for this session, prints the playbook (plus a lead note
//                           when the switch moves the lead to or from Opus max / Fable high).
//   UserPromptSubmit     -> the reminder line when the mode is not medium and differs from the mode last announced to this session
//                           (a SessionStart that ended inside the budget, a /mode switch and the line itself announce it:
//                           `<session_id>.announced`; without a session id on every prompt), plus a once-per-session "/clear or new session" line (lib/big-context.mjs).
// State is per session: files in ~/.claude/state/modes/ keyed by session id and by the owning `claude` process
// (`pid-<n>`, so a mode survives /clear, which starts a new session id in the same process); the hook never writes
// settings files. Every SessionStart saves the session's mode, so a resumed session keeps it. Start mode on startup
// or resume = explicit env CLAUDE_MODE (set by `ccm <mode>`) -> the session's saved mode -> medium; both state
// files are overwritten then, so a reused pid never inherits a mode. Otherwise active mode = session file ->
// process file -> env CLAUDE_MODE -> medium. Stdout of these events is added to the model context. Invariants: never
// blocks (always exit 0); unreadable input produces no output; a state file name is built only from ids that pass
// SESSION_ID_PATTERN, and a state file is read and written only as lib/mode-state.mjs does it (never through a link, never
// waiting on a FIFO, a few bytes, written as a whole by rename). A project's settings `env` can set CLAUDE_MODE (it picks the start mode) and PATH (lib/owner-process.mjs).
// Time: one deadline, HOOK_BUDGET_MS from the start of this process, on all three events: the `ps` walk (lib/owner-process.mjs,
// run lazily: only when the session file cannot answer or a mode is saved) and the child share it, the prune stops when it is
// used up (and reads a bounded number of entries per run), and a SessionStart past it records no mode as announced. Not inside
// it: the transcript scans of the compact notes and the big-context line. Claude Code drops the whole output of a hook that
// passes its timeout.
// The lead model and effort of extra-high / ultra-high are set by `ccm` at launch (a hook cannot change them), so the lead note only names the `ccm` line.
// Windows has no `ps`, so a /mode switch does not survive /clear there. Exports pure helpers and hookText for tests.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { bigContextNote } from './lib/big-context.mjs';
import { compactNotes } from './lib/compact-notes.mjs';
import { leadNote } from './lib/lead-note.mjs';
import { isStale, pruneState, readStateText, writeStateText } from './lib/mode-state.mjs';
import { lazyProcessKey } from './lib/owner-process.mjs';
import { timedProjectAgentNote } from './lib/project-agents-timed.mjs';

export { isStale, leadNote };

export const MODES = ['normal', 'medium', 'high', 'extra-high', 'ultra-high'];
export const DEFAULT_MODE = 'medium';
export const SESSION_ID_PATTERN = /^[\w-]+$/;
const USAGE = `Usage: /mode ${MODES.join('|')}`;
// The one deadline of the hook, in ms from the start of this process: the 5,000 ms timeout of every mode.mjs entry in
// settings/base.json minus 1,000 ms for node's start and the printing (tests/project-agents-timed.test.mjs reads the entries).
export const HOOK_BUDGET_MS = 4000;
const EVENTS = ['SessionStart', 'UserPromptExpansion', 'UserPromptSubmit'];
const ANNOUNCED_SUFFIX = '.announced'; // state file of the mode last announced to a session
const LAUNCH_ENV_SOURCES = ['startup', 'resume']; // sources where the launch env picks the mode; clear/compact/fork continue the current one
const LEAD_RULES_FILE = '_lead.md';

const modesDir = () => join(homedir(), '.claude', 'modes');
const stateDir = () => join(homedir(), '.claude', 'state', 'modes');
/** A session or agent id that is safe as part of a state file name, else undefined. */
const safeId = (id) => (typeof id === 'string' && SESSION_ID_PATTERN.test(id) ? id : undefined);
const announcedKey = (sessionId) => (sessionId ? `${sessionId}${ANNOUNCED_SUFFIX}` : undefined);

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
 * Whether a SessionStart comes from inside a subagent. The one place that decides it (probe P1-8 checks that Claude Code sends
 * `agent_id` there; another signal would replace this body).
 * @param {unknown} input - the hook input.
 * @returns {boolean} true only when `agent_id` is a non-empty string; any other value is the lead session.
 */
export function isSubagentStart(input) {
  return typeof input?.agent_id === 'string' && input.agent_id !== '';
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

/** The mode saved under a state key; undefined without a key, a readable state file (lib/mode-state.mjs) or a mode word in it. */
function readStateMode(key) {
  const word = key ? readStateText(join(stateDir(), key))?.trim() : undefined;
  return isMode(word) ? word : undefined;
}

function launchMode() {
  return isMode(process.env.CLAUDE_MODE) ? process.env.CLAUDE_MODE : DEFAULT_MODE;
}

export function activeMode(sessionId, getProcKey) {
  return readStateMode(sessionId) || readStateMode(getProcKey()) || launchMode();
}

/** Write the mode under each defined key (each file as a whole: lib/mode-state.mjs); false, reported on stderr, when a write fails. */
function saveMode(mode, keys) {
  try {
    for (const key of keys.filter(Boolean)) writeStateText(stateDir(), key, `${mode}\n`);
    return true;
  } catch (error) {
    process.stderr.write(`mode hook: cannot save state: ${error.message}\n`);
    return false;
  }
}

function startMode(source, sessionId, getProcKey) {
  if (!LAUNCH_ENV_SOURCES.includes(source)) return activeMode(sessionId, getProcKey);
  if (isMode(process.env.CLAUDE_MODE)) return process.env.CLAUDE_MODE;
  return (source === 'resume' && readStateMode(sessionId)) || DEFAULT_MODE;
}

/**
 * What a SessionStart inside a subagent prints: the compact notes after a compaction, nothing otherwise. No lead rules, no
 * playbook, no `ps` walk, no child, no state save and no prune: those belong to the lead session.
 * @param {object} input - the hook input (`source`, `agent_id`, `transcript_path`).
 * @param {string | undefined} sessionId - the checked session id.
 * @returns {Promise<string>} the text for stdout; the compaction is counted under `<session_id>-<agent_id>` when both ids are
 *   safe (else not counted), so it never moves the lead's count.
 */
async function subagentStartText(input, sessionId) {
  if (input.source !== 'compact') return '';
  const agentId = safeId(input.agent_id);
  return compactNotes(stateDir(), sessionId && agentId ? `${sessionId}-${agentId}` : undefined, input.transcript_path);
}

/**
 * Everything the lead's SessionStart prints; it also saves the session's mode, prunes old state and records the mode as announced.
 * Order (security review 1 of round 9, S8 and S2): the compact notes come before the child, because their transcript scan is not
 * bounded by the budget and the child is, so the child, whose loss is handled, is what a slow scan cuts; the mode is recorded as
 * announced last and only inside the budget, so a start that ran late (its output may be dropped) leaves the per-prompt line on.
 * @param {object} input - the hook input (`source`, `model`, `cwd`, `transcript_path`).
 * @param {string | undefined} sessionId - the checked session id.
 * @param {{ getProcKey: () => string | undefined, timeLeft: () => number, agentNoteOptions?: { script?: string, timeoutMs?: number } }} run -
 *   the lazy process key, the milliseconds left of the hook's budget, and for tests the options of timedProjectAgentNote.
 * @returns {Promise<string>} the text for stdout.
 */
async function leadStartText(input, sessionId, { getProcKey, timeLeft, agentNoteOptions }) {
  const current = startMode(input.source, sessionId, getProcKey);
  saveMode(current, [sessionId, getProcKey()]);
  const launchedAs = process.env.CLAUDE_MODE ?? '';
  const leadRules = await readLeadRules();
  const start = `Mode: ${current} (launched as ${isMode(launchedAs) ? launchedAs : 'default'})\n\n${leadRules ? `${leadRules}\n\n` : ''}${await readPlaybook(current)}`;
  const compacted = input.source === 'compact' ? await compactNotes(stateDir(), sessionId, input.transcript_path) : '';
  const agentNote = timedProjectAgentNote(input.cwd, join(homedir(), '.claude', 'agents'), { ...agentNoteOptions, budgetLeftMs: timeLeft() });
  pruneState(stateDir(), timeLeft);
  if (timeLeft() > 0) saveMode(current, [announcedKey(sessionId)]);
  return [start, leadNote({ mode: current, model: input.model, launchedAs }), agentNote, compacted].filter(Boolean).join('\n\n');
}

async function expansionText(input, sessionId, getProcKey) {
  if (input.command_name !== 'mode') return '';
  const target = parseModeArg(input.command_args);
  if (target === '') return `Active mode: ${activeMode(sessionId, getProcKey)}. Switch with /mode ${MODES.join('|')}.`;
  if (!isMode(target)) return USAGE;
  const previousMode = activeMode(sessionId, getProcKey);
  if (!sessionId || !saveMode(target, [sessionId, getProcKey(), announcedKey(sessionId)])) {
    return 'Mode NOT switched: the state file could not be saved. Tell the user; the mode stays as it was.';
  }
  const note = leadNote({ mode: target, previousMode, launchedAs: process.env.CLAUDE_MODE ?? '' });
  return `Mode switched to ${target} (this session only).\n\n${await readPlaybook(target)}${note ? `\n\n${note}` : ''}`;
}

async function promptText(input, sessionId, getProcKey) {
  const current = activeMode(sessionId, getProcKey);
  const lines = [];
  // Once per announced mode: SessionStart and a /mode switch already told this session its mode (2,404 identical lines counted).
  if (current !== DEFAULT_MODE && current !== readStateMode(announcedKey(sessionId))) {
    lines.push(`Mode: ${current} - follow ~/.claude/modes/${current}.md`);
    saveMode(current, [announcedKey(sessionId)]);
  }
  const big = await bigContextNote({ prompt: input.prompt, transcriptPath: input.transcript_path, dir: stateDir(), sessionId });
  if (big) lines.push(big);
  return lines.join('\n');
}

/**
 * What the hook prints for one event. Everything the hook does happens here; main only reads stdin and prints.
 * @param {unknown} input - the parsed hook input.
 * @param {{ now?: () => number, lookup?: (pid: number, timeoutMs: number) => { ppid: number, command: string } | undefined,
 *   agentNoteOptions?: { script?: string, timeoutMs?: number } }} [deps] - for tests: `now`, the milliseconds since the hook
 *   started (the default counts from the start of this process, which a hook is), a fake `ps` lookup, and the child's options.
 * @returns {Promise<string>} the text for stdout; '' for nothing (another event, a subagent's start that is no compaction).
 */
export async function hookText(input, { now = () => performance.now(), lookup, agentNoteOptions } = {}) {
  const event = input?.hook_event_name;
  if (!EVENTS.includes(event)) return '';
  const sessionId = safeId(input.session_id);
  if (event === 'SessionStart' && isSubagentStart(input)) return subagentStartText(input, sessionId);
  const timeLeft = () => HOOK_BUDGET_MS - now();
  const getProcKey = lazyProcessKey(timeLeft, lookup);
  switch (event) {
    case 'SessionStart':
      return leadStartText(input, sessionId, { getProcKey, timeLeft, agentNoteOptions });
    case 'UserPromptExpansion':
      return expansionText(input, sessionId, getProcKey);
    default:
      return promptText(input, sessionId, getProcKey);
  }
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
  const text = await hookText(input);
  if (text) console.log(text);
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`mode hook: ${error.message}\n`);
  }
}
