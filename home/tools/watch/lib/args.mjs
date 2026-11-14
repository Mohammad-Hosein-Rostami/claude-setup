// Command-line parsing for watch.mjs. Exports: UsageError, parseArgs(argv) -> options, USAGE.
// Options: { targets: string[], stallMin: number, logDir?: string, guardLog?: string, once: boolean, help: boolean }.
// Invariants (C10): every value is validated here, an unknown --flag or a missing value is a UsageError, `--` ends the flags,
// and no target is empty. Pure: the file system is not touched (resolve.mjs does that).

export const DEFAULT_STALL_MIN = 20;
const MAX_STALL_MIN = 7 * 24 * 60;
export const USAGE = 'usage: watch.mjs <session-id | transcript.jsonl>... [--stall-min 20] [--log <dir>] [--guard-log <path>] [--once]';
const VALUE_FLAGS = new Set(['--stall-min', '--log', '--guard-log']);
const BOOLEAN_FLAGS = new Set(['--once', '--help']);

export class UsageError extends Error {}

function stallMinutes(text) {
  const minutes = Number(text);
  if (text.trim() === '' || !Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_STALL_MIN) {
    throw new UsageError(`--stall-min must be a number of minutes between 0 and ${MAX_STALL_MIN}, got "${text}"`);
  }
  return minutes;
}

function nonEmpty(flag, value) {
  if (value.trim() === '') throw new UsageError(`${flag} needs a non-empty value`);
  return value;
}

/**
 * @param {string[]} argv arguments after the script name
 * @returns {{ targets: string[], stallMin: number, logDir?: string, guardLog?: string, once: boolean, help: boolean }}
 * @throws {UsageError} on an unknown flag, a missing or invalid value, or no target
 */
export function parseArgs(argv) {
  const options = { targets: [], stallMin: DEFAULT_STALL_MIN, once: false, help: false };
  let flagsEnded = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (flagsEnded || !arg.startsWith('--')) { options.targets.push(nonEmpty('target', arg)); continue; }
    if (arg === '--') { flagsEnded = true; continue; }
    if (BOOLEAN_FLAGS.has(arg)) { options[arg === '--once' ? 'once' : 'help'] = true; continue; }
    if (!VALUE_FLAGS.has(arg)) throw new UsageError(`unknown flag ${arg}`);
    const value = argv[index + 1];
    if (value === undefined) throw new UsageError(`${arg} needs a value`);
    index += 1;
    if (arg === '--stall-min') options.stallMin = stallMinutes(value);
    else options[arg === '--log' ? 'logDir' : 'guardLog'] = nonEmpty(arg, value);
  }
  if (options.targets.length === 0 && !options.help) throw new UsageError('give at least one session id or transcript path');
  return options;
}
