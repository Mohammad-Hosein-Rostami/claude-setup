// Purpose: read Claude Code transcripts into whole-run numbers for scripts/agent-usage.mjs: per run its turns, context read, cache
//   writes after a gap, tool calls by kind, background tasks left running, sleep commands, its brief and its last text.
// Exports: collectRuns(projectDirs, sinceMs, tally) -> { agents: [{ type, run }], boss: [run] }; BIG_CONTEXT_TOKENS,
//   LONG_SLEEP_SECONDS (the thresholds the rule labels name).
// Invariants: reads only. A line that is not JSON is skipped and counted in tally.skippedLines; a file that cannot be read is
//   named on stderr and in tally.unreadable. The format is Claude Code's internal one (observed in 2.1.330): one JSON object per
//   line, `message.usage` and `message.content` blocks on assistant lines, tool results and task notices on user lines.
// Not the board's readers (home/tools/board/lib/agent-transcript.mjs, agents.mjs): they read from a stored cursor with a byte cap
//   per call and keep only what the status board shows; this needs every line of whole runs.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CACHE_GAP_MS = 5 * 60 * 1000; // the subagent prompt cache lives 5 minutes (M10)
export const BIG_CONTEXT_TOKENS = 200_000; // M9: a dev turn above this
export const LONG_SLEEP_SECONDS = 5; // M7
const BOSS_FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'Grep', 'Glob']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const STOP_TOOLS = new Set(['TaskStop', 'KillShell']);
const SLEEP_COMMAND = /\bsleep\s+(\d+(?:\.\d+)?)/g;
const BACKGROUND_STARTED = /in background with ID: (\w+)|moved to the background \(ID: (\w+)\)/g; // a Bash result's own words
const TASK_NOTICE = /<task-id>(\w+)<\/task-id>/g; // the notice Claude Code sends when a background task ends

/** Every assistant usage block once: a turn is split over several lines that repeat the same message id and usage. */
function noteTurn(run, entry) {
  const { usage, id } = entry.message;
  if (id && id === run.lastMessageId) return;
  run.lastMessageId = id;
  const context = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const atMs = Date.parse(entry.timestamp);
  run.turns += 1;
  run.context += context;
  run.cold ??= context;
  if (context > BIG_CONTEXT_TOKENS) run.bigTurns += 1;
  if (run.lastMs !== null && atMs - run.lastMs > CACHE_GAP_MS) run.gapCacheWrites += usage.cache_creation_input_tokens ?? 0;
  run.lastMs = atMs;
}

/** One tool call or text block of an assistant line. */
function noteBlock(run, block) {
  if (block.type === 'text') run.lastText = block.text ?? '';
  if (block.type !== 'tool_use') return;
  const input = block.input ?? {};
  if (block.name === 'Bash') {
    run.bash += 1;
    if (input.run_in_background === true) run.backgroundStarts += 1;
    for (const [, seconds] of String(input.command ?? '').matchAll(SLEEP_COMMAND)) {
      run.sleeps += 1;
      if (Number(seconds) >= LONG_SLEEP_SECONDS) run.longSleeps += 1;
    }
  }
  if (EDIT_TOOLS.has(block.name)) run.edits += 1;
  if (STOP_TOOLS.has(block.name)) {
    run.stops += 1;
    run.endedTasks.add(String(input.task_id ?? input.shell_id ?? ''));
  }
  if (block.name === 'Agent' || block.name === 'Task') {
    run.starts.push({ type: input.subagent_type ?? 'general-purpose', effort: input.effort });
  }
  if (BOSS_FILE_TOOLS.has(block.name)) run.fileCalls.push(String(input.file_path ?? input.path ?? ''));
}

/** Background task ids started (from Bash results) and ended (from task notices), read from a user or attachment line. */
function noteTasks(run, entry) {
  const text = JSON.stringify(entry);
  for (const match of text.matchAll(BACKGROUND_STARTED)) run.startedTasks.add(match[1] ?? match[2]);
  for (const match of text.matchAll(TASK_NOTICE)) run.endedTasks.add(match[1]);
}

/** The first user text of a run: its brief. */
function briefOf(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((block) => block.text ?? '').join('') : '';
}

/** Whole-run numbers of one transcript (an agent's or the main session's). */
function summariseRun(entries) {
  const run = {
    turns: 0, cold: null, context: 0, bigTurns: 0, gapCacheWrites: 0, lastMs: null, lastMessageId: null, bash: 0, edits: 0,
    backgroundStarts: 0, stops: 0, sleeps: 0, longSleeps: 0, starts: [], fileCalls: [], startedTasks: new Set(),
    endedTasks: new Set(), lastText: '', brief: null,
  };
  for (const entry of entries) {
    if (entry.type === 'user' || entry.type === 'attachment') noteTasks(run, entry);
    if (entry.type === 'user' && run.brief === null) run.brief = briefOf(entry.message?.content);
    if (entry.type !== 'assistant' || !entry.message) continue;
    if (entry.message.usage) noteTurn(run, entry);
    for (const block of entry.message.content ?? []) noteBlock(run, block);
  }
  run.words = run.lastText.split(/\s+/).filter(Boolean).length;
  run.tasksLeftRunning = [...run.startedTasks].filter((id) => !run.endedTasks.has(id)).length;
  return run;
}

/** The parsed lines of one transcript; bad lines and unreadable files are counted in `tally`, never dropped silently. */
function readEntries(file, tally) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    tally.unreadable.push(file);
    process.stderr.write(`agent-usage: cannot read ${file}: ${error.code ?? error.message}\n`);
    return [];
  }
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      tally.skippedLines += 1; // a torn or partly written line: counted and reported
    }
  }
  return entries;
}

/** The agent type a subagent transcript's .meta.json names, else `(no meta)`. */
function agentTypeOf(transcript) {
  try {
    return JSON.parse(readFileSync(transcript.replace(/\.jsonl$/, '.meta.json'), 'utf8')).agentType ?? '(no meta)';
  } catch {
    return '(no meta)'; // a run started before meta files existed, or one being written: still counted, under this name
  }
}

/** The .jsonl files directly in `dir` last written at or after `sinceMs`; a missing `dir` has none. */
function recentTranscripts(dir, sinceMs) {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return []; // a session that started no agent has no subagents/
  return readdirSync(dir).filter((name) => name.endsWith('.jsonl')).map((name) => join(dir, name))
    .filter((file) => statSync(file, { throwIfNoEntry: false })?.mtimeMs >= sinceMs);
}

/** Every run since `sinceMs`: { agents: [{type, run}], boss: [run] }. */
export function collectRuns(projectDirs, sinceMs, tally) {
  const agents = [];
  const boss = [];
  for (const projectDir of projectDirs) {
    for (const file of recentTranscripts(projectDir, sinceMs)) {
      // isSidechain lines in a main transcript are an older format's subagent turns, not the boss's own
      boss.push(summariseRun(readEntries(file, tally).filter((entry) => entry.isSidechain !== true)));
    }
    const sessions = readdirSync(projectDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    for (const session of sessions) {
      for (const file of recentTranscripts(join(projectDir, session.name, 'subagents'), sinceMs)) {
        agents.push({ type: agentTypeOf(file), run: summariseRun(readEntries(file, tally)) });
      }
    }
  }
  return { agents, boss };
}
