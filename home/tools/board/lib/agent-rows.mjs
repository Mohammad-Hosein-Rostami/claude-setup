// The work rows of the status line and `/where` (spec-tui rows 3 and 4, research-tui 5): one header per workflow run and one row
// per agent, each with a bar, its confidence form, time left and finish clock, and what it does now; plus the folded forms (spark
// strip, `+K more`) the packing in layout.mjs uses when rows run out.
//   ▸ build r9-tui · for R2 terminal UI · phase 2/4 Build · ███████░░░ 3/4 · 3 run · ~40 min left · 16:35
//    ├ impl-a  implementer  █████▒░░ ~60% · 12 min left · 16:20 · Edit render.mjs · r9-a ↑2 ●3 · 23 calls
// Exports: agentRow(agent, ctx, look), runHeader(run, agents, ctx, look), plainHeader(agents, ctx, look), sparkText(agents, look),
// agentBrief(agent, ctx, look), foldRow(prefix, agents, ctx, look), treeMark(last, look), urgencyOf(agent), countsText(agents, look).
// Ctx: { nowMs, timeZone, at (the board's time: left minutes count from it), repo (board.repo, for an agent's worktree), folded }.
// Rules: a percent only with confidence (`62%` high, `~60%` medium), else `est…` with a moving ▒ cell and the type's usual time;
// over the type's 85th percentile: `over usual by 9 min` with ▓; `quiet 4 min` from 3 min without a write and no call waiting;
// a call still waiting shows its minutes. Drop order inside a row (fitParts): calls, row id and range first, then type, branch,
// doing, finish clock; name, bar, percent and time left are never dropped.
// Invariants: pure (no I/O); every outside text goes through cleanText; every row fits look.columns.
import { barText, clockOf, cleanText, durationText, fitParts, STATE } from './cells.mjs';
import { WIDE_COLUMNS } from './work-row.mjs';

const FULL_COLUMNS = 150;
const BAR_CELLS = 8;
const TYPE_CHARS = 16;
const DOING_CHARS = 24;
const WIDE_DOING_CHARS = 36;
const RUN_BAR_CELLS = 10;
const NARROW_RUN_CELLS = 6;
const MS_PER_MIN = 60_000;
const MIN_PER_HOUR = 60;
const SPIN_MS = 5000; // the estimating cell moves one place per refresh
const PERCENT = 100;
const SPARK = '▁▂▃▄▅▆▇█';
const ASCII_SPARK = '0123456789';
const TREE = { mid: ' ├ ', last: ' └ ', head: '▸ ', up: '↑', down: '↓', dirty: '●', est: 'est…', dot: '·', dash: '–' };
const ASCII_TREE = { mid: ' |- ', last: ' `- ', head: '> ', up: '+', down: '-', dirty: '*', est: 'est...', dot: '.', dash: '-' };
const URGENCY = { quiet: 80, over: 60, writer: 40, reader: 20 };

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const wide = (look) => look.columns >= WIDE_COLUMNS;
const marks = (look) => (look.ascii ? ASCII_TREE : TREE);
/** `12m`, `2h05`: the narrow form of a duration. */
const short = (minutes) => {
  const min = Math.max(0, Math.round(minutes));
  return min < MIN_PER_HOUR ? `${min}m` : `${Math.floor(min / MIN_PER_HOUR)}h${String(min % MIN_PER_HOUR).padStart(2, '0')}`;
};
const timeText = (minutes, look) => (wide(look) ? durationText(minutes) : short(minutes));

/** @returns {string} the tree mark before an agent row: ` ├ `, or ` └ ` for the last one of its group */
export const treeMark = (last, look) => (last ? marks(look).last : marks(look).mid);

/** @returns {number} how much an agent needs a look: quiet > over its usual time > writer > reader; ties by soonest finish */
export function urgencyOf(agent) {
  if (agent.state === 'quiet') return URGENCY.quiet;
  if (agent.overMin > 0) return URGENCY.over;
  return agent.writer ? URGENCY.writer : URGENCY.reader;
}

/** The bar and its confidence form: `█████▒░░ ~60%`, `▒░░░░░░░ est…`, over usual with ▓. */
function barPart(agent, ctx, look) {
  if (agent.state === 'done') return `${barText({ done: 1 }, BAR_CELLS, look)} done`;
  if (agent.conf === 'low' && agent.overMin <= 0) {
    const at = Math.floor(ctx.nowMs / SPIN_MS) % BAR_CELLS;
    return `${look.glyph.left.repeat(at)}${look.glyph.now}${look.glyph.left.repeat(BAR_CELLS - at - 1)} ${marks(look).est}`;
  }
  const done = (agent.pct ?? 0) / PERCENT;
  const over = agent.overMin > 0 && agent.elapsedMin > 0 ? Math.min(done, agent.overMin / agent.elapsedMin) : 0;
  const pct = agent.conf === 'high' ? `${agent.pct}%` : agent.conf === 'medium' ? `~${agent.pct}%` : marks(look).est;
  return `${barText({ done, over, now: 1 / BAR_CELLS }, BAR_CELLS, look)} ${pct}`;
}

/** Time left, or over usual, or minutes in with the usual time while estimating, or how long ago it finished. */
function timePart(agent, ctx, look) {
  if (agent.state === 'done') return { text: isNumber(agent.doneMs) ? `${timeText((ctx.nowMs - agent.doneMs) / MS_PER_MIN, look)} ago` : '' };
  if (agent.state === 'quiet') return { text: `quiet ${timeText(agent.quietMin ?? 0, look)}`, state: STATE.warn };
  if (agent.overMin > 0) return { text: wide(look) ? `over usual by ${durationText(agent.overMin)}` : `over ${short(agent.overMin)}`, state: STATE.warn };
  if (agent.conf === 'low' || agent.leftMin === null) {
    const usual = Array.isArray(agent.usual) && wide(look) ? ` (usually ${Math.round(agent.usual[0])}${marks(look).dash}${Math.round(agent.usual[1])} min)` : '';
    return { text: `${timeText(agent.elapsedMin ?? 0, look)} in${usual}` };
  }
  return { text: wide(look) ? `${durationText(agent.leftMin)} left` : short(agent.leftMin) };
}

/** The finish clock and, at full width, its 85% end: `16:20` / `16:20–16:41`. */
function clockParts(agent, ctx, look) {
  if (agent.state !== 'run' || agent.overMin > 0 || agent.conf === 'low' || !isNumber(agent.leftMin)) return [];
  const at = ctx.at ?? ctx.nowMs;
  const finish = clockOf(at + agent.leftMin * MS_PER_MIN, ctx.nowMs, ctx.timeZone);
  const parts = [{ text: finish, drop: 1 }];
  if (look.columns >= FULL_COLUMNS && isNumber(agent.highLeftMin) && agent.highLeftMin > agent.leftMin) {
    parts[0] = { text: `${finish}${marks(look).dash}${clockOf(at + agent.highLeftMin * MS_PER_MIN, ctx.nowMs, ctx.timeZone)}`, drop: 1 };
  }
  return parts;
}

/** What the agent does now, cut so it keeps its place; quiet or a long-waiting call in words. */
function doingPart(agent, look) {
  const max = wide(look) ? WIDE_DOING_CHARS : DOING_CHARS;
  const full = cleanText(agent.doing ?? '', look);
  const doing = [...full].length > max ? `${[...full].slice(0, max - 1).join('')}${look.glyph.cut}` : full;
  if (agent.state === 'quiet') return { text: doing ? `last: ${doing}` : '', state: STATE.warn, drop: 2 };
  if (agent.pendingMin >= 2) return { text: `${doing} (${agent.pendingMin} min)`, drop: 2 };
  return { text: doing, drop: 2 };
}

/** The agent's worktree with its ahead count and changed files: `r9-a ↑2 ●3`. */
function branchPart(agent, ctx, look) {
  if (agent.wt === null || agent.wt === undefined) return { text: '' };
  const wt = (ctx.repo?.worktrees ?? []).find((entry) => entry.name === agent.wt);
  const ahead = wt?.ahead > 0 ? ` ${marks(look).up}${wt.ahead}` : '';
  const dirty = wt?.changed > 0 ? ` ${marks(look).dirty}${wt.changed}` : '';
  return { text: `${cleanText(agent.wt, look).slice(0, 24)}${ahead}${dirty}`, drop: 3 };
}

/**
 * @param {object} agent a board agent (agents.mjs entry with wt, branch)
 * @param {{ nowMs: number, timeZone: string, at?: number, repo?: object, prefix?: string }} ctx the clock and the tree mark
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal
 * @returns {string} the row
 */
export function agentRow(agent, ctx, look) {
  const nameWidth = wide(look) ? 14 : 10;
  const name = cleanText(agent.name, look).slice(0, nameWidth).padEnd(nameWidth);
  const type = wide(look) ? `${cleanText(agent.type, look).slice(0, TYPE_CHARS).padEnd(TYPE_CHARS)} ` : '';
  return fitParts([
    { text: `${ctx.prefix ?? ' '}${name} ${type}${barPart(agent, ctx, look)}` }, timePart(agent, ctx, look), ...clockParts(agent, ctx, look),
    agent.state === 'done' ? { text: '' } : doingPart(agent, look), branchPart(agent, ctx, look),
    ...(agent.tag ? [{ text: agent.tag, state: STATE.warn, drop: 4 }] : []),
    { text: wide(look) && agent.calls > 0 ? `${agent.calls} calls` : '', drop: 5 },
    { text: agent.row && look.columns >= FULL_COLUMNS ? `row ${cleanText(agent.row, look)}` : '', drop: 6 },
  ], look);
}

/** @returns {string} one cell per agent, its height the progress (`▁▂▃▄▅▆▇█`), `·` while estimating */
export function sparkText(agents, look) {
  const cells = look.ascii ? ASCII_SPARK : SPARK;
  return agents.map((agent) => {
    if (agent.state === 'done') return cells.at(-1);
    if (agent.conf === 'low' && agent.overMin <= 0) return marks(look).dot;
    return cells[Math.min(cells.length - 1, Math.floor(((agent.pct ?? 0) / PERCENT) * cells.length))];
  }).join('');
}

/** @returns {string} an agent in a few words for a folded row: `impl-a ~70% 16:03`, `scout est…` */
export function agentBrief(agent, ctx, look) {
  const name = cleanText(agent.name, look).slice(0, 12);
  if (agent.state === 'quiet') return `${name} quiet ${agent.quietMin}m`;
  if (agent.overMin > 0) return `${name} over ${short(agent.overMin)}`;
  if (agent.conf === 'low') return `${name} ${marks(look).est}`;
  const pct = agent.conf === 'high' ? `${agent.pct}%` : `~${agent.pct}%`;
  const clock = isNumber(agent.leftMin) ? ` ${clockOf((ctx.at ?? ctx.nowMs) + agent.leftMin * MS_PER_MIN, ctx.nowMs, ctx.timeZone)}` : '';
  return `${name} ${pct}${clock}`;
}

/** @returns {string} the counts of a set of agents: `3 run · 1 quiet` */
export function countsText(agents, look) {
  const quiet = agents.filter((agent) => agent.state === 'quiet').length;
  const running = agents.filter((agent) => agent.state === 'run').length;
  return [`${running} run`, quiet > 0 ? `${quiet} quiet` : ''].filter(Boolean).join(look.glyph.sep);
}

/** @returns {string} `+3 more: impl-a ~70% 16:03 · tests-a ~40% 16:09`, fitted; the agents not given a row of their own */
export function foldRow(prefix, agents, ctx, look) {
  const [first, ...rest] = agents.map((agent) => agentBrief(agent, ctx, look));
  return fitParts([{ text: `${prefix}+${agents.length} more: ${first ?? ''}` }, ...rest.map((text, index) => ({ text, drop: index + 1 }))], look);
}

/** The run's share done: its finished agents plus the progress of the running ones, over all its agents. */
function runShare(done, total, agents) {
  if (total <= 0) return 0;
  const running = agents.filter((agent) => agent.state !== 'done').reduce((sum, agent) => sum + (agent.pct ?? 0) / PERCENT, 0);
  return Math.min(1, (done + running) / total);
}

/**
 * @param {object} run a board run (refresh.mjs, with the summary of agents.mjs)
 * @param {object[]} agents its running agents
 * @param {{ nowMs: number, timeZone: string, at?: number, folded?: boolean }} ctx folded adds the spark strip of its agents
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal
 * @returns {string} the header row
 */
export function runHeader(run, agents, ctx, look) {
  const name = `${marks(look).head}${cleanText(run.name ?? run.runId ?? '?', look).slice(0, 16)}`;
  const purpose = run.purpose ? cleanText(run.purpose, look) : run.row ? cleanText(run.row, look) : '';
  const total = Number.isInteger(run.agentsTotal) ? run.agentsTotal : (run.started ?? 0);
  const done = Number.isInteger(run.agentsDone) ? run.agentsDone : (run.done ?? 0);
  const phase = typeof run.phase === 'string' ? cleanText(run.phase, look).slice(0, 16) : '';
  const phaseText = phase ? (wide(look) ? `phase ${run.phaseIndex || '?'}/${run.phaseTotal ?? '?'} ${phase}` : `${phase} ${run.phaseIndex || '?'}/${run.phaseTotal ?? '?'}`) : '';
  const stopped = run.state !== 'run' ? { text: `${cleanText(run.state, look)} ${run.quietMin} min`, state: STATE.warn } : null;
  const left = isNumber(run.leftMin) ? `~${timeText(run.leftMin, look)}${wide(look) ? ' left' : ''}` : '';
  const finish = isNumber(run.leftMin) ? clockOf((ctx.at ?? ctx.nowMs) + run.leftMin * MS_PER_MIN, ctx.nowMs, ctx.timeZone) : '';
  return fitParts([
    { text: name }, { text: purpose ? `${wide(look) ? 'for ' : ''}${purpose.slice(0, 32)}` : '', drop: 3 }, { text: phaseText, drop: 1 },
    { text: `${barText({ done: runShare(done, total, agents) }, wide(look) ? RUN_BAR_CELLS : NARROW_RUN_CELLS, look)} ${done}/${total} done` },
    { text: ctx.folded && agents.length > 0 ? `${countsText(agents, look)} ${sparkText(agents, look)}` : countsText(agents, look), drop: 2 },
    stopped ?? { text: left }, { text: stopped ? '' : finish, drop: 1 },
  ], look);
}

/** @returns {string} the header of the agents outside workflows: `▸ agents (not in a workflow) · 3 run`, spark when folded */
export function plainHeader(agents, ctx, look) {
  const title = `${marks(look).head}${wide(look) ? 'agents (not in a workflow)' : 'agents'}`;
  return fitParts([{ text: title }, { text: ctx.folded ? `${countsText(agents, look)} ${sparkText(agents, look)}` : countsText(agents, look), drop: 1 }], look);
}
