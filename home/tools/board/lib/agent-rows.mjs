// The work rows of the status line and `/where` (spec-tui rows 3 and 4, research-tui 5): one row per agent, each with a bar, its
// confidence form, time left and finish clock, and what it does now; plus the folded forms (spark strip, `+K more`) the packing in
// layout.mjs uses when rows run out.
//   ▸ agents · 3 run
//    ├ ● impl-a  implementer  █████▒░░ ~60% · 12 min left · 16:20 · Edit render.mjs · r9-a ↑2 ●3 · 23 calls
// Exports: agentRow(agent, ctx, look), plainHeader(agents, ctx, look), sparkText(agents, look), agentBrief(agent, ctx, look),
// foldRow(prefix, agents, ctx, look), treeMark(last, look), urgencyOf(agent), countsText(agents, look).
// Ctx: { nowMs, timeZone, at (the board's time: left minutes count from it), repo (board.repo), repos (every repository: board.repo
// and board.repos, for an agent's worktree), folded, identity (identity.mjs boardIdentity: the hues of the board's items) }.
// Identity (spec-tui-3): an agent row's name carries its marker in its hue (its lane branch's when it works in one); the name is cut
// at a word or `-`.
// Rules: a percent only with confidence (`62%` high, `~60%` medium), else `est…` with a moving ▒ cell and the type's usual time;
// over the type's 85th percentile: `over usual by 9 min` with ▓; `quiet 4 min` from 3 min without a write and no call waiting;
// a call still waiting shows its minutes. The description is cut at a word (cells.mjs cutWords), and the type stays: a column
// from 115 columns, a part after the bar below. Colour (spec-tui-2): a running bar cyan, done green, quiet and over usual yellow, each
// with its word. Where it works (repository:branch, commits ahead of the base, uncommitted files, or `read-only` / `no repo`) is
// never dropped. Drop order inside a row (fitParts): row id first, then tokens and calls, doing, then type and finish clock;
// name, bar, percent, state word, time left and place are never dropped.
// Invariants: pure (no I/O); every outside text goes through cleanText; every row fits look.columns.
import { barText, clockOf, cleanText, cutWords, durationText, fitParts, hueState, STATE } from './cells.mjs';
import { agentKey, hueOf, markerOf } from './identity.mjs';
import { WIDE_COLUMNS } from './work-row.mjs';

const FULL_COLUMNS = 150;
const BAR_CELLS = 8;
const TYPE_CHARS = 16;
const NAME_CHARS = 16;
const WIDE_NAME_CHARS = 22;
const NARROW_TYPE_CHARS = 12;
const TOKENS_PER_K = 1000;
const PLACE_CHARS = 16;
const WIDE_PLACE_CHARS = 28;
/** The separator repos.mjs unplacedText puts between the folder and the reason. */
const UNPLACED_SEP = ' · ';
/** Fewer characters than this for the folder name and only the reason is shown. */
const MIN_FOLDER_CHARS = 4;
const DOING_CHARS = 24;
const WIDE_DOING_CHARS = 36;
const MARKER_CHARS = 2; // the identity marker and its space before an agent's name
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

/** The bar and its confidence form: `█████▒░░ ~60%`, `▒░░░░░░░ est…`, over usual with ▓; cyan while running, green when done. */
function barPart(agent, ctx, look) {
  if (agent.state === 'done') return { text: `${barText({ done: 1 }, BAR_CELLS, look)} done`, state: STATE.done, join: ' ' };
  const state = agent.state === 'quiet' || agent.overMin > 0 ? STATE.warn : STATE.run;
  if (agent.conf === 'low' && agent.overMin <= 0) {
    const at = Math.floor(ctx.nowMs / SPIN_MS) % BAR_CELLS;
    return { text: `${look.glyph.left.repeat(at)}${look.glyph.now}${look.glyph.left.repeat(BAR_CELLS - at - 1)} ${marks(look).est}`, state, join: ' ' };
  }
  const done = (agent.pct ?? 0) / PERCENT;
  const over = agent.overMin > 0 && agent.elapsedMin > 0 ? Math.min(done, agent.overMin / agent.elapsedMin) : 0;
  const pct = agent.conf === 'high' ? `${agent.pct}%` : agent.conf === 'medium' ? `~${agent.pct}%` : marks(look).est;
  return { text: `${barText({ done, over, now: 1 / BAR_CELLS }, BAR_CELLS, look)} ${pct}`, state, join: ' ' };
}

/** Time left, or over usual, or minutes in with the usual time while estimating, or how long ago it finished. */
function timePart(agent, ctx, look) {
  if (agent.state === 'done') return { text: isNumber(agent.doneMs) ? `${timeText((ctx.nowMs - agent.doneMs) / MS_PER_MIN, look)} ago` : '', state: STATE.dim };
  if (agent.state === 'quiet') return { text: `quiet ${timeText(agent.quietMin ?? 0, look)}`, state: STATE.warn };
  if (isNumber(agent.overMin) && agent.overMin > 0) return { text: wide(look) ? `over usual by ${durationText(agent.overMin)}` : `over ${short(agent.overMin)}`, state: STATE.warn };
  if (agent.conf === 'low' || !isNumber(agent.leftMin)) {
    const usual = Array.isArray(agent.usual) && wide(look) ? ` (usually ${Math.round(agent.usual[0])}${marks(look).dash}${Math.round(agent.usual[1])} min)` : '';
    return { text: `${timeText(isNumber(agent.elapsedMin) ? agent.elapsedMin : 0, look)} in${usual}` };
  }
  return { text: wide(look) ? `${durationText(agent.leftMin)} left` : short(agent.leftMin) };
}

/** The finish clock and, at full width, its 85% end: `16:20` / `16:20–16:41`. */
function clockParts(agent, ctx, look) {
  if (agent.state !== 'run' || agent.overMin > 0 || agent.conf === 'low' || !isNumber(agent.leftMin)) return [];
  const at = ctx.at ?? ctx.nowMs;
  const finish = clockOf(at + agent.leftMin * MS_PER_MIN, ctx.nowMs, ctx.timeZone);
  const parts = [{ text: finish, state: STATE.dim, drop: 1 }];
  if (look.columns >= FULL_COLUMNS && isNumber(agent.highLeftMin) && agent.highLeftMin > agent.leftMin) {
    parts[0] = { text: `${finish}${marks(look).dash}${clockOf(at + agent.highLeftMin * MS_PER_MIN, ctx.nowMs, ctx.timeZone)}`, state: STATE.dim, drop: 1 };
  }
  return parts;
}

/** What the agent does now, cut so it keeps its place; quiet or a long-waiting call in words. */
function doingPart(agent, look) {
  const doing = cutWords(cleanText(agent.doing ?? '', look), wide(look) ? WIDE_DOING_CHARS : DOING_CHARS, look);
  if (agent.state === 'quiet') return { text: doing ? `last: ${doing}` : '', state: STATE.warn, drop: 2 };
  if (agent.pendingMin >= 2) return { text: `${doing} (${agent.pendingMin} min)`, drop: 2 };
  return { text: doing, drop: 2 };
}

/**
 * The `<folder> · <reason>` text of an agent on no sure worktree within `max` characters: the reason always stays and the folder
 * name is cut (review O1: `claude-setup…` alone said nothing); with no room left for a folder, the reason alone.
 */
function unplacedPart(unplaced, max, look) {
  const at = unplaced.lastIndexOf(UNPLACED_SEP);
  if (at < 0) return cutWords(cleanText(unplaced, look), max, look);
  const why = cleanText(unplaced.slice(at + UNPLACED_SEP.length), look);
  const sep = cleanText(UNPLACED_SEP, look); // ` ? ` in the ASCII look
  const room = max - [...why].length - [...sep].length;
  if (room < MIN_FOLDER_CHARS) return cutWords(why, max, look);
  return `${cutWords(cleanText(unplaced.slice(0, at), look), room, look)}${sep}${why}`;
}

/**
 * Where the agent works (owner report 2026-11-21: every agent row says it): `claude-setup:lane/x 2↑ +3 dirty` from its own worktree
 * (repos.mjs, never the lead's folder); for an agent on no sure worktree the repository or folder it was launched in and why
 * (`claude-setup · no edits yet`, repos.mjs placeAgents; review F2), else `read-only` / `no repo`.
 */
function wherePart(agent, ctx, look) {
  const repos = Array.isArray(ctx.repos) ? ctx.repos : [ctx.repo].filter(Boolean);
  if (agent.wt === null || agent.wt === undefined) {
    const text = typeof agent.unplaced === 'string' ? unplacedPart(agent.unplaced, wide(look) ? WIDE_PLACE_CHARS : PLACE_CHARS, look) : '';
    return { text: text || (agent.writer ? 'no repo' : 'read-only'), state: STATE.dim };
  }
  const repo = repos.find((entry) => entry?.name === agent.repo) ?? repos[0];
  const wt = (Array.isArray(repo?.worktrees) ? repo.worktrees : []).find((entry) => entry?.name === agent.wt);
  // Below 115 columns with one repository the git row names it, so the room goes to the branch.
  const repoName = agent.repo && (wide(look) || repos.length > 1) ? `${cleanText(agent.repo, look)}:` : '';
  const place = `${repoName}${cleanText(agent.branch ?? agent.wt, look)}`;
  const ahead = wt?.ahead > 0 ? ` ${wt.ahead}${marks(look).up}` : '';
  const dirty = wt?.changed > 0 ? ` +${wt.changed} dirty` : '';
  // dim, not yellow: uncommitted files are a writer's normal state, not a warning (review N2)
  return { text: `${cutWords(place, wide(look) ? WIDE_PLACE_CHARS : PLACE_CHARS, look)}${ahead}${dirty}`, state: STATE.dim };
}

/**
 * @param {object} agent a board agent (agents.mjs entry with wt, branch)
 * @param {{ nowMs: number, timeZone: string, at?: number, repo?: object, prefix?: string }} ctx the clock and the tree mark
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal
 * @returns {string} the row
 */
export function agentRow(agent, ctx, look) {
  const nameWidth = (wide(look) ? WIDE_NAME_CHARS : NAME_CHARS) - MARKER_CHARS;
  const hue = hueOf(ctx.identity, agentKey(ctx.identity, agent));
  const name = `${markerOf(hue, look)} ${cutWords(cleanText(agent.name, look), nameWidth, look).padEnd(nameWidth)}`;
  const type = cleanText(agent.type ?? '?', look);
  const column = wide(look) ? ` ${cutWords(type, TYPE_CHARS, look).padEnd(TYPE_CHARS)}` : '';
  const prefix = ctx.prefix ?? ' ';
  return fitParts([
    { text: `${prefix}${name}${column}`, spans: [{ text: prefix }, { text: name, state: hueState(hue) }, { text: column }], bold: look.urgent === `agent:${agent.id}` },
    barPart(agent, ctx, look),
    timePart(agent, ctx, look), ...clockParts(agent, ctx, look),
    agent.state === 'done' ? { text: '' } : doingPart(agent, look),
    { text: wide(look) ? '' : cutWords(type, NARROW_TYPE_CHARS, look), state: STATE.dim, drop: 1 }, wherePart(agent, ctx, look),
    ...(agent.tag ? [{ text: agent.tag, state: STATE.warn, drop: 4 }] : []),
    { text: statsText(agent), state: STATE.dim, drop: 4 },
    { text: agent.row && look.columns >= FULL_COLUMNS ? `row ${cleanText(agent.row, look)}` : '', drop: 6 },
  ], look);
}

/** `45k tok · 23 calls`: the agent's context so far and its tool calls; '' when neither is known. */
function statsText(agent) {
  const tokens = isNumber(agent.tokens) && agent.tokens > 0 ? `${Math.max(1, Math.round(agent.tokens / TOKENS_PER_K))}k tok` : '';
  const calls = Number.isInteger(agent.calls) && agent.calls > 0 ? `${agent.calls} calls` : '';
  return [tokens, calls].filter(Boolean).join(' ');
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
  const name = cutWords(cleanText(agent.name, look), 14, look);
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

const quietIn = (agents) => agents.some((agent) => agent.state === 'quiet');

/** @returns {string} the header of the agents: `▸ agents · 3 run`, spark when folded */
export function plainHeader(agents, ctx, look) {
  const title = `${marks(look).head}agents`;
  const counts = ctx.folded ? `${countsText(agents, look)} ${sparkText(agents, look)}` : countsText(agents, look);
  return fitParts([{ text: title }, { text: counts, state: quietIn(agents) ? STATE.warn : STATE.run, drop: 1 }], look);
}
