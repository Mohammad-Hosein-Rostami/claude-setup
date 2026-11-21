// Status line: model tier, effort, CONTEXT SIZE in tokens (what every tool call re-reads), the finish time of the session's
// STATUS.md (cache only), and account usage windows (5h / 7d) with reset times from `rate_limits`. Under it, when there is something
// to show: the job's progress bar (line 2) and one line per live workflow run (lines 3-4), from the same cache and from the session's
// workflow journals (see tools/estimate/lib/progress-line.mjs).
// Writes (spec-p5 `r9-statusline`, last-seen files): this account's limit sample when `rate_limits` changed (CLAUDE_ACCOUNT;
// none without it, so accounts never mix: tools/estimate/lib/limits-store.mjs) and the session's last-seen cost
// (~/.claude/state/last-seen/<session>.json, the API-price equivalent `/where` shows; `$` is no longer on the line, audit case 11).
// With no `five_hour` window the line shows the last value seen for this account with its age, else `5h ?` (audit case 1: the old
// ccusage fallback was dollars from this Mac only). Never blank: any error prints one `status line error: <reason>` line, exit 0
// (an empty output or a non-zero exit blanks the row). It starts no launcher; its only spawn is the estimate cache's claimed refresh.
import { progressLines } from './tools/estimate/lib/progress-line.mjs';
import { estimateSegment } from './tools/estimate/lib/segment-cache.mjs';
import { liveRuns } from './tools/estimate/lib/workflow-runs.mjs';
import { latestSample, readLimits, recordSample } from './tools/estimate/lib/limits-store.mjs';
import { writeSessionFile } from './hooks/lib/session-store.mjs';

// Claude Code sets COLUMNS for the command; without it assume a plain 80-column terminal (an 8-cell bar).
const DEFAULT_COLUMNS = 80;
const terminalColumns = () => {
  const columns = Number.parseInt(process.env.COLUMNS ?? '', 10);
  return columns > 0 ? columns : DEFAULT_COLUMNS;
};

// Tier label by model id/name; an unrecognised model shows "?" rather than guessing sonnet.
function modelTier(text) {
  if (/opus/i.test(text)) return '\x1b[35mOPUS\x1b[0m';
  if (/fable/i.test(text)) return '\x1b[33mFABLE\x1b[0m';
  if (/haiku/i.test(text)) return '\x1b[36mhaiku\x1b[0m';
  if (/sonnet/i.test(text)) return '\x1b[32msonnet\x1b[0m';
  return '\x1b[2m?\x1b[0m';
}
const MAX_ERROR_CHARS = 60;
const MS_PER_MIN = 60_000;
const lastSeenDir = () => `${process.getBuiltinModule('node:os').homedir()}/.claude/state/last-seen`;

/** The session's last-seen cost for `/where` (< 1 KB, temp file and rename through session-store.mjs); a failure is ignored. */
function writeLastSeen(d) {
  const cost = d.cost?.total_cost_usd;
  if (typeof cost !== 'number' || typeof d.session_id !== 'string') return;
  writeSessionFile(lastSeenDir(), d.session_id, JSON.stringify({ session: d.session_id, costUsd: cost, t: Date.now() }));
}

/** `5h 54% left, 12 min ago` from this account's last sample, else `5h ?` (never another source's number). */
function lastSeenFive(account) {
  const sample = latestSample(readLimits(account));
  const used = sample?.five_hour?.used_percentage;
  if (typeof used !== 'number') return '\x1b[2m5h ?\x1b[0m';
  const ago = Math.max(0, Math.round((Date.now() - sample.t) / MS_PER_MIN));
  return `\x1b[2m5h ${Math.max(0, 100 - Math.round(used))}% left, ${ago} min ago\x1b[0m`;
}

/** The status line text for one status input. */
function render(d) {
  const name = d.model?.display_name ?? '?';
  const id = d.model?.id ?? '';
  const tier = modelTier(id + name);
  const effort = d.effort?.level;
  const tokens = d.context_window?.total_input_tokens ?? 0;
  const k = Math.round(tokens / 1000);
  // Cost per tool call scales with this number: green < 60k, yellow < 150k, red above.
  const color = tokens >= 150000 ? '31' : tokens >= 60000 ? '33' : '32';
  const parts = [`${tier} ${name}${effort ? ` (${effort})` : ''}`, `\x1b[${color}mctx ${k}k\x1b[0m`];
  // Finish time of the session's STATUS.md (the one it last touched, else the project's): read from a cache only, refreshed in the background (see segment-cache.mjs).
  const estimate = estimateSegment({ projectDir: d.workspace?.project_dir ?? d.cwd, sessionId: d.session_id });
  if (estimate) parts.push(`\x1b[36m${estimate.text}\x1b[0m`);
  const five = d.rate_limits?.five_hour;
  // Claude Code omits five_hour when the server sends no data for it (claude-code#92081): the last value seen, with its age.
  parts.push(five ? usage('5h', five, false) : lastSeenFive(process.env.CLAUDE_ACCOUNT));
  const week = d.rate_limits?.seven_day;
  if (week) parts.push(usage('7d', week, true));
  if (tokens >= 150000) parts.push('\x1b[31m/clear before the next task\x1b[0m');
  else if (tokens >= 60000) parts.push('\x1b[33mlong ctx: batch calls\x1b[0m');
  const under = progressLines(estimate?.progress ?? null, liveRuns(d.transcript_path, Date.now()), { columns: terminalColumns(), color: !process.env.NO_COLOR });
  return [parts.join(' │ '), ...under].join('\n');
}

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    let d = {};
    try {
      d = JSON.parse(raw);
    } catch {
      // not JSON: render what can be shown without the input
    }
    recordSample(process.env.CLAUDE_ACCOUNT, d.rate_limits);
    writeLastSeen(d);
    console.log(render(d));
  } catch (error) {
    console.log(`status line error: ${String(error?.message ?? error).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, MAX_ERROR_CHARS)}`);
  }
  process.exitCode = 0;
});

// "5h 62% left ↻14:40": percent LEFT (what you asked to see), colored by how little remains.
// The window is absent until the first request in a fresh window reports it.
function usage(label, win, withDay) {
  const used = win?.used_percentage;
  if (typeof used !== 'number') return `\x1b[2m${label} fresh\x1b[0m`;
  const left = Math.max(0, 100 - Math.round(used));
  const color = left <= 10 ? '31' : left <= 30 ? '33' : '32';
  const reset = typeof win.resets_at === 'number' ? ` ↻${fmtReset(win.resets_at, withDay)}` : '';
  return `\x1b[${color}m${label} ${left}% left\x1b[0m${reset}`;
}

function fmtReset(epochSeconds, withDay) {
  const t = new Date(epochSeconds * 1000);
  const hm = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return withDay ? `${t.toLocaleDateString([], { weekday: 'short' })} ${hm}` : hm;
}
