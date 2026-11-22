// The git rows of the status line (spec R18 "Rows" and "Git facts", owner decisions RC15 and RC18) and of `/where` (spec-tui row 5,
// research-tui 4 and 5). The status line at 100 columns (95 usable), then `/where` (plain text):
//   git     claude-setup  main  ↑2 to push · 1 staged · 3 changed · 1 new · stash 1 · check ok      (the session's repository)
//   lanes   r18-git ↑2 ~3 implementer · r18-est ↑4 ready to land · r17-col ↓5 needs rebase · +2 more  (its other active branches)
//   git     ice-web-app  feat/auth-i18n  ↑1 to push · ↓2 to pull · rebase 3/7 · changes ?          (outside one, or a 2nd one)
//   ⎇ main ✓ · last 12 min ago │ r9-a ↑2 ●3 impl-a · r9-b ↑1 ●3 impl-b · r9-c ✓ old 3 d ⚠    (`/where`, when rows are few)
//   ⎇ r9-a  lane/r9-a ↑2↓0 ●3 · last commit 12 min ago · impl-a, tests-a                  (`/where`, one row each)
// Exports: gitLineRows(board, slots, look, folder) -> string[] (the status line's 1 or 2 git rows); gitRows(repo, slots, ctx, look)
// -> string[]; repoRows(board, slots, ctx, look) -> string[] (every repository of the board for `/where`: the primary one first, then
// one compact row per other repository, `+K more repos`, and `git: no repository` when the work is in none); gitCounts(repo, look).
// Source: board.repo and board.repos (git-state.mjs, repos.mjs: the session folder's repository first, then the used ones).
// Status line: in the session's repository its current branch, then a `lanes` row of its other active branches (git-state.mjs rules
// a to e, at most MAX_LANES_SHOWN, then `+K more`); outside one (no branch is `current`) or with a second repository, one row per
// repository (at most GIT_LINE_ROWS, then `+K more repos in /where`) with its lanes after ` │ `. A branch shows what to push or
// pull, conflicts (red), an operation (`rebase 3/7`, yellow), staged, changed and new files (`changes ?` where git-state.mjs had
// refs only), the stash, the last done-check verdict (`check failed: tests`, red) and its last commit's age. A lane reads `ready to
// land` (ahead, level, clean, no live agent) or `needs rebase` (behind the base, yellow). Too wide: last commit drops first, then
// check ok, then stash; never the branch, conflicts, an operation, to pull, needs rebase or check failed. Below LABEL_FROM_COLUMNS
// the short forms (`↑2 ↓1 +1 ~3 ?1`) and no repository name when only one shows. An old board without `active` draws its worktrees.
// `/where`: a worktree with agents comes first, then by commits ahead; a landed worktree older than OLD_DAYS reads `old N d ⚠`
// (git-tidy's prune candidate); a status older than STALE_S shows its age; the main worktree's part has its upstream (`origin
// ↑2↓0`), changed files, last commit age and the commits landed on the base today (repo-stats.mjs). A row starts with `⎇`.
// Colour (cells.mjs, RC14): branch names `branch`, repository names bold, labels, ages and separators dim, the rest default but
// the reserved states. Invariants: pure (no I/O); every name goes through cleanText; every row fits look.columns.
import { cleanText, cutWords, durationText, fitParts, partsWidth, STATE } from './cells.mjs';
import { labelled, LABEL_FROM_COLUMNS, WIDE_COLUMNS } from './work-row.mjs';

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
  const name = cutWords(cleanText(wt.name, look), MAX_NAME_CHARS, look);
  const rest = [` ${stateText(wt, look)}${op}${old}`, agentsText(wt, look)].filter(Boolean).join(' ');
  return { text: `${name}${rest}` };
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
  return fitParts([
    { text: `${gitGlyph(look)} ${cutWords(cleanText(wt.name, look), MAX_NAME_CHARS, look)}` },
    { text: wt.branch && wt.branch !== wt.name ? cutWords(cleanText(wt.branch, look), BRANCH_CHARS, look) : '', drop: 4 },
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
  const parts = others.map((wt, index) => ({ ...briefOf(wt, look), drop: index + 1, bar: index === 0 }));
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

const MAX_LANES_SHOWN = 4; // spec R18: at most 4 branches per row, then `+K more`
const GIT_LINE_ROWS = 2;
const LANE_NAME_CHARS = 24;
const LINE_AGENT_CHARS = 16;
const isObject = (value) => value !== null && typeof value === 'object';
const arrows = (look) => (look.ascii ? { up: '^', down: 'v', clean: 'ok' } : { up: '↑', down: '↓', clean: '✓' });
const above = (value) => isCount(value) && value > 0;
const opText = (branch, look) => cleanText(`${branch.op}${branch.opStep ? ` ${branch.opStep}` : ''}`, look);

/** A branch as the line draws it, from a worktree (an old board without `active`, or a main checkout whose branch is not active). */
const branchOfWorktree = (wt) => ({ name: wt.branch ?? wt.name, upAhead: wt.upAhead ?? null, upBehind: wt.upBehind ?? null,
  ahead: wt.main ? 0 : wt.ahead ?? null, behind: wt.main ? 0 : wt.behind ?? null, ageMin: wt.ageMin ?? null, agents: wt.agents ?? [],
  staged: wt.staged ?? null, changed: wt.changed ?? null, untracked: wt.untracked ?? null, conflicts: wt.conflicts ?? null, op: wt.op ?? null, opStep: wt.opStep ?? null });

/** The branch a repository's row leads with (the current one, else the main checkout's), its other active branches, how many more. */
function branchesOf(repo) {
  const main = worktreesOf(repo).find((wt) => wt.main);
  const fallback = main ? branchOfWorktree(main) : { name: repo.base ?? '?' };
  if (!Array.isArray(repo.active)) return { head: fallback, lanes: worktreesOf(repo).filter((wt) => !wt.main).map(branchOfWorktree), more: 0, inRepo: true };
  const active = repo.active.filter(isObject);
  const current = active.find((branch) => branch.current === true);
  const head = current ?? active.find((branch) => branch.name === (main?.branch ?? repo.base)) ?? fallback;
  return { head, lanes: active.filter((branch) => branch !== head), more: isCount(repo.activeMore) ? repo.activeMore : 0, inRepo: current !== undefined };
}

/** The files of a branch: `1 staged · 3 changed · 1 new` (short `+1 ~3 ?1`); `changes ?` without counts; '' when none. */
function filesPart(branch, refsOnly, look) {
  if (refsOnly || !isCount(branch.staged) || !isCount(branch.changed)) return { text: 'changes ?', state: STATE.dim };
  const short = look.columns < LABEL_FROM_COLUMNS;
  const counts = [[branch.staged, 'staged', '+'], [branch.changed, 'changed', '~'], [branch.untracked, 'new', '?']].filter(([count]) => above(count));
  return { text: counts.map(([count, word, mark]) => (short ? `${mark}${count}` : `${count} ${word}`)).join(short ? ' ' : look.glyph.sep) };
}

/** The last done-check verdict: `check failed: tests` (red, kept), `check ok` (dropped second); null without one. */
function checkPart(check) {
  if (!isObject(check) || typeof check.verdict !== 'string') return null;
  const failed = Array.isArray(check.failed) ? check.failed.filter((kind) => typeof kind === 'string') : [];
  if (check.verdict === 'block' || failed.length > 0) return { text: `check failed${failed.length > 0 ? `: ${failed.join(', ')}` : ''}`, state: STATE.block };
  if (check.verdict === 'left-open') return { text: 'check left open', state: STATE.warn, drop: 2 };
  return check.verdict === 'ok' || check.verdict === 'reused' ? { text: 'check ok', drop: 2 } : null;
}

/** The state parts of a repository's leading branch, in order: push, pull, conflicts, op, files or clean, stale, stash, age, check. */
function headStateParts(repo, head, look) {
  const short = look.columns < LABEL_FROM_COLUMNS;
  const a = arrows(look);
  const files = filesPart(head, repo.trust === 'refs', look);
  const moving = above(head.upAhead) || above(head.upBehind) || above(head.conflicts) || Boolean(head.op) || files.text !== '';
  const parts = [
    above(head.upAhead) ? { text: `${a.up}${head.upAhead}${short ? '' : ' to push'}` } : null,
    above(head.upBehind) ? { text: `${a.down}${head.upBehind}${short ? '' : ' to pull'}`, state: STATE.warn } : null,
    above(head.conflicts) ? { text: `${head.conflicts} conflict${head.conflicts === 1 ? '' : 's'}`, state: STATE.block } : null,
    head.op ? { text: opText(head, look), state: STATE.warn } : null,
    files.text !== '' ? files : null, moving ? null : { text: `${a.clean} clean` },
    repo.stale === true ? { text: 'stale', state: STATE.dim } : null,
    above(repo.stash) ? { text: `stash ${repo.stash}`, drop: 1 } : null,
    isCount(head.ageMin) ? { text: `last commit ${durationText(head.ageMin)} ago`, state: STATE.dim, drop: 3 } : null, checkPart(repo.check),
  ].filter(Boolean);
  return parts.map((part, index) => (index === 0 ? { ...part, join: '  ' } : part));
}

/** One lane in a few words: its name, ahead/behind, conflicts, op, files, its agents (own row only), `ready to land`. */
function lanePart(lane, base, look, { inline, compact }) {
  const a = arrows(look);
  const spans = [{ text: cutWords(cleanText(lane.name ?? '?', look), LANE_NAME_CHARS, look), state: STATE.branch }];
  const add = (text, state = STATE.ok) => spans.push({ text: ` ${text}`, state });
  const isBase = lane.name === base;
  if (isBase && above(lane.upAhead)) add(`${a.up}${lane.upAhead} to push`);
  if (isBase && above(lane.upBehind)) add(`${a.down}${lane.upBehind} to pull`, STATE.warn);
  if (!isBase && above(lane.ahead)) add(`${a.up}${lane.ahead}`);
  if (!isBase && above(lane.behind)) add(`${a.down}${lane.behind} needs rebase`, STATE.warn);
  if (above(lane.conflicts)) add(`${lane.conflicts} conflicts`, STATE.block);
  if (lane.op) add(opText(lane, look), STATE.warn);
  const files = [[lane.staged, '+'], [lane.changed, '~'], [lane.untracked, '?']].filter(([count]) => above(count)).map(([count, mark]) => `${mark}${count}`);
  if (files.length > 0) add(files.join(' '));
  const agents = Array.isArray(lane.agents) ? lane.agents.filter((name) => typeof name === 'string') : [];
  // an agent's name is `<type>:<model>` or its description: the part before `:` says who works there
  if (!inline && agents.length > 0) add(agents.map((name) => cutWords(cleanText(name.split(':')[0], look), LINE_AGENT_CHARS, look)).join(','));
  const clean = [lane.staged, lane.changed, lane.conflicts].every((count) => count === 0) && !(lane.untracked > 0) && !lane.op;
  if (!isBase && above(lane.ahead) && lane.behind === 0 && clean && agents.length === 0) add(compact ? 'ready' : 'ready to land');
  return { text: spans.map((span) => span.text).join(''), spans };
}

/** The parts with as many lanes as fit (at most MAX_LANES_SHOWN), the rest counted in `+K more`; lanes outrank the droppable parts. */
function withLanes(parts, branches, base, look, options) {
  const fixedWidth = (list) => partsWidth(list.filter((part) => !part.drop), look);
  for (let shown = Math.min(MAX_LANES_SHOWN, branches.lanes.length); shown >= 0; shown -= 1) {
    const hidden = branches.lanes.length - shown + branches.more;
    const lanes = branches.lanes.slice(0, shown).map((lane) => lanePart(lane, base, look, options));
    const tail = [...lanes, ...(hidden > 0 ? [{ text: `+${hidden} more`, state: STATE.dim }] : [])]
      .map((part, index) => (index === 0 && options.inline ? { ...part, bar: true } : part));
    const all = parts.length === 0 && tail.length > 0 ? [labelled('lanes', tail[0], look), ...tail.slice(1)] : [...parts, ...tail];
    if (shown === 0 || fixedWidth(all) <= look.columns) return all;
  }
  return parts;
}

/** A repository's row: label, name (bold, unless alone on a narrow row), branch, its state, its lanes after ` │ ` when inline. */
function repoLineRow(repo, look, { showName, inline, compact = false, moreRepos = 0, lanesLeft = false }) {
  const branches = branchesOf(repo);
  const branch = { text: cutWords(cleanText(branches.head.name ?? '?', look), LANE_NAME_CHARS, look), state: STATE.branch };
  const name = { text: cutWords(cleanText(repo.name ?? '?', look), LANE_NAME_CHARS, look), state: STATE.strong };
  const head = showName ? [labelled('git', name, look), { ...branch, join: '  ' }] : [labelled('git', branch, look)];
  let parts = [...head, ...headStateParts(repo, branches.head, look)];
  if (inline) parts = withLanes(parts, branches, repo.base, look, { inline, compact });
  const lanesCount = branches.lanes.length + branches.more;
  if (lanesLeft && lanesCount > 0) parts.push({ text: `${lanesCount} lane${lanesCount === 1 ? '' : 's'} in /where`, state: STATE.dim, drop: 4 });
  if (moreRepos > 0) parts.push({ text: `+${moreRepos} more repo${moreRepos === 1 ? '' : 's'} in /where`, state: STATE.dim });
  return fitParts(parts, look);
}

/**
 * The status line's git rows (spec R18): the session's repository and its lanes row, else one row per used repository.
 * @param {object | null} board the session's board (repo: the session folder's repository, else the first used one; repos: the others)
 * @param {number} slots the rows git may take (1 or 2)
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal
 * @param {string | null} [folder] the session folder as shown (`~`), named when no repository was used yet
 * @returns {string[]} 1 to `slots` rows (never none: `loading` before the board's first refresh); [] when slots is below 1
 */
export function gitLineRows(board, slots, look, folder = null) {
  if (slots < 1) return [];
  const dimRow = (text) => fitParts([labelled('git', { text, state: STATE.dim }, look)], look);
  if (!isObject(board) || (!(board.at > 0) && !isObject(board.repo))) return [dimRow('loading')];
  const repos = [board.repo, ...(Array.isArray(board.repos) ? board.repos : [])].filter(isObject);
  if (repos.length === 0) return [dimRow(`no repository used in this session yet${folder ? ` (${folder} is not one)` : ''}`)];
  const narrow = look.columns < LABEL_FROM_COLUMNS;
  const first = branchesOf(repos[0]);
  if (first.inRepo && repos.length === 1) {
    const hasLanes = first.lanes.length > 0 || first.more > 0;
    const row = repoLineRow(repos[0], look, { showName: !narrow, inline: false, lanesLeft: hasLanes && slots < 2 });
    if (!hasLanes || slots < 2) return [row];
    return [row, fitParts(withLanes([], first, repos[0].base, look, { inline: false, compact: false }), look)];
  }
  const shown = repos.slice(0, Math.min(slots, GIT_LINE_ROWS));
  return shown.map((repo, index) => repoLineRow(repo, look, {
    showName: !(narrow && shown.length === 1), inline: true, compact: shown.length > 1, moreRepos: index === shown.length - 1 ? repos.length - shown.length : 0,
  }));
}
