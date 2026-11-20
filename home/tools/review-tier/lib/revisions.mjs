// Purpose: turn what a caller names (the base of a lane, the two sides of a range, HEAD) into commits, once, for review-tier.
// Exports: laneOf(top, git) -> lane, commonDirOf(top), refuseAlteredHistory(top, commonDir), headOf(lane), baseOf(lane, requested) -> sha,
//   checkRange(lane, range) -> { range, read, base, tip }, recordedSha(lane, value, flag) -> sha, startAfterRebase(git, shas) -> sha.
// Invariants: the real repository (`lane.top`) is asked only for its common dir, the refusals below, and the sha behind a stem: HEAD, a
//   local branch `refs/heads/<name>`, each once per run (`lane.stems`). Everything else goes through the trusted reader (`lane.git`,
//   lib/trusted-git.mjs) and takes shas: that a sha names a commit, an ancestry suffix (`~2`, `^`), a merge base, an ancestor test. The
//   commits behind the stems are re-hashed (lib/verify-objects.mjs) before anything walks their parents, and the trees before a diff.
//   A name is read only as the local branch `refs/heads/<name>`; a full 40-character sha is itself. Git's own short-name lookup is never
//   used for a name: it takes a tag, `refs/<name>` or a file `$GIT_DIR/<name>` first, and the writer of a fix can make each of them
//   (security B3 of lane r7-delta). A name goes to git only behind `refs/heads/`, so one that starts with `-` is an unknown branch, never
//   an option; a name that starts with `refs/` is refused (it would be read as the branch `refs/heads/refs/...`: security N15).
//   A fix round takes no name at all: its commits are full shas from the lead's record (recordedSha). History that can be altered
//   outside the commits (grafts, replace refs, a shallow clone) is refused before anything is read (refuseAlteredHistory).
import { realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { UsageError, gitText, runGit } from '../../git-tidy/lib/git.mjs';
import { asData } from './brief-data.mjs';
import { verifyCommits, verifyTrees } from './verify-objects.mjs';

const BASE_FALLBACKS = ['main', 'master', 'develop'];
const BRANCH_REFS = 'refs/heads/';
const HEAD_REF = 'HEAD'; // read in the real repository only; the trusted reader gets its sha
const FULL_SHA = /^[0-9a-f]{40}$/;
const MAX_ECHOED_CHARS = 80; // a refused value is quoted in the error, cut to this length
const SIDE_PARTS = /^([^~^]+)((?:[~^]\d*)*)$/; // a name, then ancestry steps; git allows neither mark inside a ref name

/**
 * What a run reads from.
 * @param {string} top the real repository's top folder: asked for names only
 * @param {object} git the trusted reader: asked for everything else, by sha
 * @returns {{top: string, git: object, stems: Map<string, string | null>}} `stems`: the sha each ref was read as, so no ref is read twice
 */
export const laneOf = (top, git) => ({ top, git, stems: new Map() });

/** The repository's common git dir (the one linked worktrees share) as an absolute real path; its `objects` folder is what the trusted reader borrows. */
export const commonDirOf = (top) => realpathSync(resolve(top, gitText(top, ['rev-parse', '--git-common-dir'])));

/**
 * True when `sha` names a commit in the lane's objects (a tag object or a tree of that name is none). Only the object's type is asked:
 * whether its content is what its name says is the re-hash's question (lib/verify-objects.mjs), which names the object when it is not.
 */
const isCommit = (git, sha) => git.run(['cat-file', '-t', sha]).stdout.toString().trim() === 'commit';

/** The commit a ref of the real repository points at, read once per run, or null when the ref does not exist or names no commit. */
function shaOfRef(lane, args, ref) {
  if (!lane.stems.has(ref)) {
    const { status, stdout } = runGit(lane.top, [...args, ref]);
    const sha = stdout.trim();
    lane.stems.set(ref, status === 0 && FULL_SHA.test(sha) && isCommit(lane.git, sha) ? sha : null);
  }
  return lane.stems.get(ref);
}

/**
 * The commit HEAD is at, read once: every later call takes this sha, so nothing that moves or shadows HEAD during the run changes what is read.
 * @throws {UsageError} for a repository with no commit at HEAD
 */
export function headOf(lane) {
  const sha = shaOfRef(lane, ['rev-parse', '--verify', '--quiet'], HEAD_REF);
  if (sha === null) throw new UsageError('HEAD names no commit here: review-tier reads the lane that is checked out in its working folder');
  return sha;
}

/**
 * The sha of a base the caller or the fallback list names, or null. A name is read only as the local branch `refs/heads/<name>`, the ref
 * git-tidy lands on: a tag, `refs/<name>` or a file `$GIT_DIR/<name>` of the same name, which git's short-name lookup would take first,
 * is never the base (security B3 of lane r7-delta: one such ref moved the lane start and made a fix round lighter). A full sha is itself.
 */
function shaOfBase(lane, name) {
  if (name.startsWith('refs/')) throw new UsageError(`${asData(name.slice(0, MAX_ECHOED_CHARS))} starts with refs/: a name is read only as the local branch refs/heads/<name>, so this one would be the branch refs/heads/${asData(name.slice(0, MAX_ECHOED_CHARS))}. Pass the branch name alone (main, not refs/heads/main) or a full 40-character sha`);
  if (FULL_SHA.test(name)) return isCommit(lane.git, name) ? name : null;
  return shaOfRef(lane, ['show-ref', '--verify', '--hash'], `${BRANCH_REFS}${name}`);
}

/**
 * Where the lane starts: `--base` when given, else the one of main, master, develop that exists as a local branch. It is resolved
 * once, and every range of the run is built from the sha, so no ref made later or elsewhere can move it.
 * @param {object} lane laneOf(top, git)
 * @param {string | null} requested what `--base` got: a local branch name or a full 40-character sha
 * @returns {string} the base's full sha
 * @throws {UsageError} for a base that is no local branch and no full sha, for no fallback branch, and for more than one
 */
export function baseOf(lane, requested) {
  if (requested) {
    const sha = shaOfBase(lane, requested);
    if (sha === null) throw new UsageError(`unknown base ${asData(requested)}: --base takes a local branch (read as refs/heads/<name>, never a tag or another ref of that name) or a full 40-character sha`);
    return sha;
  }
  const found = BASE_FALLBACKS.filter((name) => shaOfBase(lane, name) !== null);
  if (found.length === 0) throw new UsageError('no base branch (main, master, develop); pass --base <branch>');
  if (found.length > 1) throw new UsageError(`more than one base branch exists here (${found.join(', ')}): name the base with --base <branch>, the one this lane lands on`);
  return shaOfBase(lane, found[0]);
}

/** Splits `a..b` or `a...b` into its sides (an empty right side is HEAD); anything else is a UsageError. */
function sidesOf(range) {
  const match = /^([^\s.][^\s]*?)\.{2,3}([^\s.]*[^\s]*)?$/.exec(range);
  if (match === null || /\.{4}/.test(range)) throw new UsageError(`bad range "${range}": use <a>..<b> or <a>...<b>`);
  return [match[1], match[2] || HEAD_REF];
}

const unknownSide = (side, range) => new UsageError(`unknown revision ${JSON.stringify(side)} in range ${JSON.stringify(range)}: a side is HEAD, a local branch (read as refs/heads/<name>, never a tag or another ref of that name) or a full 40-character sha, each with an optional ~N or ^N; for any other commit pass its full sha (git rev-parse <name>)`);

/**
 * One side of a caller's range, up to its stem: HEAD, a local branch or a full sha, read like the base (shaOfBase). A tag, `refs/<name>`
 * or a file `$GIT_DIR/<name>` of the same name, which git's own lookup takes first, is never read: one would change what a first review reads.
 * @returns {{side: string, stem: string, suffix: string}} `stem`: the sha behind the name; `suffix`: the ancestry steps still to apply
 */
function stemOfSide(lane, side, range) {
  const [, name, suffix] = SIDE_PARTS.exec(side) ?? [];
  const stem = name === undefined ? null : name === HEAD_REF ? shaOfRef(lane, ['rev-parse', '--verify', '--quiet'], HEAD_REF) : shaOfBase(lane, name);
  if (stem === null) throw unknownSide(side, range);
  return { side, stem, suffix };
}

/** The commit of a side: its ancestry suffix applied to the stem's sha, in the trusted reader (parents come from the checked commit objects). */
function shaOfSide(lane, { side, stem, suffix }, range) {
  const found = lane.git.run(['rev-parse', '--verify', '--quiet', `${stem}${suffix}^{commit}`]);
  if (found.status !== 0) throw unknownSide(side, range);
  return found.stdout.toString().trim();
}

/**
 * A caller's range with each side resolved once, so every read of the run and the printed range use the same commits. The commits behind
 * both sides are re-hashed before a suffix or the merge base walks them, and the trees that are compared before anything is read.
 * @returns {{ range: string, read: string, base: string, tip: string }} `range`: what is printed (a side given as HEAD stays the word
 *   HEAD, any other side is its sha); `read`: the same range of shas, the one git gets; `base`: where the range starts (the merge base
 *   of a three-dot range), and `tip`: the commit that was read (the tree new files are read from): the two shas a fix round is given
 * @throws {UsageError} for a text that is no range and for a side that is no HEAD, local branch or full sha
 */
export function checkRange(lane, range) {
  const stems = sidesOf(range).map((side) => stemOfSide(lane, side, range));
  verifyCommits(lane.git, stems.map(({ stem }) => stem));
  const [from, tip] = stems.map((stem) => shaOfSide(lane, stem, range));
  const dots = range.includes('...') ? '...' : '..';
  const fork = dots === '...' ? lane.git.run(['merge-base', from, tip]) : null;
  const base = fork?.status === 0 ? fork.stdout.toString().trim() : from;
  verifyTrees(lane.git, [base, tip], tip);
  const printed = stems.map(({ side }, at) => (side === HEAD_REF ? side : [from, tip][at]));
  return { range: `${printed[0]}${dots}${printed[1]}`, read: `${from}${dots}${tip}`, base, tip };
}

/**
 * A commit of a fix round (`--delta`, `--base`, `--rebased-onto`): the full sha from the lead's record. Nothing is looked up by name there:
 * git reads a short sha as a ref of that name first, so a tag named like the reviewed sha's first characters moved the delta past the fix (security B7).
 * @throws {UsageError} for anything but 40 hex digits, and for 40 hex digits that name no commit of this repository
 */
export function recordedSha(lane, value, flag) {
  if (!FULL_SHA.test(value)) throw new UsageError(`${flag} takes the full 40-character sha of a commit in a fix round, from the lead's own record: pass the output of \`git rev-parse <sha>\`, never a short sha or a name (git reads those as a ref of that name first); got ${JSON.stringify(value.slice(0, MAX_ECHOED_CHARS))}`);
  if (!isCommit(lane.git, value)) throw new UsageError(`${flag} ${value} names no commit of this repository: pass the full sha from the lead's own record of this lane (a sha of another clone, or one whose commit was pruned, cannot be read here)`);
  return value;
}

/**
 * Where a lane starts after its fix rebased it: `onto`, the base tip the fix was told to rebase onto, when the lane really sits on it,
 * else the old start (which reads more, never less). The start moves only when all three hold: the old start is an ancestor of `onto`
 * (the base only grew); `onto` is an ancestor of HEAD (the fix did rebase onto it); `onto` is no ancestor of, nor equal to, the reviewed
 * commit (it is no commit of the lane as it was reviewed: a start inside the lane would hide the lane's own commits below it).
 * That `onto` is a base tip the caller recorded itself is the caller's to check: no ref is read here.
 * @param {object} git the trusted reader; the four commits are already re-hashed
 * @param {{base: string, reviewed: string, onto: string | null, head: string}} shas full shas
 * @returns {string} the start to read from
 */
export function startAfterRebase(git, { base, reviewed, onto, head }) {
  if (onto === null || onto === base) return base;
  const isAncestor = (ancestor, commit) => git.flag(['merge-base', '--is-ancestor', ancestor, commit]);
  return isAncestor(base, onto) && isAncestor(onto, head) && !isAncestor(onto, reviewed) ? onto : base;
}

/**
 * Stops the run when this repository's history can be altered without changing a commit: a graft file, a replace ref or a shallow
 * clone makes git show other parents or other content than the commits hold, and none of them shows in a diff (security B5, B6).
 * @param {string} top the real repository's top folder
 * @param {string} commonDir commonDirOf(top)
 * @throws {UsageError} naming what was found and what to do
 */
export function refuseAlteredHistory(top, commonDir) {
  const grafts = join(commonDir, 'info', 'grafts');
  const found = [
    statSync(grafts, { throwIfNoEntry: false })?.size > 0 ? `a graft file (${grafts})` : '',
    gitText(top, ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/replace/']) !== '' ? 'a replace ref (git replace -l lists them)' : '',
    gitText(top, ['rev-parse', '--is-shallow-repository']) === 'true' ? 'a shallow history (git fetch --unshallow completes it)' : '',
  ].filter(Boolean);
  if (found.length > 0) throw new UsageError(`this repository has ${found.join(' and ')}: with it git can show other history than the commits hold, so nothing read here could be trusted. Remove it, or review by hand`);
}
