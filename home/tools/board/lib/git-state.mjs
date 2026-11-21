// The git facts of the session's repository for the board's git rows (spec-tui row 5, research-tui 4): every worktree with its branch,
// ahead/behind the base branch, changed files, last commit age, an operation in progress and the agents working there; plus the
// branch count and how many branches are not landed. Run only by the detached board refresh, never by the status line.
// Exports: repoState({ cwd, agentDirs, cache, nowMs }) -> { repo, git, cache }.
// Commands (fixed flags, GIT_SAFETY, GIT_TIMEOUT_MS each, at most GIT_BUDGET_MS of git per refresh, shared by every
// repository through `startMs`; past it the cached values stay with their age). Run only in repositories the board trusts (repos.mjs):
//   rev-parse --path-format=absolute --git-common-dir (once per folder); worktree list --porcelain -z (when <common>/worktrees changed, or
//   WORKTREES_EVERY_MS); for-each-ref with %(ahead-behind:<base>) (git >= 2.41, one walk; REFS_EVERY_MS); per worktree
//   `--no-optional-locks status --porcelain=v2 --branch --untracked-files=no` only when its index or HEAD changed, or STATUS_EVERY_MS.
//   --no-optional-locks: the board never takes index.lock while an agent commits.
// Invariants: never throws; branch and path names reach the terminal only through the render's cleanText; no command takes text
// from a file as a flag (paths are passed after -C, refs only as a `<base>` read from refs/heads).
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { sameRepo } from './trusted-repos.mjs';

const GIT_TIMEOUT_MS = 250;
const GIT_BUDGET_MS = 250;
const WORKTREES_EVERY_MS = 60_000;
const REFS_EVERY_MS = 15_000;
const STATUS_EVERY_MS = 15_000;
const MAX_WORKTREES = 12;
const MS_PER_MIN = 60_000;
const MS_PER_S = 1000;
const BASE_NAMES = ['main', 'master'];
/** Before every git call: no fsmonitor hook, and no repository found by discovery inside a folder unless named (review SEC-7). */
export const GIT_SAFETY = ['-c', 'core.fsmonitor=false', '-c', 'safe.bareRepository=explicit'];
const SAFE_REF = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/; // never a leading `-`: a ref is never read as an option
const OPS = [['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick']];

const mtimeOf = (path) => { try { return lstatSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0; } catch { return 0; } };
const exists = (path) => mtimeOf(path) > 0;

/** One git call with fixed flags; null on any failure or timeout. */
function git(args) {
  try {
    return execFileSync('git', [...GIT_SAFETY, ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch {
    return null;
  }
}

/**
 * The worktrees of `git worktree list --porcelain -z`, the main one first: each field ends with NUL and a record with an empty field,
 * so a path holding a newline cannot forge a second record (review SEC-6).
 */
function parseWorktrees(text) {
  const records = [];
  let fields = [];
  for (const field of text.split('\0')) {
    if (field !== '') {
      fields.push(field);
      continue;
    }
    if (fields.length > 0) records.push(fields);
    fields = [];
  }
  return records.flatMap((record) => {
    const path = record.find((field) => field.startsWith('worktree '))?.slice('worktree '.length);
    if (path === undefined || record.includes('bare')) return [];
    const branch = record.find((field) => field.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length) ?? null;
    return [{ path, branch }];
  }).slice(0, MAX_WORKTREES);
}

/** The base branch: main, else master, else the main worktree's branch; null when none is a safe name. */
function baseOf(common, worktrees) {
  const packed = (() => { try { return readFileSync(join(common, 'packed-refs'), 'utf8'); } catch { return ''; } })();
  const found = BASE_NAMES.find((name) => exists(join(common, 'refs', 'heads', name)) || packed.includes(` refs/heads/${name}\n`));
  const base = found ?? worktrees[0]?.branch ?? null;
  return base !== null && SAFE_REF.test(base) ? base : null;
}

/** Every branch: { ahead, behind (vs base), t (last commit, epoch s) }. */
function parseRefs(text) {
  const refs = {};
  for (const line of text.split('\n').filter(Boolean)) {
    const [name, t, ab] = line.split('\t');
    const [ahead, behind] = (ab ?? '').split(' ').map(Number);
    refs[name] = { ahead: Number.isInteger(ahead) ? ahead : null, behind: Number.isInteger(behind) ? behind : null, t: Number(t) || null };
  }
  return refs;
}

/** The git folder of a worktree (its `.git` file names it), for the index, HEAD and operation files. */
function gitDirOf(path, common) {
  try {
    const dotGit = join(path, '.git');
    if (lstatSync(dotGit).isDirectory()) return dotGit;
    const dir = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim();
    return dir ?? common;
  } catch {
    return common;
  }
}

function parseStatus(text) {
  const lines = text.split('\n').filter(Boolean);
  const ab = /^# branch\.ab \+(\d+) -(\d+)$/m.exec(text);
  const head = lines.find((line) => line.startsWith('# branch.head '))?.slice('# branch.head '.length) ?? null;
  return { head, upAhead: ab ? Number(ab[1]) : null, upBehind: ab ? Number(ab[2]) : null, changed: lines.filter((line) => !line.startsWith('#')).length };
}

/** One worktree's status, reused from the cache while its index and HEAD are unchanged and it is younger than STATUS_EVERY_MS. */
function statusOf(wt, common, cached, clock) {
  const dir = gitDirOf(wt.path, common);
  const key = `${mtimeOf(join(dir, 'index'))}:${mtimeOf(join(dir, 'HEAD'))}`;
  const fresh = cached !== undefined && cached.key === key && clock.nowMs - cached.at < STATUS_EVERY_MS;
  const op = OPS.find(([file]) => exists(join(dir, file)))?.[1] ?? null;
  if (fresh || Date.now() - clock.startMs > GIT_BUDGET_MS) return { ...(cached ?? { key: '', at: 0, value: null }), op };
  const text = git(['--no-optional-locks', '-C', wt.path, 'status', '--porcelain=v2', '--branch', '--untracked-files=no']);
  return text === null ? { ...(cached ?? { key: '', at: 0, value: null }), op } : { key, at: clock.nowMs, value: parseStatus(text), op };
}

/** The agents working in a worktree: the longest worktree path that holds the agent's folder. */
function agentsIn(worktrees, agentDirs) {
  const byPath = new Map(worktrees.map((wt) => [wt.path, []]));
  for (const { name, dir } of agentDirs) {
    if (typeof dir !== 'string') continue;
    const home = worktrees.filter((wt) => dir === wt.path || dir.startsWith(`${wt.path}${sep}`)).sort((a, b) => b.path.length - a.path.length)[0];
    if (home !== undefined) byPath.get(home.path).push(name);
  }
  return byPath;
}

/** The common folder of the repository holding cwd, cached per cwd. */
function commonOf(cwd, cache) {
  if (cache.cwd === cwd && typeof cache.common === 'string') return cache.common;
  return git(['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'])?.trim() || null;
}

/** The worktree list and the refs, each reused from the cache while still fresh. */
function listsOf(cwd, common, cache, clock) {
  const { nowMs } = clock;
  const spent = Date.now() - clock.startMs > GIT_BUDGET_MS; // the refresh's whole git budget is used: the cached lists stay
  const wtMtime = mtimeOf(join(common, 'worktrees'));
  const listFresh = spent || (cache.common === common && cache.wtMtime === wtMtime && nowMs - (cache.wtAt ?? 0) < WORKTREES_EVERY_MS);
  const listText = listFresh ? null : git(['-C', cwd, 'worktree', 'list', '--porcelain', '-z']);
  const worktrees = listText === null ? (cache.worktrees ?? []) : parseWorktrees(listText);
  const base = baseOf(common, worktrees);
  const refsFresh = spent || (cache.common === common && cache.base === base && nowMs - (cache.refsAt ?? 0) < REFS_EVERY_MS);
  const format = `%(refname:short)%09%(committerdate:unix)${base ? `%09%(ahead-behind:${base})` : ''}`;
  const refsText = refsFresh ? null : git(['-C', cwd, 'for-each-ref', `--format=${format}`, 'refs/heads']);
  return {
    worktrees, base, wtMtime, wtAt: listText === null ? (cache.wtAt ?? 0) : nowMs,
    refs: refsText === null ? (cache.refs ?? {}) : parseRefs(refsText), refsAt: refsText === null ? (cache.refsAt ?? 0) : nowMs,
  };
}

/**
 * @param {{ cwd: string, common?: string | null, agentDirs?: { name: string, dir: string | null }[], cache: object | null, nowMs: number,
 *   startMs?: number }} source a trusted folder, its repository's shared git folder when known, the agents' folders, the last git
 *   cache, and when the refresh's git budget started
 * @returns {{ repo: object | null, git: object | null, cache: object }} repo = { base, branches, unlanded, worktrees: [{ name, path,
 *   branch, ahead, behind, changed, ageMin, op, agents, checkedMs, upAhead, upBehind (vs its upstream, null without one), main }] }; git = the session folder's own { branch, ahead, behind,
 *   changed } (vs its upstream, the shape the old board had); null outside a repository
 */
export function repoState({ cwd, common: knownCommon = null, agentDirs = [], cache, nowMs, startMs = Date.now() }) {
  const old = cache ?? {};
  try {
    const common = knownCommon ?? commonOf(cwd, old); // known from the file system (trusted-repos.mjs): no git call, so no time-out
    if (common === null) return { repo: null, git: null, cache: {} };
    const clock = { nowMs, startMs };
    const listed = listsOf(cwd, common, old, clock);
    // a listed worktree whose `.git` no longer leads back to this repository (rewritten, or the folder replaced) is dropped before
    // any git call in it (review SEC-6, second half); the cached list is checked the same way
    const lists = { ...listed, worktrees: listed.worktrees.filter((wt) => sameRepo(wt.path, common)) };
    const status = Object.fromEntries(lists.worktrees.map((wt) => [wt.path, statusOf(wt, common, old.status?.[wt.path], clock)]));
    const agents = agentsIn(lists.worktrees, agentDirs);
    const worktrees = lists.worktrees.map((wt, index) => {
      const ref = wt.branch === null ? undefined : lists.refs[wt.branch];
      const value = status[wt.path].value;
      return {
        name: index === 0 ? (wt.branch ?? basename(wt.path)) : basename(wt.path), path: wt.path, branch: wt.branch, main: index === 0,
        ahead: ref?.ahead ?? null, behind: ref?.behind ?? null, changed: value?.changed ?? null, op: status[wt.path].op,
        ageMin: ref?.t ? Math.max(0, Math.round((nowMs - ref.t * MS_PER_S) / MS_PER_MIN)) : null, agents: agents.get(wt.path), checkedMs: status[wt.path].at,
        upAhead: value?.upAhead ?? null, upBehind: value?.upBehind ?? null,
      };
    });
    const names = Object.keys(lists.refs);
    const own = worktrees.filter((wt) => cwd === wt.path || cwd.startsWith(`${wt.path}${sep}`)).sort((a, b) => b.path.length - a.path.length)[0];
    const ownValue = own === undefined ? null : status[own.path].value;
    return {
      repo: { base: lists.base, branches: names.length, unlanded: names.filter((name) => name !== lists.base && (lists.refs[name].ahead ?? 0) > 0).length, worktrees },
      git: ownValue === null ? null : { branch: ownValue.head, ahead: ownValue.upAhead, behind: ownValue.upBehind, changed: ownValue.changed },
      cache: { cwd, common, ...lists, status },
    };
  } catch {
    return { repo: null, git: null, cache: old };
  }
}
