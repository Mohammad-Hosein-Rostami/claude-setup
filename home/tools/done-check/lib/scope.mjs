// Which files a done-check looks at: the code files one agent, the lead or a land changed in a worktree, the base they are compared with,
// and a key that is the same for the same change before and after its commit (design section 3.1 and 6).
// Exports: ownChange(input, env) -> Scope[] (one per worktree; [] = nothing to check), rangeChange(top, base) -> Scope (base..worktree, for
//   land and manual runs), changedLines(top, base, file) -> [start, end][] (1-based, both ends inclusive, sorted, pure deletions left out).
// Rules (the tests in tests/done-check-scope.test.mjs fix the ones the design leaves open):
// - Base = the HEAD the agent or lead had at its first tool call (lib/dirty-baseline.mjs `baselineOf`), only when that baseline was taken in
//   the same worktree and the commit still exists. No baseline, an old one without head, an unreadable store, a base git cannot find or a
//   folder that is not git: base null, and only uncommitted and untracked files of this session's own are seen.
// - A subagent owns every file changed between base and its worktree (committed or not), plus untracked ones. Of the uncommitted files it
//   owns those it recorded (lib/own-edits.mjs) or that changed since its baseline (a Bash command made them). The lead owns only the files
//   recorded for its session (that set also holds the files its agents recorded, as commit-gate sees it): land-lane moves HEAD, so a landed
//   lane is not the lead's. A lead started outside a repo gets one Scope per worktree it edited in (`editedWorktrees`).
// - Code files: ts tsx js jsx mjs cjs mts cts vue. `wide`: package.json, lockfiles, tsconfig*.json, vitest, jest and eslint config; a wide file
//   is never also in `files`. A change with neither gives no Scope (ownChange) and an empty Scope (rangeChange). A deleted file is listed
//   (a deletion can break its importers), so a consumer checks that a file exists before it hands it to a tool.
// - Paths are repo-relative with `/`. Scope.key = sha256 of the base and the sorted paths with their worktree content hashes; the caller that
//   has a plan mixes the plan fingerprint in. Content, not commit state, so a commit does not change it; a moved base does.
// Invariants: every git call goes through hooks/lib/gated-folder.mjs `runGit` (hardened, no repository program) with fixed flags, `-z` for
//   lists and `--literal-pathspecs`; a file name is only ever an argument after `--`, never an option and never in a shell; a repo that names
//   a filter program is not asked (git would run it): ownChange gives [], rangeChange throws so a land fails closed. An empty tree costs one
//   `rev-parse` pair and one `status`, no more. ownChange never throws; rangeChange and changedLines throw on a bad base or a failed git call.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { baselineOf, changedSinceBaseline } from '../../../hooks/lib/dirty-baseline.mjs';
import { editedWorktrees, gatedFolder, gitOut, namesFilterProgram, worktreeOf } from '../../../hooks/lib/gated-folder.mjs';
import { LEAD, realPathOf, recordedPaths, statusEntries } from '../../../hooks/lib/own-edits.mjs';
import { readPlainFile } from '../../../hooks/lib/plain-file.mjs';

const GIT_TIMEOUT_MS = 20_000; // one git call; a hung repo must not eat the stop deadline
const MAX_HASHED_BYTES = 8 * 1024 * 1024; // a code file over this is stamped by size and time instead of content
const STATUS_PATH_AT = 3; // a porcelain entry is `XY <path>`
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CODE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|vue)$/i;
const WIDE_FILE = /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|tsconfig(?:\.[^/]*)?\.json|(?:vitest|jest)\.(?:config|workspace)\.[^/]+|eslint\.config\.[^/]+|\.eslintrc(?:\.[^/]+)?)$/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all'];

const git = (top, args) => gitOut(top, ['--literal-pathspecs', ...args], GIT_TIMEOUT_MS);
const isWide = (path) => WIDE_FILE.test(basename(path));
const isCode = (path) => CODE_FILE.test(path) && !path.split('/').includes('node_modules');
const inside = (parent, path) => path.startsWith(parent.endsWith(sep) ? parent : parent + sep);

function assertCommit(base) {
  if (typeof base !== 'string' || !COMMIT_ID.test(base)) throw new TypeError('done-check scope: base must be a full commit id (40 or 64 hex)');
}

/** A short text that changes when the file's content changes; the content hash, or size and time for a file too big or unreadable. */
function stampOf(path) {
  try {
    return createHash('sha256').update(readPlainFile(path, MAX_HASHED_BYTES)).digest('hex');
  } catch (error) {
    return error.code === 'ENOENT' ? 'gone' : `unread:${error.code ?? ''}`;
  }
}

/** The change key: sha256 of the base and the sorted paths with their content stamps (path ends at NUL, which no name holds). */
function changeKey(base, top, paths) {
  const hash = createHash('sha256').update(`${base ?? ''}\n`);
  for (const path of [...paths].sort()) hash.update(`${path}\0${stampOf(join(top, path))}\n`);
  return hash.digest('hex');
}

/** The Scope of `paths` (repo-relative); null when it holds no code and no wide file and `keepEmpty` is false. */
function scopeFrom(top, isGit, base, paths, keepEmpty = false) {
  const unique = [...new Set(paths)].filter((path) => !path.split('/').includes('node_modules'));
  const wide = unique.filter(isWide).sort();
  const files = unique.filter((path) => !isWide(path) && isCode(path)).sort();
  if (!keepEmpty && files.length === 0 && wide.length === 0) return null;
  return { top, git: isGit, base, files, wide, key: changeKey(base, top, [...files, ...wide]) };
}

/** Files changed between `base` and the worktree (tracked, staged or not); null when git cannot say (a commit it does not have). */
function diffPaths(top, base) {
  const out = git(top, ['diff', '--name-only', '-z', ...DIFF_FLAGS, base, '--']);
  return out === null ? null : out.split('\0').filter((path) => path !== '');
}

/** `git status` of the worktree as {field, path (absolute), rel}; null when git fails. */
function dirtyEntries(top) {
  const out = git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all', '--no-renames']);
  return out === null ? null : statusEntries(out, top).map((entry) => ({ ...entry, rel: entry.field.slice(STATUS_PATH_AT) }));
}

/** The baseline's HEAD as this worktree's base: only a baseline taken here, with a well-formed commit id; else null. */
function baseOf(baseline, top) {
  return baseline?.top === top && typeof baseline.head === 'string' && COMMIT_ID.test(baseline.head) ? baseline.head : null;
}

/**
 * Of the changed paths, the ones this session or agent owns. Committed-only paths of an agent count; a dirty path counts when it was
 * recorded or (agent only) changed since the baseline; the lead keeps recorded paths only.
 */
function ownedPaths(ctx, top, changed, dirty) {
  const isRecorded = (rel) => ctx.recorded.has(join(top, rel));
  if (ctx.agent === LEAD) return changed.filter(isRecorded);
  const dirtyRel = new Set(dirty.map(({ rel }) => rel));
  const unrecorded = dirty.filter(({ rel }) => !isRecorded(rel));
  const byBash = new Set(changedSinceBaseline(ctx.env, ctx.session, ctx.agent, top, unrecorded).map(({ path }) => path));
  const dirtyOwn = new Set(dirty.filter(({ rel, path }) => isRecorded(rel) || byBash.has(path)).map(({ rel }) => rel));
  return changed.filter((rel) => !dirtyRel.has(rel) || dirtyOwn.has(rel));
}

/** The Scope of one git worktree for this session or agent, or null. The first git calls are `rev-parse`; the only list call is `status`. */
function gitScope(ctx, tree) {
  const top = realPathOf(tree.top);
  if (namesFilterProgram(tree.top)) return null;
  const head = (git(tree.top, ['rev-parse', '--verify', '--quiet', 'HEAD']) ?? '').trim();
  let base = baseOf(ctx.baseline, top);
  const dirty = dirtyEntries(tree.top);
  if (dirty === null) return null;
  let changed = dirty.map(({ rel }) => rel);
  if (base !== null && base !== head) {
    const committed = diffPaths(tree.top, base);
    if (committed === null) base = null; // the base commit is gone: no base compare
    else changed = [...committed, ...dirty.filter(({ field }) => field.startsWith('??')).map(({ rel }) => rel)];
  }
  const relevant = changed.filter((rel) => isCode(rel) || isWide(rel));
  if (relevant.length === 0) return null;
  return scopeFrom(top, true, base, ownedPaths(ctx, top, relevant, dirty));
}

/** The Scope of a folder that is not git: the recorded files under it that still exist (no base, nothing to compare). */
function plainScope(ctx, folder, skipTops) {
  const top = realPathOf(folder);
  const paths = [...ctx.recorded]
    .filter((path) => inside(top, path) && !skipTops.some((other) => inside(other, path)) && existsSync(path))
    .map((path) => relative(top, path).split(sep).join('/'));
  return scopeFrom(top, false, null, paths);
}

/**
 * The code files this session or agent changed, one Scope per worktree.
 * @param {{session_id?: string, agent_id?: string, agent_type?: string, agent_transcript_path?: string}} input Stop or SubagentStop JSON
 * @param {Record<string, string | undefined>} env HOME (the edit and baseline records) and CLAUDE_PROJECT_DIR (the lead's folder)
 * @returns {Promise<import('./contract.mjs').Scope[]>} [] when nothing changed, nothing is own, the folder is unknown or a repo names a filter
 */
export async function ownChange(input, env) {
  try {
    const session = input?.session_id;
    const agent = typeof input?.agent_id === 'string' && input.agent_id !== '' ? input.agent_id : LEAD;
    const ctx = { env, session, agent, recorded: recordedPaths(env, session, agent), baseline: baselineOf(env, session, agent) };
    const folder = gatedFolder(input ?? {}, env);
    const primary = folder === null ? null : worktreeOf(folder);
    const trees = [...(primary === null ? [] : [primary]), ...(agent === LEAD ? editedWorktrees(session, env, { except: primary }) : [])];
    const scopes = trees.map((tree) => gitScope(ctx, tree));
    if (primary === null && folder !== null) scopes.push(plainScope(ctx, folder, trees.map((tree) => realPathOf(tree.top))));
    return scopes.filter((scope) => scope !== null);
  } catch {
    return []; // a gate input that cannot be read is no change to check (commit-gate treats it the same way)
  }
}

/**
 * Every code file changed between `base` and the worktree of `top`: committed, uncommitted and untracked. For a land and a manual run.
 * @param {string} top any folder inside the worktree
 * @param {string} base the base commit (full hex id)
 * @returns {Promise<import('./contract.mjs').Scope>} a Scope, with empty `files` and `wide` when nothing changed
 * @throws {Error} a bad base, a folder that is not a git worktree, a base git does not have, or a repo that names a filter program
 */
export async function rangeChange(top, base) {
  assertCommit(base);
  const tree = worktreeOf(top);
  if (tree === null) throw new Error(`done-check scope: ${top} is not a git worktree`);
  if (namesFilterProgram(tree.top)) throw new Error('done-check scope: the repository names a filter program, git is not asked');
  const committed = diffPaths(tree.top, base);
  const dirty = dirtyEntries(tree.top);
  if (committed === null || dirty === null) throw new Error(`done-check scope: git could not compare ${tree.top} with ${base}`);
  const untracked = dirty.filter(({ field }) => field.startsWith('??')).map(({ rel }) => rel);
  return scopeFrom(realPathOf(tree.top), true, base, [...committed, ...untracked], true);
}

/** The line count of an untracked file as one range, [] for an empty one. */
function wholeFile(top, file) {
  const text = readPlainFile(join(top, file), MAX_HASHED_BYTES);
  const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  return lines === 0 ? [] : [[1, lines]];
}

/**
 * The lines of `file` that differ from `base` (committed, uncommitted or all of an untracked file), for the lint that looks at changed lines.
 * @param {string} top the worktree
 * @param {string} base the base commit (full hex id)
 * @param {string} file repo-relative path
 * @returns {Promise<[number, number][]>} 1-based inclusive ranges in file order; a pure deletion gives none
 * @throws {Error} a bad base or a failed git call (an answer of "no lines" would hide lint errors)
 */
export async function changedLines(top, base, file) {
  assertCommit(base);
  const diff = git(top, ['diff', '-U0', ...DIFF_FLAGS, base, '--', file]);
  if (diff === null) throw new Error(`done-check scope: git could not diff ${file} against ${base}`);
  const ranges = [...diff.matchAll(HUNK_HEADER)].map(([, start, count]) => [Number(start), Number(start) + Number(count ?? 1) - 1])
    .filter(([start, end]) => end >= start);
  if (diff !== '') return ranges;
  const untracked = git(top, ['ls-files', '-z', '--others', '--exclude-standard', '--', file]);
  if (untracked === null) throw new Error(`done-check scope: git could not list ${file}`);
  return untracked.split('\0').includes(file) ? wholeFile(top, file) : [];
}
