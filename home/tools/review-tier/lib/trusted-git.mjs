// Purpose: the one way review-tier reads commits, trees, diffs and file texts: git run in a repository of the tool's own that holds only
//   objects the tool copied in itself, each under the name its content gives (lib/lane-import.mjs).
// Exports: MIN_GIT, TRUSTED_FLAGS, trustedEnvironment(parent, gitDir), refuseOldGit(versionText), spawnGit(gitDir, env, args, options),
//   openTrustedGit() -> { gitDir, env, run, bytes, text, flag, withAttributeSource, notePack, checkFolder, close }.
// Why: the writer of a fix is the same OS user as the tool and can write the lane's git dir (config, info/, refs, index, commit-graph,
//   packs, loose objects, alternates), its working tree and the user's own git files. Five security rounds each found one more of those
//   that changed what a review read (lane r7-delta: B8-B14, S7, F1). Here none of them is read: the repository is a fresh bare one in a
//   temp folder, the environment is rebuilt, and no call made through this module can see the lane's object store at all. An object the
//   import did not copy is missing here, which the closure check turns into exit 2 (lib/closure-check.mjs).
// Invariants: no shell; every call runs in the temp folder with the same flags and environment, and none carries
//   GIT_ALTERNATE_OBJECT_DIRECTORIES; only shas go in (the temp repository has no ref and an unborn HEAD, so a name fails); git's
//   messages are never translated (LC_MESSAGES=C), so a reader can tell git's `error:` and `fatal:` lines; the folder is checked after
//   init, after each import and once after the last read (checkFolder; what that check compares, and what it cannot see, is said in
//   lib/temp-repository.mjs) and is removed by close(), which the CLI calls in a `finally` (from inside, never through a link).
// Left outside: `git` is the first one on the caller's PATH (Homebrew, Volta and Git for Windows live in folders the user can write, so
//   an absolute root-owned git cannot be required): whoever can put a program there is outside what this module can check (security
//   N26). A process of the same user can still change the temp folder between two of its checks, or replace an `.idx` before the tool
//   notes it: only a folder the writer's processes cannot write closes that (N27/N33, phase 3). spawnGit has no time limit, so git
//   itself can still block on a FIFO put in place of a file it opens in the temp folder (P1, phase 3); the tool's own reads there
//   cannot (lib/temp-repository.mjs, openRegularFile).
import { spawnSync } from 'node:child_process';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { UsageError } from '../../git-tidy/lib/git.mjs';
import { checkPackFiles, checkTempFolder, makeTempFolder, notePackFiles, removeTempFolder, snapshotOf } from './temp-repository.mjs';

const MAX_OUTPUT_BYTES = 256 << 20;
/**
 * The oldest git the tool works with: `--attr-source` first shipped in 2.41.0 (the attributes of every diff and grep are read from the
 * lane's start through it); GIT_CONFIG_GLOBAL, which keeps the user's config out, is older (2.32).
 */
export const MIN_GIT = [2, 41];
const GIT_VERSION = /^git version (\d+)\.(\d+)/;
/**
 * Set on every call, whatever the temp repository's own config says (`git init` writes core.precomposeUnicode and core.ignoreCase there
 * on macOS): commitGraph and multiPackIndex: parents and object places come from the objects, never from a file beside them (B8);
 * precomposeUnicode: a path is its bytes, an NFD name is not folded into its NFC twin (B10); quotePath: paths are printed as they are;
 * attributesFile: no attributes from `$XDG_CONFIG_HOME/git/attributes`, which git reads with no config at all (F1); ignoreCase: an
 * attribute pattern matches a path by its exact letters on every OS (trees are case-sensitive data).
 */
export const TRUSTED_FLAGS = [
  '-c', 'core.commitGraph=false',
  '-c', 'core.multiPackIndex=false',
  '-c', 'core.precomposeUnicode=false',
  '-c', 'core.quotePath=false',
  '-c', `core.attributesFile=${devNull}`,
  '-c', 'core.ignoreCase=false',
];
/** The commands whose output depends on attributes (the diff driver that picks hunk heads, what counts as binary for grep). */
const ATTRIBUTE_READERS = new Set(['diff', 'grep']);

/**
 * The environment of a trusted call: the parent's, without any GIT_* variable, plus the few this module sets itself.
 * The locale: git's messages are never translated, and no other locale category changes. `LANGUAGE` and `LC_ALL` are dropped; a parent
 * `LC_ALL` becomes `LANG` and every other parent `LC_*` is dropped, so each category keeps the value it had; then `LC_MESSAGES=C`.
 * (`LC_ALL=C` would also change `LC_CTYPE`, and with it git's hunk heads for a function line that is not UTF-8: spec check fix 6, K1.)
 * @param {Object<string, string>} parent the tool's own environment
 * @param {string} gitDir the temp repository (also HOME and XDG_CONFIG_HOME: it holds no `.gitconfig` and no `git/` folder)
 * @returns {Object<string, string>} GIT_DIR; no system or global config; no system attributes; replace refs off and a graft file that
 *   cannot exist (a path below the node binary, a file), in case something is written into the temp folder between two checks of it
 */
export function trustedEnvironment(parent, gitDir) {
  const all = parent.LC_ALL; // an empty LC_ALL sets nothing (libc reads it as unset)
  const locale = (name) => name === 'LANGUAGE' || name === 'LC_ALL' || (Boolean(all) && name.startsWith('LC_'));
  const kept = Object.entries(parent).filter(([name]) => !/^GIT_/i.test(name) && !locale(name));
  return {
    ...Object.fromEntries(kept),
    ...(all ? { LANG: all } : {}),
    LC_MESSAGES: 'C',
    GIT_DIR: gitDir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_GRAFT_FILE: join(process.execPath, 'no-grafts'),
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
  if (tooOld) throw new UsageError(`review-tier needs git ${MIN_GIT.join('.')} or newer (it reads the lane without the user's git config and takes attributes from the lane's start with --attr-source, which older versions cannot do); found ${JSON.stringify(versionText.slice(0, 40))}. Update git`);
}

const failure = (args, stderr) => new Error(`git ${args.slice(0, 2).join(' ')} failed: ${stderr.split('\n')[0]}`);

/**
 * Runs git with the trusted flags in the temp repository.
 * @param {string} gitDir the temp repository, also the working folder
 * @param {Object<string, string>} env the whole environment of the call
 * @param {string[]} args the command and its arguments, after the trusted flags
 * @param {{input?: string | Buffer, stdinFile?: number, maxBytes?: number}} options `stdinFile`: an open file descriptor git reads as
 *   its standard input (a pack too large to hold in memory twice)
 * @returns {{status: number, stdout: Buffer, stderr: string}} never throws for a non-zero exit
 * @throws {Error} when git cannot be run or its output is larger than `maxBytes`
 */
export function spawnGit(gitDir, env, args, { input = undefined, stdinFile = undefined, maxBytes = MAX_OUTPUT_BYTES } = {}) {
  const stdio = stdinFile === undefined ? undefined : [stdinFile, 'pipe', 'pipe'];
  const result = spawnSync('git', [...TRUSTED_FLAGS, ...args], { cwd: gitDir, env, input, stdio, maxBuffer: maxBytes });
  if (result.error) throw new Error(`cannot run git: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr.toString().trim() };
}

/** The reading functions over one `run`: see openTrustedGit. */
function readerOver(run) {
  const bytes = (args) => {
    const { status, stdout, stderr } = run(args);
    if (status !== 0) throw failure(args, stderr);
    return stdout;
  };
  // A yes/no answer is exit 0 or 1 with nothing on stderr. Anything git has to say there (an object it could not read) is a failure,
  // never a "no": an ancestor test that failed must not read as "not an ancestor".
  const flag = (args) => {
    const { status, stderr } = run(args);
    if ((status !== 0 && status !== 1) || stderr !== '') throw failure(args, stderr);
    return status === 0;
  };
  return { run, bytes, flag, text: (args) => bytes(args).toString().trim() };
}

/**
 * Makes the temp repository and returns the reader every later git call goes through.
 * @returns {object} `run(args, { input, stdinFile, maxBytes })` gives `{ status, stdout (a Buffer), stderr }` and never throws for a
 *   non-zero exit; `bytes(args)` gives stdout and throws for one; `text(args)` gives trimmed stdout; `flag(args)` is true on exit 0,
 *   false on 1, and throws for anything else or for any stderr text; `withAttributeSource(sha)` gives the same four functions with
 *   every diff and grep reading attributes from the tree of `sha` (`git --attr-source=<sha>`, a global option); `gitDir` and `env`:
 *   the folder and the environment of every call; `notePack(name, written)`: tells the folder check a pack this run imported, with
 *   what the pack writer wrote (a UsageError when git named another pack); `checkFolder({ last })`: throws a UsageError unless the
 *   folder holds only what this run wrote and every noted pack file is unchanged (`last`: the check after the last read, which also
 *   hashes each `.pack` again); `close()` removes the folder and never throws (what stopped a removal is one line on stderr)
 * @throws {UsageError} for a git older than MIN_GIT, and when the new folder already holds something else; {Error} when git cannot run
 */
export function openTrustedGit() {
  const folder = makeTempFolder();
  const gitDir = folder.path;
  const env = trustedEnvironment(process.env, gitDir);
  const packs = new Map();
  const run = (args, options) => spawnGit(gitDir, env, args, options);
  const reader = {
    ...readerOver(run), gitDir, env,
    withAttributeSource: (sha) => readerOver((args, options) => run(ATTRIBUTE_READERS.has(args[0]) ? [`--attr-source=${sha}`, ...args] : args, options)),
    notePack: (name, written) => packs.set(name, notePackFiles(gitDir, name, written)),
    close: () => {
      const problem = removeTempFolder(folder);
      if (problem !== null) console.error(`review-tier: ${problem}`);
    },
  };
  try {
    refuseOldGit(reader.text(['--version']));
    // --template=: nothing is copied from git's template folder (its `config`, `info/attributes` and hooks would become the tool's own).
    reader.bytes(['init', '--quiet', '--bare', '--template=', gitDir]);
    const snapshot = snapshotOf(gitDir);
    reader.checkFolder = ({ last = false } = {}) => {
      checkTempFolder(gitDir, snapshot, packs.keys());
      checkPackFiles(gitDir, packs, { last });
    };
    reader.checkFolder();
  } catch (error) {
    reader.close();
    throw error;
  }
  return reader;
}
