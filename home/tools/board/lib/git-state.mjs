// The git facts of one repository for the board's git rows (spec R18 "Git facts", owner decisions RC15 and RC19): every worktree
// with its branch, ahead/behind the base branch, staged, changed, new and conflicted files, last commit age and an operation in
// progress; the repository's stash count; and its active branches (at most MAX_ACTIVE, the rest counted). Run only by the detached
// board refresh, never by the status line.
// Exports: repoState({ cwd, sessionFolder, common, liveDirs, cache, nowMs, startMs }) -> { repo, git, cache }; gitIn(common, args);
// gitBudgetSpent(startMs); cleanName(text); GIT_SAFETY; OPS.
// Commands (fixed flags, GIT_SAFETY, GIT_TIMEOUT_MS each, GIT_BUDGET_MS of git per refresh, shared by every repository through
// `startMs` and checked before every call (gitBudgetSpent); past it the cached values stay with their age), only in the worktrees
// the repository records (trusted-repos.mjs worktreeRecords, read fresh, never from the cache):
//   `--git-dir=<common> for-each-ref` with the upstream, its track and %(ahead-behind:<base>) (git >= 2.41; REFS_EVERY_MS); per
//   worktree, when its index or HEAD changed or STATUS_EVERY_MS passed, first `config --list --name-only --show-scope` and then, only
//   when the repository's own config (local or worktree scope, includes followed) names no filter, `status --porcelain=v2 --branch`
//   with `--untracked-files=normal` on the session's own worktree (at most every UNTRACKED_EVERY_MS) and `no` elsewhere.
// Why the config look (RC19: full status in every used repository): `status` runs a clean filter the repository's config names
// (probed on git 2.54: an `include.path` filter ran), and no flag turns filters off; such a worktree gets refs only (`trust: 'refs'`,
// its counts null). Every other program a repository's config can name is off on the command line (GIT_SAFETY beats the repository's
// config), and GIT_NO_LAZY_FETCH stops a partial clone from fetching (a fetch would run the repository's ssh command).
// Every call (gitIn) runs without the inherited GIT_* variables and with GIT_COMMON_DIR=<common>, so a git folder's `commondir` file
// cannot send git elsewhere (review N-11).
// File-system facts: stash = lines of `<common>/logs/refs/stash`; op = the first of OPS present in the worktree's git folder, with
// `rebase 2/3` from rebase-merge msgnum/end or rebase-apply next/last, and the branch being rebased from its head-name; the base
// branch from `<common>/refs/heads/` or `<common>/packed-refs`. Each file is read only as a plain file, never waiting on a FIFO and
// never past its byte cap (read-part.mjs).
// Current and own: the deepest worktree holding the session folder (a lane in `.claude/worktrees/` lies inside the main checkout, so
// only the lane is current and counts new files); a live agent's folder makes only its deepest worktree active (rule b).
// Invariants: never throws; branch and upstream names are stored through cleanName (no control or bidi character) and reach the
// terminal only through the render's cleanText; no command takes text from a file as a flag (paths only as `-C`, `--git-dir=` and
// `--work-tree=` values from worktreeRecords, a ref only as the `<base>` inside `--format=`, and only when it passes SAFE_REF).
import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { devNull } from 'node:os';
import { basename, join, sep } from 'node:path';
import { readPart } from './read-part.mjs';
import { worktreeRecords } from './trusted-repos.mjs';

const GIT_TIMEOUT_MS = 250;
const GIT_BUDGET_MS = 250;
const REFS_EVERY_MS = 15_000;
const STATUS_EVERY_MS = 15_000;
const UNTRACKED_EVERY_MS = 60_000; // new files are counted on the session's own worktree only, at most this often (a big tree is slow)
const ACTIVE_WINDOW_MS = 24 * 60 * 60_000; // a branch ahead of the base with a commit this recent is active (spec U4 default)
const MAX_WORKTREES = 12;
const MAX_ACTIVE = 4;
const MAX_NAME_CHARS = 80;
const MAX_STEP_BYTES = 32;
const MAX_STASH_LOG_BYTES = 256 * 1024;
const MAX_PACKED_REFS_BYTES = 256 * 1024; // the head of packed-refs: refs/heads sorts before refs/remotes and refs/tags
const MS_PER_MIN = 60_000;
const MS_PER_S = 1000;
const BASE_NAMES = ['main', 'master'];
const REPOSITORY_SCOPES = new Set(['local', 'worktree']); // config that comes with the repository, not the owner's own
/**
 * Before every git call, on the command line so it beats the repository's own config: no fsmonitor hook, no hook from the
 * repository's hooks path, no signature program, no repository found by discovery inside a folder unless named (review SEC-7).
 */
export const GIT_SAFETY = ['-c', 'core.fsmonitor=false', '-c', 'safe.bareRepository=explicit', '-c', `core.hooksPath=${devNull}`,
  '-c', 'log.showSignature=false'];
/** The operations a worktree's git folder can be in the middle of: [file, name, step files (done, total)]. */
export const OPS = [['rebase-merge', 'rebase', ['msgnum', 'end']], ['rebase-apply', 'rebase', ['next', 'last']], ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['BISECT_LOG', 'bisect']];
const SAFE_REF = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/; // never a leading `-`: a ref is never read as an option
// C0 and C1 controls, and the bidi and zero-width format characters that can reorder or hide a row's text
const UNSHOWN_CHARS = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁦-⁩﻿]/g;

const mtimeOf = (path) => { try { return lstatSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0; } catch { return 0; } };
const exists = (path) => mtimeOf(path) > 0;
const textOf = (path, max) => { try { return readPart(path, max, false)?.text ?? null; } catch { return null; } };
const isInside = (dir, path) => typeof dir === 'string' && (dir === path || dir.startsWith(`${path}${sep}`));
/** The deepest of `worktrees` holding `dir` (a lane nested in the main checkout, not the main checkout); undefined when none does. */
const holderOf = (dir, worktrees) => worktrees.filter((wt) => isInside(dir, wt.path)).sort((a, b) => b.path.length - a.path.length)[0];

/** @returns {boolean} whether more than GIT_BUDGET_MS passed since `startMs` (the refresh's git start): asked before every git call */
export const gitBudgetSpent = (startMs) => Date.now() - startMs > GIT_BUDGET_MS;

/** @returns {string | null} a branch or upstream name as the board stores it: no control or bidi character, at most MAX_NAME_CHARS */
export const cleanName = (text) => (typeof text === 'string' && text !== '' ? text.replace(UNSHOWN_CHARS, ' ').slice(0, MAX_NAME_CHARS) : null);

/** The environment of a board git call: no inherited GIT_* variable (GIT_DIR, GIT_INDEX_FILE, ...), the verified shared folder pinned. */
function gitEnv(common) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  // git reads `commondir` of the git folder it is given and would take config, objects and attributes from wherever that file
  // points; GIT_COMMON_DIR overrides it with the folder trusted-repos.mjs verified (review N-11). No lazy fetch, no optional lock.
  return { ...env, GIT_COMMON_DIR: common, GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' };
}

/**
 * One git call of the board with fixed flags, on the repository whose shared git folder is `common`.
 * @param {string} common the verified shared git folder (trusted-repos.mjs)
 * @param {string[]} args the arguments after GIT_SAFETY (always with an explicit `--git-dir=`)
 * @returns {string | null} stdout; null on any failure or timeout
 */
export function gitIn(common, args) {
  try {
    return execFileSync('git', [...GIT_SAFETY, ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: gitEnv(common) });
  } catch {
    return null;
  }
}

/** The base branch: main, else master, else the main worktree's branch; null when none is a safe name. */
function baseOf(common, worktrees) {
  const packed = textOf(join(common, 'packed-refs'), MAX_PACKED_REFS_BYTES) ?? '';
  const found = BASE_NAMES.find((name) => exists(join(common, 'refs', 'heads', name)) || packed.includes(` refs/heads/${name}\n`));
  const base = found ?? worktrees[0]?.branch ?? null;
  return base !== null && SAFE_REF.test(base) ? base : null;
}

const countIn = (text, word) => Number(new RegExp(`\\b${word} (\\d+)`).exec(text)?.[1] ?? 0);

/** Every branch: { ahead, behind (vs base), t (last commit, epoch s), upstream, upAhead, upBehind (null without one or when gone) }. */
function parseRefs(text) {
  const refs = {};
  for (const line of text.split('\n').filter(Boolean)) {
    const [name, t, upstream, track = '', ab] = line.split('\t');
    const [ahead, behind] = (ab ?? '').split(' ').map(Number);
    const level = upstream !== '' && track !== 'gone';
    refs[name] = {
      ahead: Number.isInteger(ahead) ? ahead : null, behind: Number.isInteger(behind) ? behind : null, t: Number(t) || null,
      upstream: upstream || null, upAhead: level ? countIn(track, 'ahead') : null, upBehind: level ? countIn(track, 'behind') : null,
    };
  }
  return refs;
}

/** `status --porcelain=v2 --branch` in numbers: head, staged (X not `.`), changed (Y not `.`), conflicts (`u`), untracked (`?`), entries. */
function parseStatus(text, withUntracked) {
  const counts = { staged: 0, changed: 0, conflicts: 0, untracked: withUntracked ? 0 : null, entries: 0 };
  let head = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.head ')) head = line.slice('# branch.head '.length);
    else if (line.startsWith('u ')) { counts.conflicts += 1; counts.entries += 1; }
    else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      counts.staged += line[2] === '.' ? 0 : 1;
      counts.changed += line[3] === '.' ? 0 : 1;
      counts.entries += 1;
    } else if (line.startsWith('? ') && withUntracked) counts.untracked += 1;
  }
  return { head, ...counts };
}

/** The operation in progress in a git folder: { op, opStep ('2/3' for a rebase), rebasing (the branch a rebase is on) }. */
function opOf(gitDir) {
  const [file, op, steps] = OPS.find(([name]) => exists(join(gitDir, name))) ?? [];
  if (op === undefined) return { op: null, opStep: null, rebasing: null };
  const [done, total] = (steps ?? []).map((name) => Number((textOf(join(gitDir, file, name), MAX_STEP_BYTES) ?? '').trim()));
  const opStep = Number.isInteger(done) && Number.isInteger(total) && total > 0 ? `${done}/${total}` : null;
  const headName = op === 'rebase' ? /^refs\/heads\/(.+)$/.exec((textOf(join(gitDir, file, 'head-name'), MAX_NAME_CHARS * 2) ?? '').trim())?.[1] : undefined;
  return { op, opStep, rebasing: headName ?? null };
}

/** Whether the repository's own config (local or worktree scope, includes followed) names a filter; null when it cannot be read. */
function namesFilter(common, wt) {
  const list = gitIn(common, [`--git-dir=${wt.gitDir}`, 'config', '--list', '--name-only', '--show-scope']);
  if (list === null) return null;
  return list.split('\n').some((line) => {
    const [scope, key = ''] = line.split('\t');
    return REPOSITORY_SCOPES.has(scope) && key.toLowerCase().startsWith('filter.');
  });
}

/** One worktree's status call, `refs` when its repository's config names a filter, or null (no answer or no budget: the cache stays). */
function freshStatus(wt, common, withUntracked, clock) {
  if (gitBudgetSpent(clock.startMs)) return null;
  const filter = namesFilter(common, wt);
  if (filter === null) return null; // config unreadable or git out of time: no status runs
  if (filter) return { trust: 'refs', value: null };
  if (gitBudgetSpent(clock.startMs)) return null; // the config look used the rest of the budget
  const text = gitIn(common, ['-C', wt.path, `--git-dir=${wt.gitDir}`, `--work-tree=${wt.path}`, '--no-optional-locks', 'status', '--porcelain=v2', '--branch',
    `--untracked-files=${withUntracked ? 'normal' : 'no'}`, '--ignore-submodules=dirty']);
  return text === null ? null : { trust: 'full', value: parseStatus(text, withUntracked) };
}

/**
 * One worktree's status, reused from the cache while its index and HEAD are unchanged and it is younger than STATUS_EVERY_MS. Git gets
 * the git folder the repository records for the worktree (`--git-dir`, `--work-tree`), so it never reads the worktree's own `.git`
 * (reviews SEC-6 and N-9); `--ignore-submodules=dirty` keeps it out of nested repositories. `own`: the session's own worktree, the
 * only one whose new files are counted (at most every UNTRACKED_EVERY_MS; between, the last count stays).
 */
function statusOf(wt, common, cached, { clock, own }) {
  const dir = wt.gitDir;
  const key = `${mtimeOf(join(dir, 'index'))}:${mtimeOf(join(dir, 'HEAD'))}`;
  const kept = { key: '', at: 0, untrackedAt: 0, trust: 'full', value: null, ...(cached ?? {}), ...opOf(dir) };
  const fresh = cached !== undefined && cached.key === key && clock.nowMs - cached.at < STATUS_EVERY_MS;
  if (fresh) return kept;
  const withUntracked = own && clock.nowMs - (kept.untrackedAt ?? 0) >= UNTRACKED_EVERY_MS;
  const got = freshStatus(wt, common, withUntracked, clock);
  if (got === null) return kept;
  const untracked = withUntracked ? got.value?.untracked ?? null : own ? kept.value?.untracked ?? null : null;
  const value = got.value === null ? null : { ...got.value, untracked };
  return { ...kept, key, at: clock.nowMs, untrackedAt: withUntracked ? clock.nowMs : kept.untrackedAt, trust: got.trust, value };
}

/** The base branch and every branch's counts, reused from the cache while fresh; git runs on the shared git folder alone. */
function refsOf(common, worktrees, cache, clock) {
  const spent = gitBudgetSpent(clock.startMs); // the refresh's whole git budget is used: the cached refs stay
  const base = baseOf(common, worktrees);
  const refsFresh = spent || (cache.common === common && cache.base === base && clock.nowMs - (cache.refsAt ?? 0) < REFS_EVERY_MS);
  const format = `%(refname:short)%09%(committerdate:unix)%09%(upstream:short)%09%(upstream:track,nobracket)${base ? `%09%(ahead-behind:${base})` : ''}`;
  const refsText = refsFresh ? null : gitIn(common, [`--git-dir=${common}`, 'for-each-ref', `--format=${format}`, 'refs/heads']);
  const refs = refsText === null ? cache.refs : parseRefs(refsText);
  return { base, refs: refs !== null && typeof refs === 'object' ? refs : {}, refsAt: refsText === null ? (cache.refsAt ?? 0) : clock.nowMs };
}

/** The stash count from the stash reflog (one line per entry); 0 with none, null when it cannot be read. */
function stashOf(common) {
  const log = join(common, 'logs', 'refs', 'stash');
  if (!exists(log)) return 0;
  const text = textOf(log, MAX_STASH_LOG_BYTES);
  return text === null ? null : text.split('\n').filter(Boolean).length;
}

const ageOf = (ref, nowMs) => (ref?.t ? Math.max(0, Math.round((nowMs - ref.t * MS_PER_S) / MS_PER_MIN)) : null);
const hasChanges = (wt) => (wt.staged ?? 0) + (wt.changed ?? 0) + (wt.conflicts ?? 0) + (wt.untracked ?? 0) > 0 || wt.op !== null;

/** Why a branch is active, as a rank (lower shows first), or null: spec rules (a) to (e). */
function activeRank(name, ref, wt, place) {
  if (wt !== undefined && wt.path === place.sessionPath) return 0; // (a) checked out in the session folder
  if (wt !== undefined && place.livePaths.has(wt.path)) return 1; // (b) a live agent works there
  if (wt !== undefined && hasChanges(wt)) return 2; // (c) a worktree with changes
  if ((ref?.ahead ?? 0) > 0 && ref.t !== null && place.nowMs - ref.t * MS_PER_S <= ACTIVE_WINDOW_MS) return 3; // (d) recent work ahead
  if (name === place.base && ((ref?.upAhead ?? 0) > 0 || (ref?.upBehind ?? 0) > 0)) return 4; // (e) the base, not level with upstream
  return null;
}

/** The repository's active branches, at most MAX_ACTIVE (current first, then by rule, then newest commit), and how many more there are. */
function activeOf(refs, worktrees, place) {
  const byBranch = new Map(worktrees.filter((wt) => wt.rawBranch !== null).map((wt) => [wt.rawBranch, wt]));
  const ranked = [...new Set([...byBranch.keys(), ...Object.keys(refs)])].flatMap((name) => {
    const ref = refs[name];
    const wt = byBranch.get(name);
    const rank = activeRank(name, ref, wt, place);
    return rank === null ? [] : [{ rank, t: ref?.t ?? 0, entry: {
      name: cleanName(name), current: rank === 0, upstream: cleanName(ref?.upstream ?? null), upAhead: ref?.upAhead ?? null, upBehind: ref?.upBehind ?? null,
      ahead: ref?.ahead ?? null, behind: ref?.behind ?? null, ageMin: ageOf(ref, place.nowMs), worktree: wt?.name ?? null, agents: [],
      staged: wt?.staged ?? null, changed: wt?.changed ?? null, untracked: wt?.untracked ?? null, conflicts: wt?.conflicts ?? null, op: wt?.op ?? null, opStep: wt?.opStep ?? null,
    } }];
  }).sort((a, b) => a.rank - b.rank || b.t - a.t);
  return { active: ranked.slice(0, MAX_ACTIVE).map(({ entry }) => entry), activeMore: Math.max(0, ranked.length - MAX_ACTIVE) };
}

/** The branch a worktree is on: its HEAD's, else (HEAD detached by a rebase) the one being rebased; the raw name, for the refs. */
const branchOf = (wt, state) => wt.branch ?? state.rebasing;

/** One worktree's board entry from its record, the refs and its status (names cleaned: cleanName). */
function worktreeEntry(wt, refs, state, nowMs) {
  const branch = branchOf(wt, state);
  const ref = branch === null ? undefined : refs[branch];
  const value = state.value;
  return {
    name: cleanName(wt.main ? (branch ?? basename(wt.path)) : basename(wt.path)), path: wt.path, branch: cleanName(branch), main: wt.main,
    ahead: ref?.ahead ?? null, behind: ref?.behind ?? null, changed: value === null ? null : value.entries, op: state.op, opStep: state.opStep,
    staged: value?.staged ?? null, conflicts: value?.conflicts ?? null, untracked: value?.untracked ?? null, trust: state.trust,
    ageMin: ageOf(ref, nowMs), agents: [], checkedMs: state.at, upAhead: ref?.upAhead ?? null, upBehind: ref?.upBehind ?? null,
  };
}

/**
 * @param {{ cwd: string, sessionFolder?: string | null, common: string, liveDirs?: string[], cache: object | null, nowMs: number,
 *   startMs?: number }} source the folder whose worktree gives `git`, the session's folder (its worktree is `current` and the only
 *   one whose new files are counted), the repository's shared git folder (trusted-repos.mjs), the live agents' folders (active rule
 *   b), the last git cache (results only: it never names a folder git runs in, review SEC-11), and when the refresh's git budget started
 * @returns {{ repo: object | null, git: object | null, cache: object }} repo = { base, branches, unlanded, trust ('full' | 'refs'),
 *   stash, active: [{ name, current, upstream, upAhead, upBehind, ahead, behind, ageMin, worktree, agents, staged, changed,
 *   untracked, conflicts, op, opStep }], activeMore, worktrees: [{ name, path, branch, main, ahead, behind, changed (tracked entries),
 *   staged, conflicts, untracked, trust, op, opStep, ageMin, agents, checkedMs, upAhead, upBehind }] }; git = the `cwd` worktree's
 *   { branch, ahead, behind, changed } (vs its upstream); null outside a repository
 */
export function repoState({ cwd, sessionFolder = null, common, liveDirs = [], cache, nowMs, startMs = Date.now() }) {
  const old = cache !== null && typeof cache === 'object' ? cache : {};
  try {
    if (typeof common !== 'string') return { repo: null, git: null, cache: {} };
    const clock = { nowMs, startMs };
    // the worktrees the repository records, read fresh: the only folders git runs in (reviews SEC-6, N-9, SEC-11)
    const records = worktreeRecords(common).slice(0, MAX_WORKTREES);
    const sessionPath = holderOf(sessionFolder, records)?.path ?? null;
    const livePaths = new Set(liveDirs.map((dir) => holderOf(dir, records)?.path).filter((path) => path !== undefined));
    const { base, refs, refsAt } = refsOf(common, records, old, clock);
    const status = Object.fromEntries(records.map((wt) => [wt.path, statusOf(wt, common, old.status?.[wt.path], { clock, own: wt.path === sessionPath })]));
    const worktrees = records.map((wt) => worktreeEntry(wt, refs, status[wt.path], nowMs));
    // for the active branches: the raw branch name (the refs' key) and `changed` as the spec counts it (Y not `.`, not every entry)
    const withRaw = worktrees.map((wt, at) => ({ ...wt, rawBranch: branchOf(records[at], status[wt.path]), changed: status[wt.path].value?.changed ?? null }));
    const names = Object.keys(refs);
    const own = holderOf(cwd, withRaw);
    const ownStatus = own === undefined ? null : status[own.path];
    const ownRef = own?.rawBranch ? refs[own.rawBranch] : undefined;
    return {
      repo: {
        base, branches: names.length, unlanded: names.filter((name) => name !== base && (refs[name].ahead ?? 0) > 0).length,
        trust: worktrees.every((wt) => wt.trust === 'full') ? 'full' : 'refs', stash: stashOf(common),
        ...activeOf(refs, withRaw, { sessionPath, livePaths, nowMs, base }), worktrees,
      },
      git: ownStatus?.value ? { branch: cleanName(ownStatus.value.head), ahead: ownRef?.upAhead ?? null, behind: ownRef?.upBehind ?? null, changed: ownStatus.value.entries } : null,
      cache: { common, base, refs, refsAt, status },
    };
  } catch {
    return { repo: null, git: null, cache: old };
  }
}
