// Purpose: the one way review-tier reads commits, trees, diffs and file texts: git run in an empty repository of the tool's own, which
//   borrows the lane's objects and nothing else of the lane.
// Exports: MIN_GIT, TRUSTED_FLAGS, trustedEnvironment(parent, gitDir, objectsDir), alternatesEntry(path), refuseOldGit(versionText),
//   openTrustedGit(objectsDir) -> { run, bytes, text, flag, close }.
// Why: the writer of a fix is the same OS user as the tool and can write the lane's git dir (config, info/, refs, index, commit-graph),
//   its working tree and the user's own git files. Four security rounds each found one more of those that changed what a review read
//   (lane r7-delta, B8-B10, S7, F1). Here none of them is read: the repository is a fresh bare one in a temp folder, the environment is
//   rebuilt, and the lane's object folder is the only thing borrowed (lib/verify-objects.mjs re-hashes what is read from it).
// Invariants: no shell; every call runs in the temp folder with the same flags and environment; only shas go in (the temp repository has
//   no ref and an unborn HEAD, so a name fails); the temp folder is removed by close(), which the CLI calls in a `finally`.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { UsageError } from '../../git-tidy/lib/git.mjs';

const MAX_OUTPUT_BYTES = 256 << 20;
const TEMP_PREFIX = 'review-tier-git-';
/** The oldest git the clean environment works with: GIT_CONFIG_GLOBAL is read from 2.32 on (an older git would read the user's config). */
export const MIN_GIT = [2, 32];
const GIT_VERSION = /^git version (\d+)\.(\d+)/;
/**
 * Set on every call, whatever the temp repository's own config says (`git init` writes core.precomposeUnicode there on macOS):
 * commitGraph and multiPackIndex: parents and object places come from the objects, never from a file beside them the writer can forge (B8);
 * precomposeUnicode: a path is its bytes, an NFD name is not folded into its NFC twin (B10); quotePath: paths are printed as they are;
 * attributesFile: no attributes from `$XDG_CONFIG_HOME/git/attributes`, which git reads with no config at all (F1).
 */
export const TRUSTED_FLAGS = [
  '-c', 'core.commitGraph=false',
  '-c', 'core.multiPackIndex=false',
  '-c', 'core.precomposeUnicode=false',
  '-c', 'core.quotePath=false',
  '-c', `core.attributesFile=${devNull}`,
];

/**
 * One entry of GIT_ALTERNATE_OBJECT_DIRECTORIES. Git splits the value at the path delimiter and C-unquotes an entry that starts with a
 * double quote, so a folder whose path holds the delimiter (or starts with a quote) is written quoted; any other path is written as it is.
 */
export function alternatesEntry(path) {
  if (!path.includes(delimiter) && !path.startsWith('"')) return path;
  return `"${path.replace(/[\\"]/g, '\\$&')}"`;
}

/**
 * The environment of a trusted call: the parent's, without any GIT_* variable, plus the few this module sets itself.
 * @param {Object<string, string>} parent the tool's own environment
 * @param {string} gitDir the temp repository (also HOME and XDG_CONFIG_HOME: an empty folder holds no config and no attributes file)
 * @param {string} objectsDir the lane's object folder, an absolute real path
 * @returns {Object<string, string>} GIT_DIR and the objects to borrow; no system or global config; no system attributes
 */
export function trustedEnvironment(parent, gitDir, objectsDir) {
  const kept = Object.entries(parent).filter(([name]) => !/^GIT_/i.test(name));
  return {
    ...Object.fromEntries(kept),
    GIT_DIR: gitDir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: alternatesEntry(objectsDir),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_ATTR_NOSYSTEM: '1',
    HOME: gitDir,
    XDG_CONFIG_HOME: gitDir,
  };
}

/**
 * Stops the run on a git older than MIN_GIT.
 * @param {string} versionText the output of `git --version`
 * @throws {UsageError} naming the version found and the floor; also for a text that is no version line
 */
export function refuseOldGit(versionText) {
  const [, major, minor] = GIT_VERSION.exec(versionText) ?? [];
  const tooOld = major === undefined || Number(major) < MIN_GIT[0] || (Number(major) === MIN_GIT[0] && Number(minor) < MIN_GIT[1]);
  if (tooOld) throw new UsageError(`review-tier needs git ${MIN_GIT.join('.')} or newer (it reads the lane without the user's git config, which older versions cannot switch off); found ${JSON.stringify(versionText.slice(0, 40))}. Update git`);
}

const failure = (args, stderr) => new Error(`git ${args.slice(0, 2).join(' ')} failed: ${stderr.split('\n')[0]}`);

/**
 * Makes the temp repository and returns the reader every later git call goes through.
 * @param {string} objectsDir the lane's object folder (`<common dir>/objects`), an absolute real path
 * @returns {{run: Function, bytes: Function, text: Function, flag: Function, close: Function}} `run(args, { input, maxBytes })` gives
 *   `{ status, stdout (a Buffer), stderr }` and never throws for a non-zero exit; `bytes(args)` gives stdout and throws for one;
 *   `text(args)` gives trimmed stdout; `flag(args)` is true on exit 0, false on 1, and throws for anything else; `close()` removes the folder
 * @throws {UsageError} for a git older than MIN_GIT; {Error} when git cannot run or the repository cannot be made
 */
export function openTrustedGit(objectsDir) {
  const gitDir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const env = trustedEnvironment(process.env, gitDir, objectsDir);
  const run = (args, { input = undefined, maxBytes = MAX_OUTPUT_BYTES } = {}) => {
    const result = spawnSync('git', [...TRUSTED_FLAGS, ...args], { cwd: gitDir, env, input, maxBuffer: maxBytes });
    if (result.error) throw new Error(`cannot run git: ${result.error.message}`);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr.toString().trim() };
  };
  const bytes = (args) => {
    const { status, stdout, stderr } = run(args);
    if (status !== 0) throw failure(args, stderr);
    return stdout;
  };
  const flag = (args) => {
    const { status, stderr } = run(args);
    if (status !== 0 && status !== 1) throw failure(args, stderr);
    return status === 0;
  };
  const reader = { run, bytes, flag, text: (args) => bytes(args).toString().trim(), close: () => rmSync(gitDir, { recursive: true, force: true }) };
  try {
    refuseOldGit(reader.text(['--version']));
    bytes(['init', '--quiet', '--bare', gitDir]);
  } catch (error) {
    reader.close();
    throw error;
  }
  return reader;
}
