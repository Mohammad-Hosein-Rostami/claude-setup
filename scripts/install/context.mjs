// Purpose: the install run's context: the parsed flags, the paths the run works on, and its log (what was done, what failed).
// Exports: USAGE, InstallError, parseArgs, makeContext, act, note, warn, samePath, OS_NAME.
// Invariants: parseArgs refuses an unknown flag or a bad combination with exit code 2 before anything changes; every change
//   on disk goes through act(), so --dry-run prints it instead of doing it.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const USAGE =
  'install [--update [--to <tag>]] [--uninstall] [--dry-run] [--no-plugins] [--no-tools] [--project-workflows <repo> [--copy]] ' +
  '[--ps-profile <path>] [--claude-version <x.y.z>]';

/** The settings layer and file names per operating system (settings/<name>.json). */
export const OS_NAME = { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform] ?? 'linux';

const SWITCHES = { '--update': 'update', '--uninstall': 'uninstall', '--dry-run': 'dryRun', '--no-plugins': 'noPlugins', '--no-tools': 'noTools', '--copy': 'copy' };
const VALUED = { '--to': 'to', '--project-workflows': 'project', '--ps-profile': 'psProfile', '--claude-version': 'claudeVersion' };
const VERSION_SHAPE = /^\d+\.\d+\.\d+$/;
const TAG_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // a tag name that is also a safe folder name
const USAGE_EXIT = 2;

/** An expected failure: its message is shown as it is and the run exits with `exitCode` (2: bad usage, 1: a step failed). */
export class InstallError extends Error {
  /** @param {string} message what failed and what to do @param {number} [exitCode] process exit code */
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/**
 * Reads the command-line flags.
 * @param {string[]} argv the arguments after the script name
 * @returns {Record<string, string|boolean>} the flags by their context name (update, to, project, ...)
 * @throws {InstallError} exit 2 for an unknown flag, a missing value or a bad combination
 */
export function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (SWITCHES[arg]) flags[SWITCHES[arg]] = true;
    else if (VALUED[arg]) {
      if (index + 1 >= argv.length) throw new InstallError(`${arg} needs a value`, USAGE_EXIT);
      flags[VALUED[arg]] = argv[(index += 1)];
    } else throw new InstallError(`unknown flag: ${arg} (use ${USAGE})`, USAGE_EXIT);
  }
  checkCombinations(flags);
  return flags;
}

function checkCombinations(flags) {
  if (flags.copy && !flags.project) throw new InstallError('--copy needs --project-workflows <repo>', USAGE_EXIT);
  if (flags.to && !flags.update) throw new InstallError('--to needs --update (install --update --to <tag>)', USAGE_EXIT);
  if (flags.to && !TAG_SHAPE.test(flags.to)) throw new InstallError(`--to ${flags.to}: not a tag name`, USAGE_EXIT);
  if (flags.uninstall && (flags.update || flags.project)) throw new InstallError('--uninstall takes no --update or --project-workflows', USAGE_EXIT);
  if (flags.claudeVersion && !VERSION_SHAPE.test(flags.claudeVersion)) throw new InstallError('--claude-version needs x.y.z', USAGE_EXIT);
}

/**
 * The run's context. `root` is the checkout whose home/ the links point at: the repo itself, or a worktree of a tag
 * (`--update --to <tag>`, set later by the pin step).
 * @param {Record<string, string|boolean>} flags from parseArgs
 * @param {string} repo the repo checkout that holds this script
 * @param {NodeJS.ProcessEnv} env the environment (HOME, SHELL, ...)
 * @returns {object} the context every step takes
 */
export function makeContext(flags, repo, env = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // YYYYMMDD-HHMMSS (UTC)
  return {
    ...flags,
    repo,
    root: repo,
    home,
    env,
    os: OS_NAME,
    claudeDir: join(home, '.claude'),
    backupDir: join(home, `.claude-backup-${stamp}`),
    done: [],
    failures: [],
  };
}

/**
 * Runs one change, or under --dry-run prints what it would do.
 * @param {{dryRun?: boolean}} ctx the run context
 * @param {string} what the change in a few words
 * @param {() => unknown} change the change itself
 * @returns {unknown} what `change` returns, or undefined under --dry-run
 */
export function act(ctx, what, change) {
  if (ctx.dryRun) {
    console.log(`[dry-run] ${what}`);
    return undefined;
  }
  return change();
}

/** Logs one finished step (shown at once and again in the summary). */
export function note(ctx, message) {
  ctx.done.push(message);
  console.log(`  ${message}`);
}

/** Prints a warning that does not stop the run. */
export function warn(message) {
  console.error(`WARNING: ${message}`);
}

/** True when two paths name the same place (case-insensitive on Windows; a `\\?\` prefix is ignored). */
export function samePath(left, right) {
  const clean = (path) => resolve(String(path).replace(/^\\\\\?\\/, ''));
  return process.platform === 'win32' ? clean(left).toLowerCase() === clean(right).toLowerCase() : clean(left) === clean(right);
}
