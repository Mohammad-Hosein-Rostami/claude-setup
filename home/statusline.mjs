// Status line: model tier, effort, CONTEXT SIZE in tokens (what every tool call re-reads), cost,
// the finish time of the session's STATUS.md (cache only), and account usage windows (5h / 7d) with reset times
// from `rate_limits`. Under it, when there is something to show: the job's progress bar (line 2) and one line per live workflow
// run (lines 3-4), from the same cache and from the session's workflow journals (see tools/estimate/lib/progress-line.mjs).
import { progressLines } from './tools/estimate/lib/progress-line.mjs';
import { estimateSegment } from './tools/estimate/lib/segment-cache.mjs';
import { liveRuns } from './tools/estimate/lib/workflow-runs.mjs';

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
let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let d = {};
  try {
    d = JSON.parse(raw);
  } catch {}
  const name = d.model?.display_name ?? '?';
  const id = d.model?.id ?? '';
  const tier = modelTier(id + name);
  const effort = d.effort?.level;
  const tokens = d.context_window?.total_input_tokens ?? 0;
  const k = Math.round(tokens / 1000);
  // Cost per tool call scales with this number: green < 60k, yellow < 150k, red above.
  const color = tokens >= 150000 ? '31' : tokens >= 60000 ? '33' : '32';
  const cost = d.cost?.total_cost_usd;
  const parts = [`${tier} ${name}${effort ? ` (${effort})` : ''}`, `\x1b[${color}mctx ${k}k\x1b[0m`];
  if (typeof cost === 'number') parts.push(`$${cost.toFixed(2)}`);
  // Finish time of the session's STATUS.md (the one it last touched, else the project's): read from a cache only, refreshed in the background (see segment-cache.mjs).
  const estimate = estimateSegment({ projectDir: d.workspace?.project_dir ?? d.cwd, sessionId: d.session_id });
  if (estimate) parts.push(`\x1b[36m${estimate.text}\x1b[0m`);
  const five = d.rate_limits?.five_hour;
  // Claude Code omits five_hour when the server sends no data for it (claude-code#92081);
  // then show ccusage's local 5h-block estimate (cost spent, reset time), never a fake percent.
  parts.push(five ? usage('5h', five, false) : localBlock());
  const week = d.rate_limits?.seven_day;
  if (week) parts.push(usage('7d', week, true));
  if (tokens >= 150000) parts.push('\x1b[31m/clear before the next task\x1b[0m');
  else if (tokens >= 60000) parts.push('\x1b[33mlong ctx: batch calls\x1b[0m');
  const under = progressLines(estimate?.progress ?? null, liveRuns(d.transcript_path, Date.now()), { columns: terminalColumns(), color: !process.env.NO_COLOR });
  console.log([parts.join(' │ '), ...under].join('\n'));
});

// ccusage takes ~10 s, too slow for every refresh: read a cached JSON, refresh it detached at most once a minute.
const CCUSAGE_PACKAGE = 'ccusage@20.0.50'; // pinned: `@latest` would run whatever was published last, unreviewed, on every refresh
const BLOCK_CACHE = `${process.getBuiltinModule('node:os').homedir()}/.claude/.ccusage-block.json`;
const BLOCK_TTL_MS = 60_000;
function localBlock() {
  const fs = process.getBuiltinModule('node:fs');
  let cached = null;
  let age = Infinity;
  try {
    age = Date.now() - fs.statSync(BLOCK_CACHE).mtimeMs;
    cached = JSON.parse(fs.readFileSync(BLOCK_CACHE, 'utf8')).blocks?.[0] ?? null;
  } catch {
    // no cache yet (or a half-written one): the refresh below creates it
  }
  if (age > BLOCK_TTL_MS) {
    try {
      refreshBlock(fs);
    } catch {
      // read-only home or spawn failure: keep printing the (stale) cached value, the line must still render
    }
  }
  if (!cached?.endTime) return '\x1b[2m5h …\x1b[0m';
  const reset = fmtReset(Date.parse(cached.endTime) / 1000, false);
  return `\x1b[36m5h blk $${(cached.costUSD ?? 0).toFixed(2)}\x1b[0m ↻${reset} \x1b[2m(est)\x1b[0m`;
}

function refreshBlock(fs) {
  // Claim the refresh (bump mtime, or create an empty cache) so parallel renders don't stampede.
  if (fs.existsSync(BLOCK_CACHE)) fs.utimesSync(BLOCK_CACHE, new Date(), new Date());
  else fs.writeFileSync(BLOCK_CACHE, '{}');
  const { spawn } = process.getBuiltinModule('node:child_process');
  const cmd = `npx -y ${CCUSAGE_PACKAGE} blocks --active --json --offline > "${BLOCK_CACHE}.tmp" 2>/dev/null && mv "${BLOCK_CACHE}.tmp" "${BLOCK_CACHE}"`;
  const child = spawn('sh', ['-c', cmd], { detached: true, stdio: 'ignore' });
  child.on('error', () => {
    // sh missing or not spawnable: ignore, the status line must not crash on a failed background refresh
  });
  child.unref();
}

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
