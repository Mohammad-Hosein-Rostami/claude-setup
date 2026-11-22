// Who made a change: this session (own) or only another session (foreign), from the call-window logs (lib/call-windows.mjs).
// A change is foreign only when no call of this session can have made it AND a closed window in another, older session's log claims
// it; anything else is own (spec-p1-gates-fix 2.2 and 2.4, corrections K1', K2', K11').
// Exports: ownsOffset(log, scope, k, offset), ownsInstant(log, scope, ms), claimed(ctx, claim), missingToolUses(ctx),
//   ownBashEntries(ctx, entries), VERDICT_DEADLINE_MS.
//   scope: null at the lead's stop (every window of the session), else the stopping agent's id (only its windows).
//   ctx: {env, session, agent: scope, log: readCallWindows(...), top?, takenMs?, transcriptPath?, deadlineMs, claimBudgetBytes?}.
// Invariants: never throws; an unreadable source, the deadline or the byte budget give own (or "not claimed"), never foreign; a log
//   claims only when its first line is older than this session's first line (a session this one started is always younger: U6 open).
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join, sep } from 'node:path';
import { buildWindows, EDGE_SLACK_MS, logFolderOf, NO_WINDOW_TOOLS, parseLog } from './call-windows.mjs';
import { realPathOf } from './own-edits.mjs';
import { readPlainFile } from './plain-file.mjs';
import { isPrivateFile, lstatOrNull, READ_FLAGS } from './session-store.mjs';

export const VERDICT_DEADLINE_MS = 1500;
const MAX_CLAIM_LOG_BYTES = 16 * 1024 * 1024;
const CROSS_CHECK_TAIL_BYTES = 512 * 1024;
const MAX_AGENT_TRANSCRIPTS = 20;
const MAX_FOLDER_FILES = 200;
const DELETED_OR_MOVED = /[DRC]/;

const inScope = (window, scope) => scope === null || window.agent === scope;

/**
 * Whether a program window of this session in scope covers byte offset `offset` of watched reflog `k`.
 * @returns {boolean} a window not closed before the newest watch of k, with open.b[k] <= offset < close.b[k] (missing sizes widen it)
 */
export function ownsOffset(log, scope, k, offset) {
  const newest = log.watches.filter((watch) => watch.k === k).at(-1);
  const since = newest === undefined ? -Infinity : newest.at;
  return log.windows.some((w) => w.kind === 'program' && inScope(w, scope) && !(w.closeAt < since)
    && (w.openB?.[k] ?? 0) <= offset && offset < (w.closeB?.[k] ?? Infinity));
}

/** Whether a program window of this session in scope covers the instant `ms` (with slack, and the PostToolUse hook time after an edge). */
export function ownsInstant(log, scope, ms) {
  return log.windows.some((w) => w.kind === 'program' && inScope(w, scope) && w.openAt - EDGE_SLACK_MS <= ms
    && ms <= w.closeAt + (w.edge ? Math.max(EDGE_SLACK_MS, log.postHookMs ?? 0) : EDGE_SLACK_MS));
}

/** The other logs, newest first, read within the byte budget and the deadline; only usable ones older than this session's log. */
function otherLogs(ctx) {
  const dir = logFolderOf(ctx.env);
  const names = (lstatOrNull(dir)?.isDirectory() ? readdirSync(dir) : []).filter((name) => name.endsWith('.jsonl') && name !== `${ctx.session}.jsonl`);
  const files = names.map((name) => ({ path: join(dir, name), stats: lstatOrNull(join(dir, name)) }))
    .filter(({ stats }) => stats !== null && isPrivateFile(stats)).sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);
  let budget = ctx.claimBudgetBytes ?? MAX_CLAIM_LOG_BYTES;
  const logs = [];
  for (const { path, stats } of files) {
    if (Date.now() > ctx.deadlineMs || stats.size > budget) break; // past either: what is left claims nothing
    budget -= stats.size;
    const lines = parseLog(readPlainFile(path, stats.size));
    if (lines === null || lines.length === 0 || !(lines[0].at < ctx.log.firstAt)) continue;
    logs.push(buildWindows(lines, { stopHookMs: 0 }));
  }
  return logs;
}

/** The sources that may claim, read once per ctx: other agents of this log (at a subagent's stop), then the older logs. */
function claimSources(ctx) {
  if (ctx.sources !== undefined) return ctx.sources;
  const sameLog = ctx.agent === null ? [] : [{ ...ctx.log, windows: ctx.log.windows.filter((w) => w.agent !== ctx.agent) }];
  try {
    ctx.sources = [...sameLog, ...otherLogs(ctx)];
  } catch {
    ctx.sources = sameLog;
  }
  return ctx.sources;
}

const claimable = (w) => w.edge && !w.bg && w.missed === undefined && w.stopHook === undefined;

function claimsOffset(source, { reflog, offset }) {
  const ks = source.watches.filter((watch) => watch.reflog === reflog).map((watch) => watch.k);
  return source.windows.some((w) => claimable(w) && ks.some((k) => typeof w.openB?.[k] === 'number' && typeof w.closeB?.[k] === 'number'
    && w.openB[k] <= offset && offset < w.closeB[k]));
}

function claimsInstant(source, { ms, path }, top) {
  return source.windows.some((w) => claimable(w) && w.openAt <= ms && ms <= w.closeAt
    && ((w.kind === 'path' && w.path === path) || (w.kind === 'program' && source.folders.some((f) => f.top === top && f.at < w.openAt))));
}

/**
 * Whether another session's record (or, at a subagent's stop, another agent's) claims a change. A reflog line uses only the offset form
 * on the same reflog real path (K10'); a file uses the time form: a path window of the same real path, or a program window of a log
 * that watched this worktree before that window opened (K2').
 * @param {{reflog: string, offset: number} | {ms: number, path: string}} claim
 * @returns {boolean}
 */
export function claimed(ctx, claim) {
  if (!ctx.log?.usable || Date.now() > ctx.deadlineMs) return false;
  const sources = claimSources(ctx);
  return 'offset' in claim ? sources.some((source) => claimsOffset(source, claim)) : sources.some((source) => claimsInstant(source, claim, ctx.top));
}

/** The last `maxBytes` of a plain file as text (a first line cut by the start is dropped); null when unreadable. */
function readTail(path, maxBytes) {
  let fd;
  try {
    fd = openSync(path, READ_FLAGS);
    const stats = fstatSync(fd);
    if (!stats.isFile()) return null;
    const length = Math.min(stats.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const textRead = buffer.toString('utf8', 0, readSync(fd, buffer, 0, length, stats.size - length));
    return length < stats.size ? textRead.slice(textRead.indexOf('\n') + 1) : textRead;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The ids of tool_use blocks of tools that can change files, in `assistant` lines (the 2.1.329 shape); drift finds nothing. */
function toolUseIds(transcript) {
  const ids = [];
  for (const raw of transcript.split('\n')) {
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue; // not a JSON line: drift or a cut line, never evidence
    }
    if (line?.type !== 'assistant' || !Array.isArray(line.message?.content)) continue;
    for (const block of line.message.content) {
      if (block?.type === 'tool_use' && typeof block.id === 'string' && !NO_WINDOW_TOOLS.has(block.name)) ids.push(block.id);
    }
  }
  return ids;
}

/** At the lead's stop: the agent transcripts of the session changed since the log began (K11'); null past the cap or the deadline. */
function agentTranscripts(ctx) {
  const folder = join(ctx.transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  const listed = (dir) => (lstatOrNull(dir)?.isDirectory() ? readdirSync(dir).map((name) => join(dir, name)) : []);
  const recent = listed(folder).filter((path) => /[\\/]agent-[^\\/]*\.jsonl$/.test(path) && (lstatOrNull(path)?.mtimeMs ?? Infinity) >= ctx.log.firstAt);
  return recent.length > MAX_AGENT_TRANSCRIPTS || Date.now() > ctx.deadlineMs ? null : recent;
}

/**
 * The tool_use ids of the stopping context's transcript (and, at the lead's stop, its agents' transcripts) that have no `open` line.
 * @returns {string[] | null} null when a transcript cannot be read or the cap or deadline is passed (the caller then says own)
 */
export function missingToolUses(ctx) {
  try {
    if (typeof ctx.transcriptPath !== 'string') return null;
    const extra = ctx.agent === null ? agentTranscripts(ctx) : [];
    if (extra === null) return null;
    const opened = new Set(ctx.log.lines.filter((line) => line.t === 'open' && line.id !== null).map((line) => line.id));
    const ids = [];
    for (const path of [ctx.transcriptPath, ...extra]) {
      const tail = readTail(path, CROSS_CHECK_TAIL_BYTES);
      if (tail === null) return null;
      ids.push(...toolUseIds(tail));
    }
    return [...new Set(ids)].filter((id) => !opened.has(id));
  } catch {
    return null;
  }
}

/** The files of an untracked folder, or null when it holds anything but folders and plain files or more than MAX_FOLDER_FILES entries. */
function folderFiles(folder) {
  const files = [];
  const pending = [folder];
  let seen = 0;
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const name of readdirSync(dir)) {
      seen += 1;
      if (seen > MAX_FOLDER_FILES) return null;
      const path = join(dir, name);
      const stats = lstatSync(path);
      if (stats.isDirectory()) pending.push(path);
      else if (stats.isFile()) files.push({ path, stats });
      else return null;
    }
  }
  return files;
}

/** (c) and (d) of 2.4 step 2 for one plain file: changed after the baseline, outside every own window, and claimed. */
const foreignFile = (ctx, { path, stats }) => stats.ctimeMs > ctx.takenMs && !ownsInstant(ctx.log, ctx.agent, stats.ctimeMs)
  && claimed(ctx, { ms: stats.ctimeMs, path: realPathOf(path) });

function foreignEntry(ctx, { field, path }) {
  try {
    if (DELETED_OR_MOVED.test(field.slice(0, 2))) return false;
    if (path.endsWith(sep)) {
      const files = folderFiles(path);
      return files !== null && files.length > 0 && files.every((file) => foreignFile(ctx, file));
    }
    const stats = lstatSync(path);
    return stats.isFile() && foreignFile(ctx, { path, stats });
  } catch {
    return false;
  }
}

/**
 * Of the dirty entries a Bash command may have made (changed since the baseline, not recorded), the ones that stay this session's own.
 * An entry is foreign only when (a) the log is usable and the baseline has takenMs, (b) it is no delete, rename or copy and is a plain
 * file (or a small folder of them), (c) its ctime is after the baseline and in no own window, (d) a claim covers it, (e) no tool_use of
 * the transcript lacks its open line.
 * @param {{field: string, path: string}[]} entries
 * @returns {{field: string, path: string}[]} the own ones
 */
export function ownBashEntries(ctx, entries) {
  if (!ctx.log?.usable || typeof ctx.takenMs !== 'number' || entries.length === 0) return entries;
  const foreign = entries.filter((entry) => foreignEntry(ctx, entry));
  if (foreign.length === 0 || Date.now() > ctx.deadlineMs) return entries;
  const missing = missingToolUses(ctx);
  return missing === null || missing.length > 0 ? entries : entries.filter((entry) => !foreign.includes(entry));
}
