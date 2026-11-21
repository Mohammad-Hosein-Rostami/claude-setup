// The git rows of the status line and `/where` (spec-tui row 5, research-tui 4 and 5): per active branch or worktree its name,
// ahead/behind the base branch, changed files, last commit age, an operation in progress and the agents working there.
//   git main ✓ · last 12 min ago │ r9-a ↑2 ●3 impl-a · r9-b ↑1 ●3 impl-b · r9-c ✓ old 3 d ⚠          (one row, when rows are few)
//   git r9-a  lane/r9-a ↑2↓0 ●3 · last commit 12 min ago · impl-a, tests-a                          (one row each, when they fit)
// Exports: gitRows(repo, slots, ctx, look) -> string[]; gitCounts(repo, look) -> string (for the counts row).
// Source: board.repo (git-state.mjs). Rules: a worktree with agents comes first, then by commits ahead; a worktree whose branch is
// landed (0 ahead) and older than OLD_DAYS reads `old N d ⚠` (git-tidy's prune candidate); a status older than STALE_S shows its age.
// The main worktree's part (spec-tui-2, the one compact row when nothing is active, never nothing): its branch, ahead/behind its
// upstream (`origin ↑2↓0`, yellow when behind), changed files, last commit age, and the commits landed on the base today
// (repo-stats.mjs: `landed today 6, last 12 min ago`).
// Invariants: pure (no I/O); every name goes through cleanText; every row fits look.columns.
import { cleanText, cutWords, durationText, fitParts, STATE } from './cells.mjs';
import { WIDE_COLUMNS } from './work-row.mjs';

const MS_PER_S = 1000;
const MS_PER_MIN = 60_000;
const STALE_S = 60;
const MIN_PER_DAY = 24 * 60;
const OLD_DAYS = 2;
const MAX_NAME_CHARS = 24;
const MAX_AGENT_NAMES = 3;
const AGENT_NAME_CHARS = 16;
const GLYPH = { up: '↑', down: '↓', dirty: '●', clean: '✓', old: '⚠' };
const ASCII_GLYPH = { up: '+', down: '-', dirty: '*', clean: 'ok', old: '!' };

const isCount = (value) => Number.isInteger(value) && value >= 0;
const wide = (look) => look.columns >= WIDE_COLUMNS;
const glyphs = (look) => (look.ascii ? ASCII_GLYPH : GLYPH);
const worktreesOf = (repo) => (Array.isArray(repo?.worktrees) ? repo.worktrees.filter((wt) => wt !== null && typeof wt === 'object') : []);

/** Commits ahead/behind the base and the changed files: `↑2↓1 ●3`, `✓` when clean and level. */
function stateText(wt, look) {
  const g = glyphs(look);
  const ab = !wt.main && (wt.ahead > 0 || wt.behind > 0) ? `${g.up}${wt.ahead ?? '?'}${g.down}${wt.behind ?? '?'}` : '';
  const dirty = isCount(wt.changed) ? (wt.changed > 0 ? `${g.dirty}${wt.changed}` : '') : '?';
  return [ab, dirty].filter(Boolean).join(' ') || g.clean;
}

const isOld = (wt) => !wt.main && wt.ahead === 0 && isCount(wt.ageMin) && wt.ageMin > OLD_DAYS * MIN_PER_DAY;
const agentsText = (wt, look) => (Array.isArray(wt.agents) && wt.agents.length > 0
  ? wt.agents.slice(0, MAX_AGENT_NAMES).map((name) => cutWords(cleanText(name, look), AGENT_NAME_CHARS, look)).join(',') + (wt.agents.length > MAX_AGENT_NAMES ? `+${wt.agents.length - MAX_AGENT_NAMES}` : '')
  : '');

/** The worktrees in the order they are shown: with agents first, then most commits ahead, then newest commit. */
function ordered(repo) {
  const rest = worktreesOf(repo).filter((wt) => !wt.main);
  const weight = (wt) => (wt.agents?.length > 0 ? 2 : 0) + (wt.ahead > 0 ? 1 : 0);
  return rest.sort((a, b) => weight(b) - weight(a) || (b.ahead ?? 0) - (a.ahead ?? 0) || (a.ageMin ?? Infinity) - (b.ageMin ?? Infinity));
}

/** A worktree in a few words for the one-row form: `r9-a ↑2 ●3 impl-a`. */
function briefOf(wt, look) {
  const old = isOld(wt) ? ` old ${Math.round(wt.ageMin / MIN_PER_DAY)} d ${glyphs(look).old}` : '';
  const op = wt.op ? ` ${cleanText(wt.op, look)}` : '';
  return [`${cutWords(cleanText(wt.name, look), MAX_NAME_CHARS, look)} ${stateText(wt, look)}${op}${old}`, agentsText(wt, look)].filter(Boolean).join(' ');
}

/** Ahead/behind the upstream: `origin ↑2↓0` (yellow when behind, a pull is due); '' without an upstream. */
function upstreamPart(wt, look) {
  if (!isCount(wt.upAhead) || !isCount(wt.upBehind)) return { text: '' };
  const g = glyphs(look);
  return { text: `origin ${g.up}${wt.upAhead}${g.down}${wt.upBehind}`, state: wt.upBehind > 0 ? STATE.warn : STATE.ok, drop: 7 };
}

/** The commits landed on the base today: `landed today 6, last 12 min ago`; '' when none or unknown. */
function landedPart(repo, nowMs, look) {
  const landed = repo.landed;
  if (!isCount(landed?.count) || landed.count === 0) return { text: '' };
  const last = Number.isFinite(landed.lastMs) && Number.isFinite(nowMs) ? `, last ${durationText(Math.max(0, (nowMs - landed.lastMs) / MS_PER_MIN))} ago` : '';
  return { text: `landed today ${landed.count}${last}`, state: STATE.done, drop: 8 };
}

/** The main worktree's parts: `git main ✓ · origin ↑0↓0 · last 12 min ago · landed today 6`. */
function mainParts(repo, look, nowMs) {
  const main = worktreesOf(repo).find((wt) => wt.main);
  if (main === undefined) return [{ text: `git ${cleanText(repo.base ?? '?', look)}` }];
  // The newest commit of the base is the last one landed: with a landed-today count its age rides on that part, not twice.
  const landedLast = isCount(repo.landed?.count) && repo.landed.count > 0 && Number.isFinite(repo.landed.lastMs);
  const age = isCount(main.ageMin) && !landedLast ? `last ${wide(look) ? 'commit ' : ''}${durationText(main.ageMin)} ago` : '';
  return [
    { text: `git ${cutWords(cleanText(main.name, look), MAX_NAME_CHARS, look)} ${stateText(main, look)}${main.op ? ` ${cleanText(main.op, look)}` : ''}` },
    upstreamPart(main, look), { text: age, state: STATE.dim, drop: 9 }, landedPart(repo, nowMs, look),
  ];
}

/** One row per worktree (the long form). */
function worktreeRow(wt, ctx, look) {
  const stale = Number.isFinite(wt.checkedMs) && wt.checkedMs > 0 && ctx.nowMs - wt.checkedMs > STALE_S * MS_PER_S
    ? { text: `(${Math.round((ctx.nowMs - wt.checkedMs) / MS_PER_S)} s old)`, state: STATE.dim, drop: 3 } : { text: '' };
  return fitParts([
    { text: `git ${cutWords(cleanText(wt.name, look), MAX_NAME_CHARS, look)}` },
    { text: wt.branch && wt.branch !== wt.name ? cleanText(wt.branch, look).slice(0, 32) : '', drop: 4 },
    { text: stateText(wt, look) }, { text: wt.op ? cleanText(wt.op, look) : '', state: STATE.warn },
    { text: isCount(wt.ageMin) ? `last commit ${durationText(wt.ageMin)} ago` : '', state: STATE.dim, drop: 2 },
    { text: agentsText(wt, look), drop: 1 },
    { text: isOld(wt) ? `landed, old ${Math.round(wt.ageMin / MIN_PER_DAY)} d ${glyphs(look).old}` : '', state: STATE.warn, drop: 1 }, stale,
  ], look);
}

/**
 * @param {object | null} repo the board's repo (git-state.mjs)
 * @param {number} slots the rows the git rows may take (Infinity for `/where`)
 * @param {{ nowMs: number }} ctx the clock
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal
 * @returns {string[]} [] without a repo or slots; one row per worktree when they fit, else one summary row
 */
export function gitRows(repo, slots, ctx, look) {
  if (repo === null || typeof repo !== 'object' || slots < 1) return [];
  const others = ordered(repo);
  if (others.length + 1 <= slots && others.length > 0) {
    return [fitParts(mainParts(repo, look, ctx.nowMs), look), ...others.map((wt) => worktreeRow(wt, ctx, look))];
  }
  const parts = others.map((wt, index) => ({ text: briefOf(wt, look), drop: index + 1, bar: index === 0 }));
  if (others.length === 0) parts.push({ text: wide(look) ? 'no worktrees' : 'no wt', drop: 1 });
  return [fitParts([...mainParts(repo, look, ctx.nowMs), ...parts], look)];
}

/** @returns {string} the git summary of the counts row: `git 7 br · 3 not landed · 2 dirty`; '' without a repo */
export function gitCounts(repo, look) {
  if (repo === null || typeof repo !== 'object') return '';
  const dirty = worktreesOf(repo).filter((wt) => wt.changed > 0).length;
  const facts = [
    isCount(repo.branches) ? `${repo.branches} ${wide(look) ? 'branches' : 'br'}` : '',
    isCount(repo.unlanded) && repo.unlanded > 0 ? `${repo.unlanded} not landed` : '',
    dirty > 0 ? `${dirty} dirty` : '',
  ].filter(Boolean);
  return facts.length > 0 ? `git ${facts.join(look.glyph.sep)}` : '';
}
