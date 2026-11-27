// Purpose: read Claude Code transcripts into whole-run numbers for scripts/agent-usage.mjs: per run its turns, context read, cache
//   writes after a gap, tool calls by kind, background tasks left running, sleep commands, its brief and its last text, and the
//   facts the boss rules B1-B7 count: land, tick, snapshot claim, lane release, sync and test commands with what they printed
//   (`ruleCalls`), Agent starts with the plan files their brief names (`starts`), task notices (`notices`), Edit/Write paths.
// Exports: collectRuns(projectDirs, sinceMs, tally) -> { agents: [{ type, run }], boss: [run] }; BIG_CONTEXT_TOKENS,
//   LONG_SLEEP_SECONDS (the thresholds the rule labels name).
// Invariants: reads only. A line that is not JSON is skipped and counted in tally.skippedLines; a file that cannot be read is
//   named on stderr and in tally.unreadable. The boss-rule facts come only from lines stamped at or after sinceMs (a line with
//   no stamp counts), and keep counts, flags and plan file names, never a command's or a report's text. The format is Claude
//   Code's internal one (observed in 2.1.330): one JSON object per line, `message.usage` and `message.content` blocks on
//   assistant lines, tool results and task notices on user lines (a notice that waited in the queue on an attachment line).
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
// Boss rules: commands are matched per segment (split at &&, ||, ; and newlines, so a pipe stays with its command)
const COMMAND_SEPARATOR = /&&|\|\||;|\n/;
const LAND_CALL = /\bnode\s+\S*\bland\.mjs\b/;
const TICK_CALL = /\bboard\.mjs\s+tick\b/;
const SNAPSHOT_CLAIM = /\bgit-tidy(?:\.mjs)?\s+lane\s+claim\b.*--snapshot\b|\bboard\.mjs\s+start\b.*--tess\b/;
const LANE_RELEASE = /\bgit-tidy(?:\.mjs)?\s+lane\s+release\b/;
const SYNC_CALL = /\bnode\s+\S*\bsync-machines\.mjs\b/;
const CHECK_CALL = /\bnode\s+--test\b|\bnpm\s+(?:run\s+)?test\b|\bnpx\s+vitest\b/;
const OUTPUT_CUT = /\|\s*(?:head|tail|grep)\b/;
const LANDED_LINE = /^landed \S+ on \S+ at [0-9a-f]+/gm; // land.mjs's own line; sweep's `landed in` lines do not match
const TICK_LINE = /^tick:/gm;
const LAND_REFUSAL = /^land: /m;
const NOT_SYNCED = /NOT synced/;
const NOTICE = /<task-notification>[\s\S]*?<\/task-notification>/g;
const NOTICE_RESULT = /<result>([\s\S]*?)<\/result>/;
const NOTICE_TOOL_USE = /<tool-use-id>(\w+)<\/tool-use-id>/;
const NOTICE_TASK = /<task-id>(\w+)<\/task-id>/;
const AGENT_ID = /agentId: (\w+)/; // the Agent tool result's own words; the task id of the agent's notice
const VERDICT = /\b(done|partial|blocked)\b/i;
const PLAN_FILE = /[\w-]*pieces[\w-]*\.json/g; // a plan's file name: word characters only, safe to print

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

const wordCount = (text) => text.split(/\s+/).filter(Boolean).length;

/** The boss-rule facts of one Bash command (B1-B4, B6), or null when it has none. */
function commandFacts(command) {
  const segments = command.split(COMMAND_SEPARATOR);
  const steps = [[command.search(LAND_CALL), 'land'], [command.search(TICK_CALL), 'tick']]
    .filter(([at]) => at >= 0).sort((a, b) => a[0] - b[0]).map(([, step]) => step);
  const facts = {
    steps,
    isLandCut: segments.some((segment) => LAND_CALL.test(segment) && OUTPUT_CUT.test(segment.slice(segment.search(LAND_CALL)))),
    snapshotClaims: segments.filter((segment) => SNAPSHOT_CLAIM.test(segment)).length,
    releases: segments.filter((segment) => LANE_RELEASE.test(segment)).length,
    isSync: SYNC_CALL.test(command),
    isCheck: CHECK_CALL.test(command),
    result: null,
  };
  const isCounted = steps.length > 0 || facts.snapshotClaims > 0 || facts.releases > 0 || facts.isSync || facts.isCheck;
  return isCounted ? facts : null;
}

/** An Agent start: its type and effort (M1, M4), and for B5 and B7 the plan files its brief names. */
function noteStart(run, block, isRecent) {
  const input = block.input ?? {};
  const start = {
    type: input.subagent_type ?? 'general-purpose', effort: input.effort, agentId: null, isRecent,
    plans: [...new Set(String(input.prompt ?? '').match(PLAN_FILE) ?? [])],
  };
  run.starts.push(start);
  run.startsById.set(block.id, start);
}

/** One tool call or text block of an assistant line; boss-rule facts only when `isRecent`. */
function noteBlock(run, block, isRecent) {
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
    const facts = isRecent ? commandFacts(String(input.command ?? '')) : null;
    if (facts) {
      run.ruleCalls.push(facts);
      run.callsById.set(block.id, facts);
    }
  }
  if (EDIT_TOOLS.has(block.name)) {
    run.edits += 1;
    if (isRecent) run.editPaths.push(String(input.file_path ?? input.notebook_path ?? ''));
  }
  if (STOP_TOOLS.has(block.name)) {
    run.stops += 1;
    run.endedTasks.add(String(input.task_id ?? input.shell_id ?? ''));
  }
  if (block.name === 'Agent' || block.name === 'Task') noteStart(run, block, isRecent);
  if (BOSS_FILE_TOOLS.has(block.name)) run.fileCalls.push(String(input.file_path ?? input.path ?? ''));
}

/** Background task ids started (from Bash results) and ended (from task notices), read from a user or attachment line. */
function noteTasks(run, entry) {
  const text = JSON.stringify(entry);
  for (const match of text.matchAll(BACKGROUND_STARTED)) run.startedTasks.add(match[1] ?? match[2]);
  for (const match of text.matchAll(TASK_NOTICE)) run.endedTasks.add(match[1]);
}

/** The text of a message's content: the string itself, or its text blocks joined (a tool result's blocks have none). */
function contentText(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((block) => block.text ?? '').join('') : '';
}

/** The tool results of a user line: what a counted Bash call printed (B1, B4), the agent id an Agent call got (B5, B7). */
function noteResults(run, content) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type !== 'tool_result') continue;
    const text = contentText(block.content);
    const call = run.callsById.get(block.tool_use_id);
    if (call) {
      call.result = {
        landed: text.match(LANDED_LINE)?.length ?? 0, ticks: text.match(TICK_LINE)?.length ?? 0,
        isRefused: block.is_error === true || LAND_REFUSAL.test(text), isNotSynced: NOT_SYNCED.test(text),
      };
    }
    const start = run.startsById.get(block.tool_use_id);
    if (start) start.agentId = AGENT_ID.exec(text)?.[1] ?? null;
  }
}

/** The agents' reports in task notices (a background shell's notice has no <result>): ids, word count, first verdict word. */
function noteNotices(run, text) {
  for (const [notice] of text.matchAll(NOTICE)) {
    const result = NOTICE_RESULT.exec(notice)?.[1];
    if (result === undefined) continue;
    run.notices.push({
      toolUseId: NOTICE_TOOL_USE.exec(notice)?.[1] ?? null, taskId: NOTICE_TASK.exec(notice)?.[1] ?? null,
      words: wordCount(result), verdict: VERDICT.exec(result)?.[1].toLowerCase() ?? null,
    });
  }
}

/** Whole-run numbers of one transcript (an agent's or the main session's); boss-rule facts from `sinceMs` on. */
function summariseRun(entries, sinceMs) {
  const run = {
    turns: 0, cold: null, context: 0, bigTurns: 0, gapCacheWrites: 0, lastMs: null, lastMessageId: null, bash: 0, edits: 0,
    backgroundStarts: 0, stops: 0, sleeps: 0, longSleeps: 0, starts: [], fileCalls: [], startedTasks: new Set(),
    endedTasks: new Set(), lastText: '', brief: null, ruleCalls: [], callsById: new Map(), startsById: new Map(), notices: [],
    editPaths: [],
  };
  for (const entry of entries) {
    const isRecent = !(Date.parse(entry.timestamp) < sinceMs); // NaN (no stamp) compares false: counted
    if (entry.type === 'user' || entry.type === 'attachment') noteTasks(run, entry);
    if (entry.type === 'user' && run.brief === null) run.brief = contentText(entry.message?.content);
    if (entry.type === 'user') noteResults(run, entry.message?.content);
    if (isRecent && entry.type === 'user') noteNotices(run, contentText(entry.message?.content));
    if (isRecent && entry.type === 'attachment') noteNotices(run, contentText(entry.attachment?.prompt));
    if (entry.type !== 'assistant' || !entry.message) continue;
    if (entry.message.usage) noteTurn(run, entry);
    for (const block of entry.message.content ?? []) noteBlock(run, block, isRecent);
  }
  run.words = wordCount(run.lastText);
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
      boss.push(summariseRun(readEntries(file, tally).filter((entry) => entry.isSidechain !== true), sinceMs));
    }
    const sessions = readdirSync(projectDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    for (const session of sessions) {
      for (const file of recentTranscripts(join(projectDir, session.name, 'subagents'), sinceMs)) {
        agents.push({ type: agentTypeOf(file), run: summariseRun(readEntries(file, tally), sinceMs) });
      }
    }
  }
  return { agents, boss };
}
