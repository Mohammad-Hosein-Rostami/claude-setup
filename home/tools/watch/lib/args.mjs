// Command-line parsing for watch.mjs. Exports: UsageError, parseArgs(argv) -> options, USAGE.
// Options: { targets: string[], stallMin: number, logDir?: string, guardLog?: string, exitOnEvent?: string[], delaySec?: number, skip?: number,
// once: boolean, help: boolean }. `--delay-sec N` and `--skip N` only mean something with `--exit-on-event` (see wake.mjs) and are a usage error without it.
// `--exit-on-event [classes]` takes an optional comma list of lowercase class names right after it (see events.mjs); the next argument
// is a list only when it is made of lowercase letters, hyphens and commas, so a session id (it has digits) or a flag is left alone.
// Invariants (C10): every value is validated here, an unknown --flag or a missing value is a UsageError, `--` ends the flags,
// and no target is empty. Pure: the file system is not touched (resolve.mjs does that).
import { DEFAULT_EXIT_CLASSES, EXIT_CLASS_NAMES } from './events.mjs';

export const DEFAULT_STALL_MIN = 20;
const MAX_STALL_MIN = 7 * 24 * 60;
const MAX_DELAY_SEC = 24 * 60 * 60;
const MAX_SKIP = 1000;
export const USAGE = 'usage: watch.mjs <session-id | transcript.jsonl>... [--stall-min 20] [--log <dir>] [--guard-log <path>] [--once] [--exit-on-event [classes]] [--delay-sec 0] [--skip 0]';
const VALUE_FLAGS = new Set(['--stall-min', '--log', '--guard-log', '--delay-sec', '--skip']);
const CLASS_LIST = /^[a-z][a-z,-]*$/;
const BOOLEAN_FLAGS = new Set(['--once', '--help']);

export class UsageError extends Error {}

function stallMinutes(text) {
  const minutes = Number(text);
  if (text.trim() === '' || !Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_STALL_MIN) {
    throw new UsageError(`--stall-min must be a number of minutes between 0 and ${MAX_STALL_MIN}, got "${text}"`);
  }
  return minutes;
}

function delaySeconds(text) {
  const seconds = Number(text);
  if (text.trim() === '' || !Number.isFinite(seconds) || seconds < 0 || seconds > MAX_DELAY_SEC) {
    throw new UsageError(`--delay-sec must be a number of seconds between 0 and ${MAX_DELAY_SEC}, got "${text}"`);
  }
  return seconds;
}

function skipCount(text) {
  const count = Number(text);
  if (!/^\d+$/.test(text.trim()) || count > MAX_SKIP) throw new UsageError(`--skip must be a whole number between 0 and ${MAX_SKIP}, got "${text}"`);
  return count;
}

function nonEmpty(flag, value) {
  if (value.trim() === '') throw new UsageError(`${flag} needs a non-empty value`);
  return value;
}

function eventClasses(text) {
  const names = text.split(',');
  const unknown = names.find((name) => !EXIT_CLASS_NAMES.includes(name));
  if (unknown !== undefined) throw new UsageError(`--exit-on-event: unknown event class "${unknown}" (one of ${EXIT_CLASS_NAMES.join(', ')}; give the session id before the flag)`);
  return names;
}

/**
 * @param {string[]} argv arguments after the script name
 * @returns {{ targets: string[], stallMin: number, logDir?: string, guardLog?: string, exitOnEvent?: string[], delaySec?: number, skip?: number, once: boolean, help: boolean }}
 * @throws {UsageError} on an unknown flag, a missing or invalid value, or no target
 */
export function parseArgs(argv) {
  const options = { targets: [], stallMin: DEFAULT_STALL_MIN, once: false, help: false };
  let flagsEnded = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (flagsEnded || !arg.startsWith('--')) { options.targets.push(nonEmpty('target', arg)); continue; }
    if (arg === '--') { flagsEnded = true; continue; }
    if (arg === '--exit-on-event') {
      const classes = CLASS_LIST.test(argv[index + 1] ?? '') ? argv[(index += 1)] : undefined;
      options.exitOnEvent = classes === undefined ? DEFAULT_EXIT_CLASSES : eventClasses(classes);
      continue;
    }
    if (BOOLEAN_FLAGS.has(arg)) { options[arg === '--once' ? 'once' : 'help'] = true; continue; }
    if (!VALUE_FLAGS.has(arg)) throw new UsageError(`unknown flag ${arg}`);
    const value = argv[index + 1];
    if (value === undefined) throw new UsageError(`${arg} needs a value`);
    index += 1;
    if (arg === '--stall-min') options.stallMin = stallMinutes(value);
    else if (arg === '--delay-sec') options.delaySec = delaySeconds(value);
    else if (arg === '--skip') options.skip = skipCount(value);
    else options[arg === '--log' ? 'logDir' : 'guardLog'] = nonEmpty(arg, value);
  }
  if (options.targets.length === 0 && !options.help) throw new UsageError('give at least one session id or transcript path');
  if (options.exitOnEvent === undefined && (options.delaySec !== undefined || options.skip !== undefined)) throw new UsageError('--delay-sec and --skip only work with --exit-on-event');
  return options;
}
