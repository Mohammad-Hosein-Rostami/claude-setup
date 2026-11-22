// The git rows of the status line and `/where` (spec-tui row 5, research-tui 4 and 5): per active branch or worktree its name,
// ahead/behind the base branch, changed files, last commit age, an operation in progress and the agents working there.
//   ⎇ main ✓ · last 12 min ago │ ● r9-a ↑2 ●3 impl-a · ◆ r9-b ↑1 ●3 impl-b · ▲ r9-c ✓ old 3 d ⚠    (one row, when rows are few)
//   ⎇ ● r9-a  lane/r9-a ↑2↓0 ●3 · last commit 12 min ago · impl-a, tests-a                        (one row each, when they fit)
// Exports: gitRows(repo, slots, ctx, look) -> string[]; repoRows(board, slots, ctx, look) -> string[] (every repository of the
// board: the primary one first, then one compact row per other repository, `+K more repos` when they do not fit, and a
// `git: no repository` row when the session's work is in none, so the git info is never simply missing); gitCounts(repo, look);
// gitSummaryPart(repo, look) -> part | null (the status line's git part, RC5/RC8: one summary in counts, no hues):
//   main ✓ ↑44 · 3 lanes open · 1 dirty            main ●2 ↓2 behind · rebase · 30 lanes open     (yellow when behind or mid-operation)
// Source: board.repo (git-state.mjs). Rules: a worktree with agents comes first, then by commits ahead; a worktree whose branch is
// landed (0 ahead) and older than OLD_DAYS reads `old N d ⚠` (git-tidy's prune candidate); a status older than STALE_S shows its age.
// The main worktree's part (spec-tui-2, the one compact row when nothing is active, never nothing): its branch, ahead/behind its
// upstream (`origin ↑2↓0`, yellow when behind), changed files, last commit age, and the commits landed on the base today
// (repo-stats.mjs: `landed today 6, last 12 min ago`).
// Identity (spec-tui-3): a row starts with `⎇` (`git` in ASCII); a lane worktree's `⎇ ● name` (and its branch) is in the hue of its
// branch (identity.mjs, ctx.identity), the colour its agent's row uses; the main worktree's `⎇ main` is bold with no hue.
// Invariants: pure (no I/O); every name goes through cleanText; every row fits look.columns.
import { cleanText, cutWords, durationText, fitParts, hueState, STATE } from './cells.mjs';
import { hueOf, markerOf, worktreeKey } from './identity.mjs';
import { WIDE_COLUMNS } from './work-row.mjs';

const MS_PER_S = 1000;
const MS_PER_MIN = 60_000;
const STALE_S = 60;
const MIN_PER_DAY = 24 * 60;
const OLD_DAYS = 2;
const MAX_NAME_CHARS = 24;
const BRANCH_CHARS = 32;
const MAX_AGENT_NAMES = 3;
const AGENT_NAME_CHARS = 16;
const GLYPH = { up: '↑', down: '↓', dirty: '●', clean: '✓', old: '⚠' };
const ASCII_GLYPH = { up: '+', down: '-', dirty: '*', clean: 'ok', old: '!' };

const isCount = (value) => Number.isInteger(value) && value >= 0;
const wide = (look) => look.columns >= WIDE_COLUMNS;
const glyphs = (look) => (look.ascii ? ASCII_GLYPH : GLYPH);
const gitGlyph = (look) => (look.ascii ? 'git' : '⎇');
/** A lane worktree's hue: its branch's (the name an agent on it takes), else its folder name's. */
const hueOfWorktree = (wt, ctx) => hueOf(ctx?.identity, worktreeKey(wt));
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

/** A worktree in a few words for the one-row form, its marker and name in its hue: `● r9-a ↑2 ●3 impl-a`. */
function briefOf(wt, ctx, look) {
  const hue = hueOfWorktree(wt, ctx);
  const old = isOld(wt) ? ` old ${Math.round(wt.ageMin / MIN_PER_DAY)} d ${glyphs(look).old}` : '';
  const op = wt.op ? ` ${cleanText(wt.op, look)}` : '';
  const name = `${markerOf(hue, look)} ${cutWords(cleanText(wt.name, look), MAX_NAME_CHARS, look)}`;
  const rest = [` ${stateText(wt, look)}${op}${old}`, agentsText(wt, look)].filter(Boolean).join(' ');
  return { text: `${name}${rest}`, spans: [{ text: name, state: hueState(hue) }, { text: rest }] };
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
  const name = typeof repo.name === 'string' && repo.name ? `${cutWords(cleanText(repo.name, look), MAX_NAME_CHARS, look)}:` : '';
  if (main === undefined) return [{ text: `${gitGlyph(look)} ${name}${cleanText(repo.base ?? '?', look)}`, state: STATE.strong }];
  // The newest commit of the base is the last one landed: with a landed-today count its age rides on that part, not twice.
  const landedLast = isCount(repo.landed?.count) && repo.landed.count > 0 && Number.isFinite(repo.landed.lastMs);
  const age = isCount(main.ageMin) && !landedLast ? `last ${wide(look) ? 'commit ' : ''}${durationText(main.ageMin)} ago` : '';
  const head = `${gitGlyph(look)} ${name}${cutWords(cleanText(main.name, look), MAX_NAME_CHARS, look)}`;
  const tail = ` ${stateText(main, look)}${main.op ? ` ${cleanText(main.op, look)}` : ''}`;
  return [
    { text: `${head}${tail}`, spans: [{ text: head, state: STATE.strong }, { text: tail }] },
    { text: repo.stale === true ? 'stale' : '', state: STATE.dim }, // git ran out of time: the last good state (repos.mjs)
    upstreamPart(main, look), { text: age, state: STATE.dim, drop: 9 }, landedPart(repo, nowMs, look),
  ];
}

/** One row per worktree (the long form). */
function worktreeRow(wt, ctx, look) {
  const stale = Number.isFinite(wt.checkedMs) && wt.checkedMs > 0 && ctx.nowMs - wt.checkedMs > STALE_S * MS_PER_S
    ? { text: `(${Math.round((ctx.nowMs - wt.checkedMs) / MS_PER_S)} s old)`, state: STATE.dim, drop: 3 } : { text: '' };
  const hue = hueOfWorktree(wt, ctx);
  return fitParts([
    { text: `${gitGlyph(look)} ${markerOf(hue, look)} ${cutWords(cleanText(wt.name, look), MAX_NAME_CHARS, look)}`, state: hueState(hue) },
    { text: wt.branch && wt.branch !== wt.name ? cutWords(cleanText(wt.branch, look), BRANCH_CHARS, look) : '', state: hueState(hue), drop: 4 },
    { text: stateText(wt, look) }, { ...upstreamPart(wt, look), drop: 3 }, { text: wt.op ? cleanText(wt.op, look) : '', state: STATE.warn },
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
  const parts = others.map((wt, index) => ({ ...briefOf(wt, ctx, look), drop: index + 1, bar: index === 0 }));
  if (others.length === 0) parts.push({ text: wide(look) ? 'no worktrees' : 'no wt', drop: 1 });
  return [fitParts([...mainParts(repo, look, ctx.nowMs), ...parts], look)];
}

/**
 * @param {object | null} board the session's board (repo: the primary repository with its stats; repos: the others)
 * @param {number} slots the rows the git rows may take (Infinity for `/where`); at least one row is returned for a board
 * @param {{ nowMs: number }} ctx the clock
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal
 * @returns {string[]} the primary repository's rows, then a compact row per other repository; [] without a board
 */
export function repoRows(board, slots, ctx, look) {
  if (board === null || typeof board !== 'object') return [];
  const primary = board.repo !== null && typeof board.repo === 'object' ? board.repo : null;
  const others = (Array.isArray(board.repos) ? board.repos : []).filter((repo) => repo !== null && typeof repo === 'object');
  if (primary === null && !(board.at > 0)) return [fitParts([{ text: 'git: loading', state: STATE.dim }], look)]; // first refresh running (N4)
  if (primary === null) return [fitParts([{ text: 'git: no repository', state: STATE.dim }, { text: 'neither the session folder nor the setup repository holds this work', state: STATE.dim, drop: 1 }], look)];
  const room = Math.max(1, slots);
  const fits = others.length <= room - 1;
  const shown = others.slice(0, Math.max(0, room - 1 - (fits ? 0 : 1))); // a `+K more` row needs its own place
  const hidden = others.length - shown.length;
  const rows = gitRows(primary, room - shown.length, ctx, look);
  const extra = shown.map((repo) => gitRows(repo, 1, ctx, look)[0]).filter(Boolean);
  const more = hidden > 0 ? [fitParts([{ text: `+${hidden} more repo${hidden === 1 ? '' : 's'} with work` }], look)] : [];
  return [...rows, ...extra, ...more].slice(0, Number.isFinite(slots) ? room : undefined);
}

/**
 * The status line's git part: the main checkout's branch and state, its commits ahead of and behind its upstream (only when not
 * level), an operation in progress, how many lane worktrees are open and how many of them have uncommitted files; one count
 * whatever the number of worktrees (F5), no identity hue (RC5).
 * @param {object | null} repo the board's primary repo (git-state.mjs)
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal
 * @returns {{ text: string, state: string, drop: number } | null} warn when behind the upstream or mid-operation; null without a repo
 */
export function gitSummaryPart(repo, look) {
  if (repo === null || typeof repo !== 'object') return null;
  const g = glyphs(look);
  const main = worktreesOf(repo).find((wt) => wt.main);
  const lanes = worktreesOf(repo).filter((wt) => !wt.main);
  const dirty = lanes.filter((wt) => wt.changed > 0).length;
  const name = cutWords(cleanText(main?.name ?? repo.base ?? '?', look), MAX_NAME_CHARS, look);
  const behind = isCount(main?.upBehind) && main.upBehind > 0;
  const upstream = [isCount(main?.upAhead) && main.upAhead > 0 ? ` ${g.up}${main.upAhead}` : '', behind ? ` ${g.down}${main.upBehind} behind` : ''].join('');
  const op = main?.op ? `${look.glyph.sep}${cleanText(main.op, look)}` : '';
  const counts = [
    lanes.length > 0 ? `${lanes.length} ${lanes.length === 1 ? 'lane' : 'lanes'}${wide(look) ? ' open' : ''}` : '',
    dirty > 0 ? `${dirty} dirty` : '',
    repo.stale === true ? 'stale' : '',
  ].filter(Boolean).map((text) => `${look.glyph.sep}${text}`).join('');
  const state = main === undefined ? '' : ` ${stateText(main, look)}`;
  return { text: `${name}${state}${upstream}${op}${counts}`, state: behind || op ? STATE.warn : STATE.ok, drop: 0 };
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
