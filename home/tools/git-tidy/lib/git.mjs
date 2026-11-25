// Purpose: run git without a shell and without any repository chosen by the environment.
// Exports: UsageError, runGit, gitText, gitFlag.
// Invariants: arguments are passed as an array to `git` (spawnSync, no shell), always with an explicit cwd; the variables
//   that point git at a repository are removed, so the folder given on the command line is the only repository used; locks
//   that only refresh caches (the index during `status`) are switched off so read-only commands write nothing; the
//   repository's `core.fsmonitor` is switched off for every call (FORCED_CONFIG, last in GIT_CONFIG_PARAMETERS).
import { spawnSync } from 'node:child_process';

const MAX_OUTPUT_BYTES = 256 << 20;
// Variables that make git use another repository than the one found from cwd (a hook sets some of them).
const REPOSITORY_VARIABLES = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
];

/** A mistake of the caller (arguments, folder, base branch): the CLI prints it and exits 2. */
export class UsageError extends Error {}

// Config every call gets at the level of `-c`, beating the repository's own: core.fsmonitor runs a hook the repository names, or
// starts git's watcher daemon, which keeps watching the folder it first started for, so the edits of a worktree moved back
// there go unseen. Appended to GIT_CONFIG_PARAMETERS (the variable `-c` itself fills), after anything the caller put there:
// git reads it after GIT_CONFIG_COUNT and the last value wins, so neither the caller's GIT_CONFIG_PARAMETERS (a parent
// `git -c core.fsmonitor=true`) nor its GIT_CONFIG_COUNT can switch it back on. The argument list stays as written.
const FORCED_CONFIG = "'core.fsmonitor'='false'";

function gitEnvironment() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const name of REPOSITORY_VARIABLES) delete env[name];
  env.GIT_CONFIG_PARAMETERS = env.GIT_CONFIG_PARAMETERS ? `${env.GIT_CONFIG_PARAMETERS} ${FORCED_CONFIG}` : FORCED_CONFIG;
  return env;
}

/** Runs `git <args>` in `cwd` (with `input` as stdin when given); returns `{ status, stdout, stderr }` and never throws for a non-zero exit. */
export function runGit(cwd, args, input = undefined, { timeoutMs = undefined } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnvironment(), maxBuffer: MAX_OUTPUT_BYTES, input, timeout: timeoutMs });
  if (result.error) throw new Error(`cannot run git: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr.trim() };
}

function failure(args, stderr) {
  return new Error(`git ${args.slice(0, 2).join(' ')} failed: ${stderr.split('\n')[0]}`);
}

/** Runs git and returns trimmed stdout; a non-zero exit throws an Error naming the command and git's first message line. */
export function gitText(cwd, args) {
  const { status, stdout, stderr } = runGit(cwd, args);
  if (status !== 0) throw failure(args, stderr);
  return stdout.trim();
}

/** For yes/no git commands (`merge-base --is-ancestor`, `rev-parse --verify --quiet`): true on exit 0, false on 1, anything else throws. */
export function gitFlag(cwd, args) {
  const { status, stderr } = runGit(cwd, args);
  if (status !== 0 && status !== 1) throw failure(args, stderr);
  return status === 0;
}
