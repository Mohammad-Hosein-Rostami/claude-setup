// Purpose: turn what a caller names (the base of a lane, the two sides of a range) into commits, once, for review-tier.
// Exports: baseOf(top, requested) -> sha, checkRange(top, range) -> { range, endRevision }.
// Invariants: a name is read only as the local branch `refs/heads/<name>`; a full 40-character sha is itself; HEAD is HEAD. Git's own
//   short-name lookup is never used for a name: it takes a tag, `refs/<name>` or a file `$GIT_DIR/<name>` first, and the writer of a fix
//   can make each of them (security B3 of lane r7-delta). Every range the tool reads and prints is built from the resolved shas.
//   A name goes to git only behind `refs/heads/`, so one that starts with `-` is an unknown branch, never an option.
import { UsageError, runGit } from '../../git-tidy/lib/git.mjs';
import { asData } from './brief-data.mjs';

const BASE_FALLBACKS = ['main', 'master', 'develop'];
const BRANCH_REFS = 'refs/heads/';
const FULL_SHA = /^[0-9a-f]{40}$/;
const SIDE_PARTS = /^([^~^]+)((?:[~^]\d*)*)$/; // a name, then ancestry steps; git allows neither mark inside a ref name

/**
 * The sha of a base the caller or the fallback list names, or null. A name is read only as the local branch `refs/heads/<name>`, the ref
 * git-tidy lands on: a tag, `refs/<name>` or a file `$GIT_DIR/<name>` of the same name, which git's short-name lookup would take first,
 * is never the base (security B3 of lane r7-delta: one such ref moved the lane start and made a fix round lighter). A full sha is itself.
 */
function shaOfBase(top, name) {
  const args = FULL_SHA.test(name) ? ['rev-parse', '--verify', '--quiet', `${name}^{commit}`] : ['show-ref', '--verify', '--hash', `${BRANCH_REFS}${name}`];
  const { status, stdout } = runGit(top, args);
  return status === 0 ? stdout.trim() : null;
}

/**
 * Where the lane starts: `--base` when given, else the one of main, master, develop that exists as a local branch. It is resolved
 * once, and every range of the run is built from the sha, so no ref made later or elsewhere can move it.
 * @param {string} top the repository's top folder
 * @param {string | null} requested what `--base` got: a local branch name or a full 40-character sha
 * @returns {string} the base's full sha
 * @throws {UsageError} for a base that is no local branch and no full sha, for no fallback branch, and for more than one
 */
export function baseOf(top, requested) {
  if (requested) {
    const sha = shaOfBase(top, requested);
    if (sha === null) throw new UsageError(`unknown base ${asData(requested)}: --base takes a local branch (read as refs/heads/<name>, never a tag or another ref of that name) or a full 40-character sha`);
    return sha;
  }
  const found = BASE_FALLBACKS.filter((name) => shaOfBase(top, name) !== null);
  if (found.length === 0) throw new UsageError('no base branch (main, master, develop); pass --base <branch>');
  if (found.length > 1) throw new UsageError(`more than one base branch exists here (${found.join(', ')}): name the base with --base <branch>, the one this lane lands on`);
  return shaOfBase(top, found[0]);
}

/** Splits `a..b` or `a...b` into its sides (an empty right side is HEAD); anything else is a UsageError. */
function sidesOf(range) {
  const match = /^([^\s.][^\s]*?)\.{2,3}([^\s.]*[^\s]*)?$/.exec(range);
  if (match === null || /\.{4}/.test(range)) throw new UsageError(`bad range "${range}": use <a>..<b> or <a>...<b>`);
  return [match[1], match[2] || 'HEAD'];
}

/**
 * One side of a caller's range as a commit. It is read like the base (shaOfBase): HEAD, a local branch or a full sha, each with an optional
 * ancestry suffix (`~2`, `^`) applied to the resolved commit. A tag, `refs/<name>` or a file `$GIT_DIR/<name>` of the same name, which
 * git's own lookup takes first, is never read: one would change what a lane's first review reads. HEAD stays `HEAD`, any other side is its sha.
 */
function shaOfSide(top, side, range) {
  const [, stem, suffix] = SIDE_PARTS.exec(side) ?? [];
  const start = stem === undefined ? null : stem === 'HEAD' ? stem : shaOfBase(top, stem);
  const found = start === null ? null : runGit(top, ['rev-parse', '--verify', '--quiet', `${start}${suffix}^{commit}`]);
  if (found === null || found.status !== 0) throw new UsageError(`unknown revision ${JSON.stringify(side)} in range ${JSON.stringify(range)}: a side is HEAD, a local branch (read as refs/heads/<name>, never a tag or another ref of that name) or a full 40-character sha, each with an optional ~N or ^N; for any other commit pass its full sha (git rev-parse <name>)`);
  return side === 'HEAD' ? side : found.stdout.trim();
}

/**
 * A caller's range with each side resolved once (shaOfSide), so every read of the run and the printed range use the same commits.
 * @returns {{ range: string, endRevision: string }} the range to read and print, and its right side (the tree the new files are read from)
 * @throws {UsageError} for a text that is no range and for a side that is no HEAD, local branch or full sha
 */
export function checkRange(top, range) {
  const [left, right] = sidesOf(range).map((side) => shaOfSide(top, side, range));
  return { range: `${left}${range.includes('...') ? '...' : '..'}${right}`, endRevision: right };
}
