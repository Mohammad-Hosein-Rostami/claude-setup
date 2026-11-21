// Shared fixtures of the call-window tests (lib/call-windows.mjs, lib/change-owner.mjs, lib/base-moves.mjs and the two gates that use
// them): a private HOME, edges sent to the real commit-gate hook process with inputs shaped as the hooks docs describe them, log lines of
// ANOTHER session written by hand (their `at` values are set around a real reflog size or a file's real ctime), and a synthetic
// transcript in the line shape seen on CLI 2.1.329 (`assistant` lines whose `message.content` holds `tool_use` blocks; not a recording).
// Exports: SESSION, OTHER, LOG_DIR, logPath, writeLog, appendLog, edges (line builders), hookRun, edge, stopEvent, reflogOf, sizeOf,
//   ctimeOf, leadTranscript, agentTranscript, readLog.
// Invariants: every test runs under its own temp HOME (P8); no line here asserts elapsed time (P12).
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, git } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const COMMIT_GATE = fileURLToPath(new URL('../home/hooks/commit-gate.mjs', import.meta.url));
export const SESSION = 'sess-1';
export const OTHER = 'other-session';
export const LOG_DIR = (home) => join(home, '.claude', 'state', 'call-windows');
export const logPath = (home, session = SESSION) => join(LOG_DIR(home), `${session}.jsonl`);

/** Writes the whole log of `session` (folder 0700, file 0600), one JSON line per entry. */
export function writeLog(home, session, lines) {
  mkdirSync(LOG_DIR(home), { recursive: true, mode: 0o700 });
  chmodSync(LOG_DIR(home), 0o700);
  writeFileSync(logPath(home, session), lines.map((line) => `${JSON.stringify(line)}\n`).join(''), { mode: 0o600 });
}

/** Appends lines to the log of `session`. */
export const appendLog = (home, session, lines) => appendFileSync(logPath(home, session), lines.map((line) => `${JSON.stringify(line)}\n`).join(''));

/** The parsed lines of a log. */
export const readLog = (home, session = SESSION) => readFileSync(logPath(home, session), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

/** Line builders in the shapes of the spec's table (section 2.2). */
export const edges = {
  open: (id, at, b = [], extra = {}) => ({ t: 'open', id, agent: '', tool: 'Bash', at, bg: false, b, ...extra }),
  close: (id, at, b = [], extra = {}) => ({ t: 'close', id, agent: '', at, bg: false, b, ...extra }),
  batch: (ids, at, b = [], agent = '') => ({ t: 'batch', agent, ids, at, b }),
  quiet: (types, at, b = [], agent = '') => ({ t: 'quiet', agent, types, at, b }),
  watch: (k, reflog, bytes, tip, at, settled = false) => ({ t: 'watch', k, reflog, bytes, tip, settled, at }),
  folder: (top, at) => ({ t: 'watch', top, at }),
};

/** Runs the commit-gate hook process with `input`; returns {status, stdout, stderr}. */
export function hookRun(home, input, project) {
  const env = { ...CLEAN_ENV, HOME: home, USERPROFILE: home, ...(project === undefined ? {} : { CLAUDE_PROJECT_DIR: project }) };
  return spawnSync(process.execPath, [COMMIT_GATE], { input: JSON.stringify(input), encoding: 'utf8', env });
}

/**
 * Sends one tool edge of this session to the real hook: `event` PreToolUse, PostToolUse, PostToolUseFailure or PostToolBatch.
 * @returns {void} fails the test when the hook is not silent
 */
export function edge(home, project, event, fields) {
  const result = hookRun(home, { hook_event_name: event, session_id: SESSION, cwd: project, ...fields }, project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(`${result.stdout}${result.stderr}`, '', `${event} is silent`);
}

/** Pre and Post of one foreground call (`tool`, `id`) around `work()`. */
export function call(home, project, { tool = 'Bash', id, input = { command: 'make' }, cwd = project, agent, response = {} }, work = () => {}) {
  const who = agent === undefined ? {} : { agent_id: agent, agent_type: 'implementer' };
  edge(home, project, 'PreToolUse', { tool_name: tool, tool_use_id: id, tool_input: input, cwd, ...who });
  work();
  edge(home, project, 'PostToolUse', { tool_name: tool, tool_use_id: id, tool_input: input, tool_response: response, cwd, ...who });
}

/** The real path of the reflog of `branch` in the repository of `dir` (its shared git folder). */
export function reflogOf(dir, branch) {
  const common = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  return realpathSync(join(common, 'logs', 'refs', 'heads', branch));
}

export const sizeOf = (path) => lstatSync(path).size;
export const ctimeOf = (path) => lstatSync(path).ctimeMs;

/** A synthetic lead transcript: a first line at `startMs`, then one assistant line per tool_use id (name Bash). */
export function leadTranscript(startMs, ids = [], { extra = [] } = {}) {
  const path = join(makeTempDir('call-windows-transcript-'), 'lead.jsonl');
  const first = { type: 'user', timestamp: new Date(startMs).toISOString(), message: { role: 'user', content: 'go' } };
  const uses = ids.map((id) => ({ type: 'assistant', timestamp: new Date(startMs + 1).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] } }));
  writeFileSync(path, [first, ...uses, ...extra].map((line) => `${JSON.stringify(line)}\n`).join(''));
  return path;
}

/** A synthetic agent transcript whose first user message is `brief` and whose first line names `cwd`. */
export function agentTranscript(cwd, brief, ids = []) {
  const path = join(makeTempDir('call-windows-agent-'), 'agent.jsonl');
  const first = { type: 'user', cwd, message: { role: 'user', content: brief } };
  const uses = ids.map((id) => ({ type: 'assistant', cwd, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] } }));
  writeFileSync(path, [first, ...uses].map((line) => `${JSON.stringify(line)}\n`).join(''));
  return path;
}

/** A Stop (lead) or SubagentStop (agent) input; `background_tasks` is sent only when given. */
export const stopEvent = (project, { agent, transcript, tasks, extra = {} } = {}) => ({
  hook_event_name: agent === undefined ? 'Stop' : 'SubagentStop',
  session_id: SESSION,
  cwd: project,
  stop_hook_active: false,
  ...(agent === undefined ? { transcript_path: transcript } : { agent_id: agent, agent_type: 'implementer', agent_transcript_path: transcript }),
  ...(tasks === undefined ? {} : { background_tasks: tasks }),
  ...extra,
});

/** Another, OLDER session's log that claims what happens inside `work()` with one closed Bash window around it (offsets and times). */
export function claimAround(home, { reflog, top, startMs, session = OTHER, path }, work) {
  const before = reflog === undefined ? [] : [sizeOf(reflog)];
  const openAt = Date.now() - 5;
  work();
  const after = reflog === undefined ? [] : [sizeOf(reflog)];
  const closeAt = Date.now() + 5;
  const watches = reflog === undefined ? [] : [edges.watch(0, reflog, before[0], '0'.repeat(40), startMs)];
  const folder = top === undefined ? [] : [edges.folder(top, startMs)];
  const extra = path === undefined ? {} : { tool: 'Write', path };
  writeLog(home, session, [...watches, ...folder, edges.open('o1', openAt, before, extra), edges.close('o1', closeAt, after)]);
}
