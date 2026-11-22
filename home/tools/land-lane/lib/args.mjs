// Purpose: read and validate the land-lane command line. Every value is the lead's own flag and is checked here before any command runs (P14).
// Exports: parseArgs, isAbsolutePath, UsageError, USAGE.
// Invariants: a bad value is a UsageError (exit 2) and nothing has run yet; a value that starts with `--` is a missing value, never a value, so
//   `--branch --help` cannot reach git; paths are absolute (a POSIX `/...` or a drive `X:\` / `X:/`; `\\server\x` is refused) with no control
//   character; a branch matches BRANCH_NAME, does not start with `-` and passes `git check-ref-format --branch`.
import { git } from './tools.mjs';

export class UsageError extends Error {}

export const USAGE = 'usage: land-lane.mjs --repo <abs base folder> --branch <name> --tip <40-hex> --base <branch> --status-file <abs> --close-row <row id>'
  + ' [--worktree <abs>] [--brief <file>] [--audit-base <40-hex>] [--checks <cat,...>] [--json]';

const FULL_SHA = /^[0-9a-f]{40}$/;
const BRANCH_NAME = /^[\w./-]{1,100}$/;
const ROW_ID = /^[A-Za-z0-9][\w.:-]{0,39}$/; // the id syntax status.mjs takes
const CHECK_LIST = /^[a-z]+(,[a-z]+)*$/;
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/])/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const MAX_PATH_CHARS = 4096;
const REF_CHECK_TIMEOUT_MS = 10_000;
const REQUIRED = ['repo', 'branch', 'tip', 'base', 'statusFile', 'closeRow'];
const VALUE_FLAGS = {
  '--repo': 'repo', '--branch': 'branch', '--tip': 'tip', '--base': 'base', '--status-file': 'statusFile', '--close-row': 'closeRow',
  '--worktree': 'worktree', '--brief': 'brief', '--audit-base': 'auditBase', '--checks': 'checks',
};
const PATH_OPTIONS = ['repo', 'statusFile', 'worktree', 'brief'];

/** True for a POSIX absolute path or a Windows drive path, with no control character; `\\server\share` is not accepted. */
export const isAbsolutePath = (text) => text.length <= MAX_PATH_CHARS && ABSOLUTE_PATH.test(text) && !CONTROL_CHARACTER.test(text);

function isBranchName(name) {
  if (!BRANCH_NAME.test(name) || name.startsWith('-')) return false;
  return git(process.cwd(), ['check-ref-format', '--branch', name], REF_CHECK_TIMEOUT_MS).ok;
}

function readFlags(argv) {
  const values = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const key = VALUE_FLAGS[flag];
    if (flag === '--json') values.json = true;
    else if (key === undefined) throw new UsageError(`unknown argument ${JSON.stringify(flag)}. ${USAGE}`);
    else if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new UsageError(`${flag} needs a value. ${USAGE}`);
    else if (values[key] !== undefined) throw new UsageError(`${flag} given twice. ${USAGE}`);
    else values[key] = argv[++i];
  }
  return values;
}

/**
 * Reads and validates the arguments.
 * @param {string[]} argv the words after the script name
 * @returns {{ repo: string, branch: string, tip: string, base: string, statusFile: string, closeRow: string, worktree: string|null,
 *   brief: string|null, auditBase: string|null, checks: string[], json: boolean }}
 * @throws {UsageError} a missing, repeated, unknown or malformed argument
 */
export function parseArgs(argv) {
  const values = readFlags(argv);
  for (const key of REQUIRED) if (values[key] === undefined) throw new UsageError(`missing --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}. ${USAGE}`);
  for (const key of PATH_OPTIONS) if (values[key] !== undefined && !isAbsolutePath(values[key])) throw new UsageError(`${key} must be an absolute path with no control characters, got ${JSON.stringify(values[key])}`);
  for (const key of ['tip', 'auditBase']) if (values[key] !== undefined && !FULL_SHA.test(values[key])) throw new UsageError(`${key} must be a full 40-hex sha, got ${JSON.stringify(values[key])}`);
  for (const key of ['branch', 'base']) if (!isBranchName(values[key])) throw new UsageError(`${key} is not a usable branch name: ${JSON.stringify(values[key])}`);
  if (!ROW_ID.test(values.closeRow)) throw new UsageError(`closeRow is not a status.mjs row id: ${JSON.stringify(values.closeRow)}`);
  if (values.checks !== undefined && !CHECK_LIST.test(values.checks)) throw new UsageError(`--checks must be category names split by commas, got ${JSON.stringify(values.checks)}`);
  return { ...values, worktree: values.worktree ?? null, brief: values.brief ?? null, auditBase: values.auditBase ?? null, checks: values.checks === undefined ? [] : values.checks.split(',') };
}
