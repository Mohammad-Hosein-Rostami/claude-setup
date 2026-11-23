// Which files a done-check looks at: the code files one agent, the lead or a land changed in a worktree, the base they are compared with,
// and a key that is the same for the same change before and after its commit (design section 3.1 and 6).
// Exports: ownChange(input, env) -> Scope[] (one per worktree; [] = nothing to check), rangeChange(top, base) -> Scope (base..worktree, for
//   land and manual runs), changedLines(top, base, file) -> [start, end][] (1-based, both ends inclusive, sorted, pure deletions left out),
//   UNSUPPORTED_CODE (file extension -> language name), unsupportedLanguages(paths) -> [{ language, files }].
// Rules (the tests in tests/done-check-scope.test.mjs fix the ones the design leaves open):
// - Base = the HEAD the agent or lead had at its first tool call (lib/dirty-baseline.mjs `baselineOf`), only when that baseline was taken in
//   the same worktree and the commit still exists. No baseline, an old one without head, an unreadable store, a base git cannot find or a
//   baseline taken in another folder: the worktree's HEAD is the base, and only uncommitted and untracked files of this stopper's own are
//   seen. So a test its uncommitted edit breaks, and that passes at HEAD, is new and blocks (the lead's decision of 2026-11-22: a lead in ~
//   or an agent started in a folder that is not git is still held to its own break). A worktree always has a HEAD (worktreeOf gives none
//   before the first commit), so base null is left only for a Scope a caller builds itself.
// - A folder that is not git gives no Scope of its own (no base, nothing a check could judge; the lead's home folder was 42% of all runs,
//   each one `review: needed` that nobody could act on). Only git worktrees are checked.
// - A subagent owns every file changed between base and its worktree (committed or not), plus untracked ones. Of the uncommitted files it
//   owns those it recorded (lib/own-edits.mjs) or that changed since its baseline (a Bash command made them) and that
//   hooks/lib/change-owner.mjs `ownBashEntries` keeps as its own: the one ownership rule commit-gate uses, so a file only another, older
//   session's closed call window claims is left out; a path of its commits since the base never is. An unreadable log, the deadline or an
//   error keeps the file own (still checked). In its own worktree the lead owns the files recorded for its session (that set also holds
//   the files its agents recorded there, as commit-gate sees it): land-lane moves HEAD, so a landed lane is not the lead's.
// - Beside its own worktree a stopper gets one Scope per worktree holding a file it recorded itself (`ownWorktrees` over `pathsRecordedBy`),
//   and owns there only those files: the lead is never given an agent's lane worktree it did not edit in, where half-finished work would
//   block it for failures that are not its own. One Scope per worktree, not per repository: two lane worktrees of one repo hold two
//   changes, and a worktree nested in another (`.claude/worktrees/<lane>`) is its own.
// - Code files: ts tsx js jsx mjs cjs mts cts vue go, and the scripts in a `.githooks/` folder (no extension). `named`: any other changed file
//   (markdown, json, ...) that a test-looking file names (lib/related.mjs `pathsNamedByTests`), so a test that reads a text file is run when
//   the text changes, and a Go data file (lib/go-plan.mjs `goDataFiles`: below a folder of .go files in a Go module, not Markdown); a
//   change with no code and nothing named stays no change. `wide`: package.json, lockfiles, tsconfig*.json, vitest, jest and eslint
//   config, go.mod, go.sum, go.work and go.work.sum; a wide file
//   is never also in `files`. `unsupported`: a changed file of a language done-check has no checks for (UNSUPPORTED_CODE: `.py`, `.rs`,
//   ...), never checked but never counted as no change either: a change of only such files still gives a Scope, so the line says
//   `not run (no python support: 3 files)` instead of `no code change`. They are left out of the key (nothing checks them, so an edit
//   to them alone must not re-run the checks of the rest). A change with none of these gives no Scope (ownChange) and an empty Scope
//   (rangeChange). A deleted file is listed
//   (a deletion can break its importers), so a consumer checks that a file exists before it hands it to a tool.
// - Paths are repo-relative with `/`. Scope.key = sha256 of the base and the sorted paths with their worktree content hashes; the caller that
//   has a plan mixes the plan fingerprint in. Content, not commit state, so a commit does not change it; a moved base does.
// Invariants: every git call goes through hooks/lib/gated-folder.mjs `runGit` (hardened, no repository program) with fixed flags, `-z` for
//   lists and `--literal-pathspecs`; a file name is only ever an argument after `--`, never an option and never in a shell; a repo that names
//   a filter program is not asked (git would run it): ownChange gives [], rangeChange throws so a land fails closed. An empty tree costs one
//   `rev-parse` pair and one `status`, no more. ownChange never throws; rangeChange and changedLines throw on a bad base or a failed git call.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { moveContext } from '../../../hooks/lib/base-moves.mjs';
import { ownBashEntries } from '../../../hooks/lib/change-owner.mjs';
import { baselineOf, changedSinceBaseline } from '../../../hooks/lib/dirty-baseline.mjs';
import { gatedFolder, gitOut, namesFilterProgram, worktreeOf } from '../../../hooks/lib/gated-folder.mjs';
import { LEAD, pathsRecordedBy, realPathOf, recordedPaths, statusEntries } from '../../../hooks/lib/own-edits.mjs';
import { readPlainFile } from '../../../hooks/lib/plain-file.mjs';
import { GO_FILE, goDataFiles, isGoWide } from './go-plan.mjs';
import { pathsNamedByTests } from './related.mjs';

const GIT_TIMEOUT_MS = 20_000; // one git call; a hung repo must not eat the stop deadline
const MAX_OWN_WORKTREES = 5; // worktrees one stop checks beside its own; each one's checks share the one stop deadline
const MAX_FOLDERS_ASKED = 30; // folders of the stopper's recorded files asked for their worktree, newest edit first
const MAX_HASHED_BYTES = 8 * 1024 * 1024; // a code file over this is stamped by size and time instead of content
const STATUS_PATH_AT = 3; // a porcelain entry is `XY <path>`
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CODE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|vue)$/i;
const GIT_HOOK_SCRIPT = /(?:^|\/)\.githooks\/[^/]+$/;
const WIDE_FILE = /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|tsconfig(?:\.[^/]*)?\.json|(?:vitest|jest)\.(?:config|workspace)\.[^/]+|eslint\.config\.[^/]+|\.eslintrc(?:\.[^/]+)?)$/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all'];

/** Code of languages done-check has no checks for: file extension (lower case) -> the language name the line shows. */
export const UNSUPPORTED_CODE = Object.freeze({ py: 'python', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', rb: 'ruby', php: 'php', cs: 'c#', c: 'c', h: 'c', cc: 'c++', cpp: 'c++', hpp: 'c++', scala: 'scala', dart: 'dart' });

const git = (top, args) => gitOut(top, ['--literal-pathspecs', ...args], GIT_TIMEOUT_MS);
const isWide = (path) => WIDE_FILE.test(basename(path)) || isGoWide(path);
const isCode = (path) => (CODE_FILE.test(path) || GO_FILE.test(path) || GIT_HOOK_SCRIPT.test(path)) && !path.split('/').includes('node_modules');
const isOther = (path) => !isWide(path) && !isCode(path) && !path.split('/').includes('node_modules');

/** The language of an unsupported code file (UNSUPPORTED_CODE), or null for any other path (and anything under node_modules). */
function languageOf(path) {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return Object.hasOwn(UNSUPPORTED_CODE, extension) && !path.split('/').includes('node_modules') ? UNSUPPORTED_CODE[extension] : null;
}
const isUnsupported = (path) => isOther(path) && languageOf(path) !== null;

/**
 * The unsupported code files of `paths` per language, for the line (`no python support: 3 files`, `python not run`).
 * @param {string[]} paths repo-relative paths (a Scope's `unsupported`)
 * @returns {{ language: string, files: number }[]} one entry per language that has a file, sorted by language name
 */
export function unsupportedLanguages(paths) {
  const counts = new Map();
  for (const path of paths) {
    const language = languageOf(path);
    if (language !== null) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts].sort(([left], [right]) => (left < right ? -1 : 1)).map(([language, files]) => ({ language, files }));
}

/** The changed non-code files that count: those a test file names, and Go data files (testdata, embedded files of a Go package). */
function namedOf(top, others) {
  const named = pathsNamedByTests(top, others);
  const goData = goDataFiles(top, others).filter((path) => !named.includes(path));
  return [...named, ...goData];
}

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

/** The Scope of `paths` (repo-relative); null when it holds no code, no wide file, nothing `named` or unsupported and `keepEmpty` is false. */
function scopeFrom(top, isGit, base, paths, { named = [], keepEmpty = false } = {}) {
  const unique = [...new Set(paths)].filter((path) => !path.split('/').includes('node_modules'));
  const wide = unique.filter(isWide).sort();
  const files = unique.filter((path) => !isWide(path) && isCode(path)).sort();
  const namedFiles = unique.filter((path) => isOther(path) && named.includes(path)).sort();
  const unsupported = unique.filter(isUnsupported).sort();
  if (!keepEmpty && files.length === 0 && wide.length === 0 && namedFiles.length === 0 && unsupported.length === 0) return null;
  return { top, git: isGit, base, files, wide, named: namedFiles, unsupported, key: changeKey(base, top, [...files, ...wide, ...namedFiles]) };
}

/** Files changed between `base` and the worktree (tracked, staged or not), or `upTo` (`HEAD`); null when git cannot say. */
function diffPaths(top, base, upTo = []) {
  const out = git(top, ['diff', '--name-only', '-z', ...DIFF_FLAGS, base, ...upTo, '--']);
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
 * Of the entries an agent's Bash command may have made, the ones that stay its own (hooks/lib/change-owner.mjs `ownBashEntries`, as
 * commit-gate.mjs uses it). The call-window log is read once per stop, on the first worktree that has such an entry; any error keeps
 * every entry own, so a doubt never takes a file out of the check.
 */
function ownBashMade(ctx, top, entries) {
  if (entries.length === 0) return entries;
  try {
    ctx.shared.calls ??= moveContext(ctx.input, ctx.env, top, ctx.agent);
    return ownBashEntries({ ...ctx.shared.calls, top, takenMs: ctx.baseline?.takenMs ?? null }, entries);
  } catch {
    return entries; // fail closed: the agent is still checked on every file it may have made
  }
}

/**
 * Of the changed paths, the ones this session or agent owns. An agent's paths in `committed` (its commits since the base) always count;
 * a dirty one counts when recorded or changed since the baseline and not only another session's (ownBashMade); the lead: recorded only.
 */
function ownedPaths(ctx, top, changed, dirty, committed) {
  const isRecorded = (rel) => ctx.recorded.has(join(top, rel));
  if (ctx.agent === LEAD) return changed.filter(isRecorded);
  const dirtyRel = new Set(dirty.map(({ rel }) => rel));
  const unrecorded = dirty.filter(({ rel }) => !isRecorded(rel));
  const byBash = new Set(ownBashMade(ctx, top, changedSinceBaseline(ctx.env, ctx.session, ctx.agent, top, unrecorded)).map(({ path }) => path));
  const dirtyOwn = new Set(dirty.filter(({ rel, path }) => isRecorded(rel) || byBash.has(path)).map(({ rel }) => rel));
  return changed.filter((rel) => !dirtyRel.has(rel) || committed.has(rel) || dirtyOwn.has(rel));
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
  let committedOwn = new Set(); // paths of the commits since the base: always the agent's
  if (base !== null && base !== head) {
    const committed = diffPaths(tree.top, base);
    if (committed === null) base = null; // the base commit is gone: the uncommitted change is compared with HEAD below
    else changed = [...committed, ...dirty.filter(({ field }) => field.startsWith('??')).map(({ rel }) => rel)];
    if (committed !== null) committedOwn = new Set(diffPaths(tree.top, base, ['HEAD']) ?? changed); // git fails: all own
  }
  base ??= COMMIT_ID.test(head) ? head : null; // no recorded base: HEAD, so a test the uncommitted change breaks is still new
  const named = namedOf(top, changed.filter(isOther));
  const relevant = [...changed.filter((rel) => isCode(rel) || isWide(rel) || isUnsupported(rel)), ...named];
  if (relevant.length === 0) return null;
  return scopeFrom(top, true, base, ownedPaths(ctx, top, relevant, dirty, committedOwn), { named });
}

/** True when `folder` is in worktree `top` itself, not in a worktree or repository nested below it (a folder there holds a `.git`). */
function isInWorktree(folder, top) {
  if (folder !== top && !folder.startsWith(`${top}${sep}`)) return false;
  for (let dir = folder; dir !== top; dir = dirname(dir)) if (existsSync(join(dir, '.git'))) return false;
  return true;
}

/**
 * The worktrees holding `files` (real paths, oldest first), newest edit first, at most MAX_OWN_WORKTREES, `primary` left out. One per
 * worktree, never one per repository (gated-folder.mjs editedWorktrees, which git-tidy-gate uses, keeps one per repository). git runs only
 * in the folder of a recorded file; a folder inside a worktree already found is not asked again, a folder that is gone is skipped.
 */
function ownWorktrees(files, primary) {
  const found = [];
  let asked = 0;
  for (const file of [...files].reverse()) {
    if (found.length >= MAX_OWN_WORKTREES || asked >= MAX_FOLDERS_ASKED) break;
    const folder = dirname(file);
    const known = primary === null ? found : [primary, ...found];
    if (known.some(({ top }) => isInWorktree(folder, top)) || !existsSync(folder)) continue;
    asked += 1;
    const tree = worktreeOf(folder);
    if (tree !== null && !known.some(({ top }) => top === tree.top)) found.push(tree);
  }
  return found;
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
    const ctx = { input, env, session, agent, shared: { calls: null }, recorded: recordedPaths(env, session, agent), baseline: baselineOf(env, session, agent) };
    const folder = gatedFolder(input ?? {}, env);
    const primary = folder === null ? null : worktreeOf(folder);
    // Beside its own worktree a stopper is judged only on the files it edited itself: never an agent's lane for the lead.
    const ownCtx = { ...ctx, recorded: pathsRecordedBy(env, session, agent) };
    const beside = ownWorktrees(ownCtx.recorded, primary);
    const scopes = [...(primary === null ? [] : [gitScope(ctx, primary)]), ...beside.map((tree) => gitScope(ownCtx, tree))];
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
  const realTop = realPathOf(tree.top);
  const paths = [...committed, ...untracked];
  return scopeFrom(realTop, true, base, paths, { named: namedOf(realTop, paths.filter(isOther)), keepEmpty: true });
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
