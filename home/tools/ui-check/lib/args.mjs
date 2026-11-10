// Purpose: strict CLI flag parsing that reports mistakes as UsageError.
// Exports: parse, need, toNumber. Invariant: unknown flags are rejected.
import { parseArgs } from 'node:util';
import { UsageError } from './errors.mjs';

/**
 * Parse argv against a node:util option table.
 * @param {string[]} argv flags after the command name
 * @param {object} options node:util parseArgs options
 * @returns {Record<string, string | boolean | undefined>} parsed values
 * @throws {UsageError} on unknown or malformed flags
 */
export function parse(argv, options) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: false, strict: true }).values;
  } catch (error) {
    throw new UsageError(error.message);
  }
}

/** Throw a UsageError naming every required flag that is missing. */
export function need(values, ...names) {
  const missing = names.filter((name) => values[name] === undefined);
  if (missing.length > 0) throw new UsageError(`missing required flag(s): --${missing.join(', --')}`);
}

/** Parse a numeric flag; throws UsageError when it is not a finite number >= min. */
export function toNumber(value, name, min = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) throw new UsageError(`--${name} must be a number >= ${min}`);
  return parsed;
}
