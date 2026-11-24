// The git rows of the status line (spec R18 "Rows" and "Git facts", owner decisions RC15 and RC18; at 100 columns):
//   git     claude-setup  main  ↑2 to push · 1 staged · 3 changed · 1 new · stash 1              (the session's repository)
//   lanes   r18-git ↑2 ~3 dev · r18-est ↑4 ready to land · r17-col ↓5 needs rebase · +2 more  (its other active branches)
//   git     demo-web-ui  feat/auth-i18n  ↑1 to push · ↓2 to pull · rebase 3/7 · changes ?          (outside one, or a 2nd one)
// Exports: gitLineRows(board, slots, look, folder) (the status line's 1 or 2 git rows).
// From board.repo and board.repos (repos.mjs: the session folder's repository first): in the session's repository its current
// branch, then a `lanes` row of its other active branches (git-state.mjs rules a to e, at most MAX_LANES_SHOWN, then `+K more`);
// outside one or with a second repository, one row each (at most GIT_LINE_ROWS, then `+K more repos`), lanes after ` │ `. A branch:
// to push, to pull (yellow), conflicts (red), an operation (yellow), files (`changes ?` for refs only), stash, last commit age; a
// lane `ready to land` or `needs rebase` (yellow). Too wide: last commit drops first, then stash, never the rest. Below
// LABEL_FROM_COLUMNS short forms (`↑2 +1 ~3 ?1`), no repository name when only one shows; branch names in the `branch` colour,
// repository names bold. An old board without `active` draws its worktrees.
// Invariants: pure (no I/O); every name goes through cleanText; every row fits look.columns.
import { cleanText, cutWords, durationText, fitParts, LABEL_FROM_COLUMNS, labelled, partsWidth, STATE } from './cells.mjs';

const AGENT_NAME_CHARS = 16;
const MAX_LANES_SHOWN = 4; // spec R18: at most 4 branches per row, then `+K more`
const GIT_LINE_ROWS = 2;
const LANE_NAME_CHARS = 24;
const isCount = (value) => Number.isInteger(value) && value >= 0;
const isObject = (value) => value !== null && typeof value === 'object';
const worktreesOf = (repo) => (Array.isArray(repo?.worktrees) ? repo.worktrees.filter(isObject) : []);
const arrows = (look) => (look.ascii ? { up: '^', down: 'v', clean: 'ok' } : { up: '↑', down: '↓', clean: '✓' });
const above = (value) => isCount(value) && value > 0;
const opText = (branch, look) => cleanText(`${branch.op}${branch.opStep ? ` ${branch.opStep}` : ''}`, look);

/** A branch as the line draws it, from a worktree (an old board without `active`, or a main checkout whose branch is not active). */
const branchOfWorktree = (wt) => ({ name: wt.branch ?? wt.name, upAhead: wt.upAhead ?? null, upBehind: wt.upBehind ?? null,
  ahead: wt.main ? 0 : wt.ahead ?? null, behind: wt.main ? 0 : wt.behind ?? null, ageMin: wt.ageMin ?? null, agents: wt.agents ?? [], staged: wt.staged ?? null,
  changed: wt.changed ?? null, untracked: wt.untracked ?? null, conflicts: wt.conflicts ?? null, op: wt.op ?? null, opStep: wt.opStep ?? null });

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

/** The state parts of a repository's leading branch, in order: push, pull, conflicts, op, files or clean, stale, stash, age. */
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
    isCount(head.ageMin) ? { text: `last commit ${durationText(head.ageMin)} ago`, state: STATE.dim, drop: 3 } : null,
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
  if (!inline && agents.length > 0) add(agents.map((name) => cutWords(cleanText(name.split(':')[0], look), AGENT_NAME_CHARS, look)).join(','));
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
  if (lanesLeft && lanesCount > 0) parts.push({ text: `${lanesCount} lane${lanesCount === 1 ? '' : 's'}`, state: STATE.dim, drop: 4 });
  if (moreRepos > 0) parts.push({ text: `+${moreRepos} more repo${moreRepos === 1 ? '' : 's'}`, state: STATE.dim });
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
    return hasLanes && slots >= 2 ? [row, fitParts(withLanes([], first, repos[0].base, look, { inline: false, compact: false }), look)] : [row];
  }
  const shown = repos.slice(0, Math.min(slots, GIT_LINE_ROWS));
  return shown.map((repo, index) => repoLineRow(repo, look, {
    showName: !(narrow && shown.length === 1), inline: true, compact: shown.length > 1, moreRepos: index === shown.length - 1 ? repos.length - shown.length : 0,
  }));
}
