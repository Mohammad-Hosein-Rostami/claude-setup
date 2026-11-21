// The git facts of the session's repository for the board's git rows (spec-tui row 5, research-tui 4): every worktree with its branch,
// ahead/behind the base branch, changed files, last commit age, an operation in progress and the agents working there; plus the
// branch count and how many branches are not landed. Run only by the detached board refresh, never by the status line.
// Exports: repoState({ cwd, common, agentDirs, cache, nowMs, startMs }) -> { repo, git, cache }; gitIn(common, args).
// Commands (fixed flags, GIT_SAFETY, GIT_TIMEOUT_MS each, at most GIT_BUDGET_MS of git per refresh, shared by every
// repository through `startMs`; past it the cached values stay with their age). Run only in repositories the board trusts (repos.mjs),
// and only in the worktrees the repository records (trusted-repos.mjs worktreeRecords, read fresh, never from the cache):
//   `--git-dir=<common> for-each-ref` with %(ahead-behind:<base>) (git >= 2.41, one walk; REFS_EVERY_MS); per worktree
//   `--git-dir=<its recorded git folder> --work-tree=<path> --no-optional-locks status --porcelain=v2 --branch --untracked-files=no
//   --ignore-submodules=dirty` only when its index or HEAD changed, or STATUS_EVERY_MS.
//   --no-optional-locks: the board never takes index.lock while an agent commits.
//   Every call (gitIn) runs without the inherited GIT_* variables and with GIT_COMMON_DIR=<common>, so a git folder's `commondir`
//   file cannot send git elsewhere (review N-11).
// Invariants: never throws; branch and path names reach the terminal only through the render's cleanText; no command takes text
// from a file as a flag (paths only as `-C`, `--git-dir=` and `--work-tree=` values from worktreeRecords, refs only as a `<base>`
// read from refs/heads).
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { worktreeRecords } from './trusted-repos.mjs';

const GIT_TIMEOUT_MS = 250;
const GIT_BUDGET_MS = 250;
const REFS_EVERY_MS = 15_000;
const STATUS_EVERY_MS = 15_000;
const MAX_WORKTREES = 12;
const MS_PER_MIN = 60_000;
const MS_PER_S = 1000;
const BASE_NAMES = ['main', 'master'];
/** Before every git call: no fsmonitor hook, and no repository found by discovery inside a folder unless named (review SEC-7). */
const GIT_SAFETY = ['-c', 'core.fsmonitor=false', '-c', 'safe.bareRepository=explicit'];
const SAFE_REF = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/; // never a leading `-`: a ref is never read as an option
const OPS = [['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick']];

const mtimeOf = (path) => { try { return lstatSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0; } catch { return 0; } };
const exists = (path) => mtimeOf(path) > 0;

/** The environment of a board git call: no inherited GIT_* variable (GIT_DIR, GIT_INDEX_FILE, ...), the verified shared folder pinned. */
function gitEnv(common) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  // git reads `commondir` of the git folder it is given and would take config, objects and attributes from wherever that file
  // points; GIT_COMMON_DIR overrides it with the folder trusted-repos.mjs verified (review N-11)
  return { ...env, GIT_COMMON_DIR: common };
}

/**
 * One git call of the board with fixed flags, on the trusted repository whose shared git folder is `common`.
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

/** `status --porcelain=v2 --branch` in numbers: { head, upAhead, upBehind (vs its upstream), changed (tracked files changed) }. */
function parseStatus(text) {
  const lines = text.split('\n').filter(Boolean);
  const ab = /^# branch\.ab \+(\d+) -(\d+)$/m.exec(text);
  const head = lines.find((line) => line.startsWith('# branch.head '))?.slice('# branch.head '.length) ?? null;
  return { head, upAhead: ab ? Number(ab[1]) : null, upBehind: ab ? Number(ab[2]) : null, changed: lines.filter((line) => !line.startsWith('#')).length };
}

/**
 * One worktree's status, reused from the cache while its index and HEAD are unchanged and it is younger than STATUS_EVERY_MS. Git gets
 * the git folder the repository records for the worktree (`--git-dir`, `--work-tree`), so it never reads the worktree's own `.git`
 * (reviews SEC-6 and N-9: a swapped or racing `.git` cannot point it at another repository); `--ignore-submodules=dirty` keeps it out
 * of nested repositories.
 */
function statusOf(wt, common, cached, clock) {
  const dir = wt.gitDir;
  const key = `${mtimeOf(join(dir, 'index'))}:${mtimeOf(join(dir, 'HEAD'))}`;
  const fresh = cached !== undefined && cached.key === key && clock.nowMs - cached.at < STATUS_EVERY_MS;
  const op = OPS.find(([file]) => exists(join(dir, file)))?.[1] ?? null;
  if (fresh || Date.now() - clock.startMs > GIT_BUDGET_MS) return { ...(cached ?? { key: '', at: 0, value: null }), op };
  const text = gitIn(common, ['-C', wt.path, `--git-dir=${wt.gitDir}`, `--work-tree=${wt.path}`, '--no-optional-locks', 'status', '--porcelain=v2', '--branch',
    '--untracked-files=no', '--ignore-submodules=dirty']);
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

/** The base branch and every branch's counts, reused from the cache while fresh; git runs on the shared git folder alone. */
function refsOf(common, worktrees, cache, clock) {
  const spent = Date.now() - clock.startMs > GIT_BUDGET_MS; // the refresh's whole git budget is used: the cached refs stay
  const base = baseOf(common, worktrees);
  const refsFresh = spent || (cache.common === common && cache.base === base && clock.nowMs - (cache.refsAt ?? 0) < REFS_EVERY_MS);
  const format = `%(refname:short)%09%(committerdate:unix)${base ? `%09%(ahead-behind:${base})` : ''}`;
  const refsText = refsFresh ? null : gitIn(common, [`--git-dir=${common}`, 'for-each-ref', `--format=${format}`, 'refs/heads']);
  const refs = refsText === null ? cache.refs : parseRefs(refsText);
  return { base, refs: refs !== null && typeof refs === 'object' ? refs : {}, refsAt: refsText === null ? (cache.refsAt ?? 0) : clock.nowMs };
}

/**
 * @param {{ cwd: string, common: string, agentDirs?: { name: string, dir: string | null }[], cache: object | null, nowMs: number,
 *   startMs?: number }} source a trusted folder and its repository's shared git folder (trusted-repos.mjs), the agents' folders, the
 *   last git cache (results only: it never names a folder git runs in, review SEC-11), and when the refresh's git budget started
 * @returns {{ repo: object | null, git: object | null, cache: object }} repo = { base, branches, unlanded, worktrees: [{ name, path,
 *   branch, ahead, behind, changed, ageMin, op, agents, checkedMs, upAhead, upBehind (vs its upstream, null without one), main }] }; git = the session folder's own { branch, ahead, behind,
 *   changed } (vs its upstream, the shape the old board had); null outside a repository
 */
export function repoState({ cwd, common, agentDirs = [], cache, nowMs, startMs = Date.now() }) {
  const old = cache !== null && typeof cache === 'object' ? cache : {};
  try {
    if (typeof common !== 'string') return { repo: null, git: null, cache: {} };
    const clock = { nowMs, startMs };
    // the worktrees the repository records, read fresh: the only folders git runs in (reviews SEC-6, N-9, SEC-11)
    const records = worktreeRecords(common).slice(0, MAX_WORKTREES);
    const lists = { worktrees: records, ...refsOf(common, records, old, clock) };
    const status = Object.fromEntries(lists.worktrees.map((wt) => [wt.path, statusOf(wt, common, old.status?.[wt.path], clock)]));
    const agents = agentsIn(lists.worktrees, agentDirs);
    const worktrees = lists.worktrees.map((wt) => {
      const ref = wt.branch === null ? undefined : lists.refs[wt.branch];
      const value = status[wt.path].value;
      return {
        name: wt.main ? (wt.branch ?? basename(wt.path)) : basename(wt.path), path: wt.path, branch: wt.branch, main: wt.main,
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
      cache: { common, base: lists.base, refs: lists.refs, refsAt: lists.refsAt, status },
    };
  } catch {
    return { repo: null, git: null, cache: old };
  }
}
