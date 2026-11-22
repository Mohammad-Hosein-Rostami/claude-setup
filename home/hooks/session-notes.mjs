// Session notes hook. One script, dispatches on `hook_event_name`:
//   SessionStart       -> prints the lead rules (~/.claude/lead-rules.md; nothing when missing), a line when the project's agent
//                         files set maxTurns, shadow the owner's agents or cannot be judged (lib/project-agents.mjs, run in a child
//                         process by lib/project-agents-timed.mjs: when it fails or the budget is used up the line says "not checked"
//                         and everything else is still printed), headed by MAX_TURNS_RULE (what the lead does with that line; it
//                         prints only with the line, so it costs no room in lead.md), and on `compact` the lib/compact-notes.mjs lines
//                         (Standing rules re-read and backfill, the status file to re-read); prunes old state.
//                         Inside a subagent (isSubagentStart: `agent_id` is a non-empty string, any other value is the lead): only
//                         SUBAGENT_COMPACT_NOTE on `compact` (no transcript scan: there `transcript_path` is the lead's, probe P1-8)
//                         and nothing on any other source; no child, no prune; its compactions are counted under
//                         `<session_id>-<agent_id>`, never under the lead's id.
//   UserPromptSubmit   -> a once-per-session "/clear or new session" line (lib/big-context.mjs).
// State: files in ~/.claude/state/modes/ (the folder keeps its old name, so the counts and flags of running sessions stay), keyed
// by session id: the compaction counts (read and written only as lib/state-files.mjs does it: never through a link, never waiting
// on a FIFO, written as a whole by rename) and the big-context flag `<session_id>.bigctx` (lib/big-context.mjs checks it with
// access and writes it by name). The hook never writes settings files. Stdout of these events is added to the model context.
// Invariants: never blocks (always exit 0); unreadable input produces no output; a state file name is built only from ids that pass
// SESSION_ID_PATTERN; a missing lead-rules.md prints nothing and is not reported; a FIFO, device, folder or oversized file there
// is not read (lib/plain-file.mjs) and is reported on stderr like any other read error.
// Time: one deadline, HOOK_BUDGET_MS from the start of this process: the child gets what is left of it and the prune stops when it
// is used up (and reads a bounded number of entries per run). Not inside it: the transcript scans of the compact notes and the
// big-context line. Claude Code drops the whole output of a hook that passes its timeout, and caps a hook's plain stdout at 10,000
// characters (hooks docs, "capped at 10,000 characters"; tests/session-start-size.test.mjs keeps this string under it).
// Exports: HOOK_BUDGET_MS, SESSION_ID_PATTERN, LEAD_RULES_MAX_BYTES, MAX_TURNS_RULE, isSubagentStart(input), hookText(input, deps).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { bigContextNote } from './lib/big-context.mjs';
import { compactNotes } from './lib/compact-notes.mjs';
import { pruneState } from './lib/state-files.mjs';
import { readPlainFile } from './lib/plain-file.mjs';
import { timedProjectAgentNote } from './lib/project-agents-timed.mjs';

export const SESSION_ID_PATTERN = /^[\w-]+$/;
// The one deadline of the hook, in ms from the start of this process: the 5,000 ms timeout of every session-notes.mjs entry in
// settings/base.json minus 1,000 ms for node's start and the printing (tests/project-agents-timed.test.mjs reads the entries).
export const HOOK_BUDGET_MS = 4000;
const EVENTS = ['SessionStart', 'UserPromptSubmit'];
const LEAD_RULES_FILE = 'lead-rules.md';
// Claude Code keeps at most 10,000 characters of a hook's stdout and a UTF-8 character is at most 4 bytes: a bigger file never fits.
export const LEAD_RULES_MAX_BYTES = 40_000;
// The owner's standing order for the project-agents line (moved here from lead.md, where it cost about 900 characters of the lead
// text's 10,000-character hook cap at every start although it is needed only when the line is printed). It stands before the line,
// so the hook's own words come ahead of the file names, which are repository data.
export const MAX_TURNS_RULE = 'The no-`maxTurns` rule covers a project\'s own agent files too: where the line below lists a file with `maxTurns` '
  + 'and gives the delete advice, delete that `maxTurns:` frontmatter line in its own commit (why in the body), without asking, and say so '
  + 'in one line (owner\'s standing order; an exception to C18 and C36). Edit only a regular file with one hard link whose real path lies '
  + 'in a `.claude/agents` folder of the session\'s git repository (from the session folder up to the git root, subfolders included), '
  + 'never through a link and never a file in the personal agents folder (`~/.claude/agents`). For a file the line marks "not read", '
  + '"not checked" or "check by hand", or does not list with `maxTurns`, edit nothing and tell the owner.';

const stateDir = () => join(homedir(), '.claude', 'state', 'modes');
/** A session or agent id that is safe as part of a state file name, else undefined. */
const safeId = (id) => (typeof id === 'string' && SESSION_ID_PATTERN.test(id) ? id : undefined);

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
 * The lead-only rules (`~/.claude/lead-rules.md`). SessionStart output reaches only the lead session, so workers never see it.
 * @returns {Promise<string>} the text, or '' when the file is missing, unreadable, not a regular file (a FIFO, a device, a
 *   folder) or larger than LEAD_RULES_MAX_BYTES (never throws, never waits; only a missing file is silent).
 */
async function readLeadRules() {
  try {
    // The install link is followed once (realpath); the open itself follows no link, never waits on a FIFO and reads only a
    // regular file of at most LEAD_RULES_MAX_BYTES (security review SA3: a FIFO here held the hook past its timeout).
    return readPlainFile(realpathSync(join(homedir(), '.claude', LEAD_RULES_FILE)), LEAD_RULES_MAX_BYTES).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') process.stderr.write(`session-notes hook: cannot read ${LEAD_RULES_FILE}: ${error.message}\n`);
    return '';
  }
}

/**
 * What a SessionStart inside a subagent prints: SUBAGENT_COMPACT_NOTE after a compaction, nothing otherwise. No lead rules, no
 * STATUS path (the input's `transcript_path` is the lead's: probe P1-8), no child and no prune: those belong to the lead session.
 * @param {object} input - the hook input (`source`, `agent_id`).
 * @param {string | undefined} sessionId - the checked session id.
 * @returns {Promise<string>} the text for stdout; the compaction is counted under `<session_id>-<agent_id>` when both ids are
 *   safe (else not counted), so it never moves the lead's count.
 */
async function subagentStartText(input, sessionId) {
  if (input.source !== 'compact') return '';
  const agentId = safeId(input.agent_id);
  return compactNotes(stateDir(), sessionId && agentId ? `${sessionId}-${agentId}` : undefined, undefined, { subagent: true });
}

/**
 * Everything the lead's SessionStart prints (MAX_TURNS_RULE only when a project-agents line follows it); it also prunes old state.
 * Order (security review 1 of round 9, S8): the compact notes come before the child, because their transcript scan is not bounded
 * by the budget and the child is, so the child, whose loss is handled, is what a slow scan cuts.
 * @param {object} input - the hook input (`source`, `cwd`, `transcript_path`).
 * @param {string | undefined} sessionId - the checked session id.
 * @param {{ timeLeft: () => number, agentNoteOptions?: { script?: string, timeoutMs?: number } }} run - the milliseconds left of
 *   the hook's budget, and for tests the options of timedProjectAgentNote.
 * @returns {Promise<string>} the text for stdout.
 */
async function leadStartText(input, sessionId, { timeLeft, agentNoteOptions }) {
  const leadRules = await readLeadRules();
  const compacted = input.source === 'compact' ? await compactNotes(stateDir(), sessionId, input.transcript_path) : '';
  const agentNote = timedProjectAgentNote(input.cwd, join(homedir(), '.claude', 'agents'), { ...agentNoteOptions, budgetLeftMs: timeLeft() });
  pruneState(stateDir(), timeLeft);
  return [leadRules, agentNote && MAX_TURNS_RULE, agentNote, compacted].filter(Boolean).join('\n\n');
}

/**
 * What the hook prints for one event. Everything the hook does happens here; main only reads stdin and prints.
 * @param {unknown} input - the parsed hook input.
 * @param {{ now?: () => number, agentNoteOptions?: { script?: string, timeoutMs?: number } }} [deps] - for tests: `now`, the
 *   milliseconds since the hook started (the default counts from the start of this process, which a hook is), and the child's options.
 * @returns {Promise<string>} the text for stdout; '' for nothing (another event, a subagent's start that is no compaction).
 */
export async function hookText(input, { now = () => performance.now(), agentNoteOptions } = {}) {
  const event = input?.hook_event_name;
  if (!EVENTS.includes(event)) return '';
  const sessionId = safeId(input.session_id);
  if (event === 'UserPromptSubmit') {
    return bigContextNote({ prompt: input.prompt, transcriptPath: input.transcript_path, dir: stateDir(), sessionId });
  }
  if (isSubagentStart(input)) return subagentStartText(input, sessionId);
  return leadStartText(input, sessionId, { timeLeft: () => HOOK_BUDGET_MS - now(), agentNoteOptions });
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
    process.stderr.write(`session-notes hook: ${error.message}\n`);
  }
}
