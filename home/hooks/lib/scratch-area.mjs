// Scratch areas of the `rm -r` rule (owner FR6, 2026-11-22: no popup for deletes inside the session's own temp area and `cs-test-*`
// folders; everywhere else it still asks). Read by lib/rm-paths.mjs (insideProject) and lib/other-deleters.mjs (checkOtherDeleter).
// A target outside the project runs unasked only when the path rm really deletes (deletedPath: links followed as the kernel follows
// them, `/tmp` read as `/private/tmp`, `$TMPDIR` as `/private/var/folders/...`) is
// - below this session's own folder `<temp root>/claude-<uid>/<project>/<session id>/` (the scratchpad and its neighbours), where the
//   session id is the hook input's `session_id`, else the environment's `CLAUDE_CODE_SESSION_ID`; the session folder itself, the
//   folders above it, another session's folder and any other temp folder ask; with no usable session id every temp folder asks; or
// - in or under a folder named `cs-test-*` (the deepest one in the path) that is not home and does not hold home, both compared as
//   real paths.
// A glob folder part over a folder that holds a link, a link that leads nowhere yet, a link loop or an unreadable folder is not followed:
// the rm asks. Paths split at `/` only, and also at `\` on Windows (on macOS and Linux a `\` is part of a name).
// Links the line itself makes: the file system is read before the line runs, so a link a command of the same line makes (`mv`,
// `cp -a`, `tar -x`, `git clone`, a script: anything but the short list of commands that cannot make one) is not there yet. Once the
// line holds such a command, no scratch exemption is given on that line, whether the command comes before the delete (claimScratchDelete
// refuses) or after it (linkMakerReason asks: a loop, a pipe or `&` may run it first).
// Exports: deletedPath(written, known) -> real path | null; inScratchArea(path, sessionId); linkState(work, pass); claimScratchDelete(links, target);
// linkMakerReason(cmd, args, links, deletedBefore) -> reason | undefined; followsNoFolderBelow(rest); isUnder(root, target);
// sameFile(a, b) (both re-exported by lib/rm-paths.mjs).
// Invariants: reads the file system only through realpath, lstat and a folder listing (cached per line in work.realPaths); writes
// nothing to disk; the only state it changes is the line's work budget (realPaths, linkStates).
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { destructive, shown } from './verdict.mjs';

const CS_TEST_FOLDER = /^cs-test-/; // the probe folders the setup's rules name (home/CLAUDE.md "Probes")
const CLAUDE_TREE = 'claude-'; // Claude Code keeps `<temp>/claude-<uid>/<project>/<session>/`: the scratchpad and the task output
const CLAUDE_TREE_FOLDER = /^claude-\d+$/;
const SESSION_DEPTH = 3; // claude-<uid>, its project folder, the session folder: only what lies below these three is the session's own
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/; // a UUID in practice; never `.`, `..` or a path
const GLOB_CHAR = /[*?[]|[@!+]\(/; // where a glob starts: such a part is a pattern, not one folder
const PATH_SEPARATORS = process.platform === 'win32' ? /[\\/]+/ : /\/+/;
const ENDS_AS_FOLDER = process.platform === 'win32' ? /[\\/]\.?$/ : /\/\.?$/; // `x/` and `x/.`: rm goes through a link x to what it leads to

/** True when `target` lies strictly below `root` (both absolute). */
export const isUnder = (root, target) => {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};
/** True when two paths name the same file: case-folded on Windows. */
export const sameFile = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The real path, the path itself when it is not there, or null when where it leads is unknown. */
function readReal(path) {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if (error.code === 'ENOTDIR') return path; // a folder part is a file: rm fails there and deletes nothing
    if (error.code !== 'ENOENT') return null; // a link loop, no access, a NUL byte: not followed, so the rm asks
  }
  // not there, or a link whose target is not there yet (a later command of the line may make it): only a plain miss is read as written
  return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ? null : path;
}

const realOf = (path, known) => {
  if (!known.has(path)) known.set(path, readReal(path));
  return known.get(path);
};

const LINK_FREE_KEY = '\u0000links'; // a NUL never occurs in a path, so this cache key cannot meet a real path

/** True when no entry of the folder is a link, or the folder is not there: a glob part there then leads to no other place. */
function holdsNoLinks(folder, known) {
  const key = folder + LINK_FREE_KEY;
  if (!known.has(key)) known.set(key, readLinkFree(folder) ? folder : null);
  return known.get(key) !== null;
}

function readLinkFree(folder) {
  try {
    return !readdirSync(folder, { withFileTypes: true }).some((entry) => entry.isSymbolicLink());
  } catch (error) {
    return error.code === 'ENOENT' || error.code === 'ENOTDIR'; // nothing there for the glob to match; no access: unknown
  }
}

/**
 * The path a recursive rm of `written` really deletes. Each folder part is followed as the kernel follows it, `..` included (`$S/link/..` is
 * the parent of the link's target); the last part only when the target ends in `/` or `/.` (rm removes a link itself, not what it leads to).
 * A glob folder part (`/tmp/x/**` + `/*`) is read only in a folder that holds no link, and nothing below it is followed again.
 * @param {string} written an absolute target as the line names it, not normalised: its `..` parts are read here
 * @param {Map<string, string | null>} known the real paths read so far on this line (modified)
 * @returns {string | null} the physical path, or null when a folder part cannot be followed (the rm then asks)
 */
export function deletedPath(written, known) {
  const { root } = parse(written);
  const parts = written.slice(root.length).split(PATH_SEPARATORS).filter((part) => part !== '' && part !== '.');
  const followsLast = ENDS_AS_FOLDER.test(written);
  let [here, belowGlob] = [realOf(root, known), false];
  for (const [at, part] of parts.entries()) {
    const follows = at < parts.length - 1 || followsLast;
    if (here === null) return null;
    if (part === '..' || !follows) here = part === '..' ? dirname(here) : join(here, part);
    else if (belowGlob) return null; // `*/x/`: the x of every match would have to be read
    else if (GLOB_CHAR.test(part)) [here, belowGlob] = holdsNoLinks(here, known) ? [join(here, part), true] : [null, false];
    else here = realOf(join(here, part), known);
  }
  return here;
}

const WRITTEN_TEMP_ROOTS = ['/tmp', '/private/tmp', tmpdir()];
/** The temp roots as written and as real paths: on macOS `/tmp` is `/private/tmp` and `$TMPDIR` lies under `/private/var/folders`. */
const TEMP_ROOTS = [...new Set([...WRITTEN_TEMP_ROOTS, ...WRITTEN_TEMP_ROOTS.map(readReal)].filter((root) => root !== null))];

/**
 * This session's id: the hook input's session_id when it is a string (documented for every hook event), else the environment's
 * CLAUDE_CODE_SESSION_ID; undefined when the one used cannot name a folder.
 */
function ownSessionId(fromInput) {
  const id = typeof fromInput === 'string' ? fromInput : process.env.CLAUDE_CODE_SESSION_ID;
  return typeof id === 'string' && SESSION_ID.test(id) ? id : undefined;
}

/** The parts below a temp root lie below this session's own folder `claude-<uid>/<project>/<session id>/`, with no glob above it. */
function inOwnSession(parts, sessionId) {
  const session = ownSessionId(sessionId);
  if (session === undefined || parts.length <= SESSION_DEPTH) return false;
  const [tree, projectFolder, sessionFolder] = parts;
  return CLAUDE_TREE_FOLDER.test(tree) && !GLOB_CHAR.test(projectFolder) && sessionFolder === session;
}

/** True when the folder is home or holds it, home read as written and as its real path. */
function holdsHome(folder) {
  const homes = [resolve(homedir()), readReal(resolve(homedir()))].filter((home) => home !== null);
  return homes.some((home) => sameFile(folder, home) || isUnder(folder, home));
}

/** True when a path part is, or as a glob may match, a `claude-<uid>` folder: a glob's literal start fits `claude-`. */
function mayBeClaudeTree(part) {
  if (!GLOB_CHAR.test(part)) return CLAUDE_TREE_FOLDER.test(part);
  const literal = part.split(GLOB_CHAR, 1)[0];
  return CLAUDE_TREE.startsWith(literal) || literal.startsWith(CLAUDE_TREE);
}

/** The parts of the path below a temp root when they start in Claude Code's tree (`claude-<uid>/...`, or a glob that may match it). */
function claudeTreeParts(path) {
  for (const root of TEMP_ROOTS.filter((temp) => isUnder(temp, path))) {
    const parts = relative(root, path).split(PATH_SEPARATORS);
    if (mayBeClaudeTree(parts[0])) return parts;
  }
  return undefined;
}

/**
 * True when the physical path an rm deletes is in a scratch area (FR6, see the header): below this session's own folder, or in or under
 * a `cs-test-*` folder that is not home and does not hold it. Inside Claude Code's tree a `cs-test-*` folder counts only below a session
 * folder, so one that holds the tree (a test's temp root) never frees another session's folder.
 * @param {string} path the result of deletedPath
 * @param {unknown} [sessionId] the hook input's session_id (ownSessionId: the environment's id is the fallback)
 */
export function inScratchArea(path, sessionId) {
  const tree = claudeTreeParts(path);
  if (tree !== undefined && inOwnSession(tree, sessionId)) return true;
  const parts = path.split(PATH_SEPARATORS);
  const firstFree = tree === undefined ? 0 : parts.length - tree.length + SESSION_DEPTH; // the first part below a session folder
  const at = parts.findLastIndex((part) => CS_TEST_FOLDER.test(part));
  return at !== -1 && at >= firstFree && !holdsHome(resolve(parts.slice(0, at + 1).join(sep)));
}

/**
 * True when the rest of a target after a folder the line made itself (`$(mktemp -d)`) follows no folder below it: `''`, `/`, `/x`. A
 * deeper target (`/x/y`, `/x/`, `/..`) goes through a part that a command of the line may have made a link.
 * @param {string} rest the target after the folder's own path
 */
export function followsNoFolderBelow(rest) {
  const parts = rest.split(PATH_SEPARATORS).filter((part) => part !== '' && part !== '.');
  return parts.length === 0 || (parts.length === 1 && parts[0] !== '..' && !ENDS_AS_FOLDER.test(rest));
}

/**
 * The links one reading of the line may make: the first command seen so far that may make one, and the first scratch delete let run.
 * Kept per parser (`pass`: the guard reads each line with two parsers, and the second must not inherit what the first saw after a
 * command, or `rsync --delete` would refuse its own destination), on the line's budget, so nested scripts of one reading share it.
 * @param {{linkStates?: Map<unknown, {linkMaker?: string, scratchDelete?: string}>}} work the line's budget (lib/rm-paths.mjs newWork; modified)
 * @param {unknown} pass the parser of this reading (the guard's env.parse)
 * @returns {{linkMaker?: string, scratchDelete?: string}} the state of that reading (modified by claimScratchDelete and linkMakerReason)
 */
export function linkState(work, pass) {
  work.linkStates ??= new Map();
  if (!work.linkStates.has(pass)) work.linkStates.set(pass, {});
  return work.linkStates.get(pass);
}

/**
 * Whether a delete in a scratch area may run unasked as far as the line's own links go: only while no command of the line seen so far
 * may make a link. The first target that gets the exemption is kept, so a command that may make links later on the line asks.
 * @param {{linkMaker?: string, scratchDelete?: string}} links the reading's state (linkState; modified)
 * @param {string} target the target as written
 * @returns {boolean} true when the exemption holds
 */
export function claimScratchDelete(links, target) {
  if (links.linkMaker !== undefined) return false;
  links.scratchDelete ??= target;
  return true;
}

// commands that make no link (cmd as lib/command-of.mjs names it); any other command, an unknown name included, may make one
const NO_LINK_COMMANDS = new Set(['rm', 'rmdir', 'rimraf', 'mkdir', 'touch', 'cd', 'pushd', 'popd', 'pwd', 'echo', 'printf', 'true', 'false',
  ':', 'test', '[', '[[', ']]', 'for', 'done', 'fi', 'esac', 'export', 'unset', 'read', 'local', 'declare', 'typeset', 'readonly', 'set',
  'shift', 'wait', 'sleep', 'mktemp', 'ls', 'cat', 'stat', 'du', 'df', 'wc', 'head', 'tail', 'grep', 'basename', 'dirname', 'realpath',
  'readlink', 'date', 'which', 'type', 'chmod']);
const FIND_RUNS = new Set(['-exec', '-execdir', '-ok', '-okdir']);

/** True when the command may make a link: anything not in NO_LINK_COMMANDS, and a find that runs a command other than rm. */
function mayMakeLinks(cmd, args) {
  if (cmd === 'find') return args.some((word, at) => FIND_RUNS.has(word) && args[at + 1] !== 'rm');
  return !NO_LINK_COMMANDS.has(cmd);
}

/**
 * Notes on the line's budget that this command may make links (claimScratchDelete then refuses), and asks when a delete earlier on the
 * line was let run as a scratch delete: a loop, a pipe or `&` may run this command before that delete reaches the path.
 * @param {string} cmd the command name (lib/command-of.mjs)
 * @param {string[]} args its words
 * @param {{linkMaker?: string, scratchDelete?: string} | undefined} links the reading's state (linkState; modified); undefined: nothing is tracked
 * @param {string | undefined} deletedBefore links.scratchDelete as it was before this command's own deletes were judged
 * @returns {string | undefined} the ask reason, or undefined
 */
export function linkMakerReason(cmd, args, links, deletedBefore) {
  if (links === undefined || cmd === undefined || !mayMakeLinks(cmd, args)) return undefined;
  links.linkMaker ??= cmd;
  if (deletedBefore === undefined) return undefined;
  return destructive(`a delete in a scratch area (${shown(deletedBefore)}) on a line whose ${shown(cmd)} may make a link the delete goes through; `
    + 'the guard cannot see where it points');
}
