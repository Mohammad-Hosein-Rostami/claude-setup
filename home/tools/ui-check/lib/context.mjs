// Purpose: validate and normalise the page-context flags shared by compare, responsive and batch: --locale, --color-scheme,
// --storage, --cookie, --expect-dir, and the widths list.
// Exports: CONTEXT_OPTIONS, COLOR_SCHEMES, DIRECTIONS, readContextFlags, validateLocale, validateChoice, validateEntries, validateWidths,
// mergeEntries. Invariants: pure (no I/O); every bad value is a UsageError whose message starts with the flag or JSON path (`label`);
// an unknown value is never replaced by a default.
import { UsageError } from './errors.mjs';

export const COLOR_SCHEMES = ['light', 'dark'];
export const DIRECTIONS = ['ltr', 'rtl'];
const MIN_WIDTH = 200;
const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/; // RFC 6265 token
const COOKIE_VALUE_FORBIDDEN = /[;\p{Cc}]/u;

/** node:util option entries for the five context flags; spread into a command's option table. */
export const CONTEXT_OPTIONS = {
  locale: { type: 'string' },
  'color-scheme': { type: 'string' },
  storage: { type: 'string', multiple: true },
  cookie: { type: 'string', multiple: true },
  'expect-dir': { type: 'string' },
};

/**
 * Check a BCP 47 language tag and return its canonical form (fa-ir -> fa-IR).
 * @param {unknown} value candidate tag
 * @param {string} label flag or JSON path for the message
 * @throws {UsageError} when it is not exactly one well-formed tag
 */
export function validateLocale(value, label) {
  let canonical = [];
  if (typeof value === 'string' && value.trim() === value) {
    try {
      canonical = Intl.getCanonicalLocales(value);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error; // RangeError = malformed tag, reported below
    }
  }
  if (canonical.length !== 1) throw new UsageError(`${label}: ${JSON.stringify(value)} is not a BCP 47 language tag (example: fa-IR)`);
  return canonical[0];
}

/** Require `value` to be one of `allowed`. @throws {UsageError} naming the allowed values */
export function validateChoice(value, allowed, label) {
  if (!allowed.includes(value)) throw new UsageError(`${label}: ${JSON.stringify(value)} is not one of ${allowed.join(' | ')}`);
  return value;
}

function checkEntry({ name, value }, label, kind) {
  if (name === '') throw new UsageError(`${label}: ${kind} name must not be empty`);
  if (kind === 'cookie' && !COOKIE_NAME.test(name)) throw new UsageError(`${label}: cookie name ${JSON.stringify(name)} has characters a cookie name cannot hold`);
  if (kind === 'cookie' && COOKIE_VALUE_FORBIDDEN.test(value)) throw new UsageError(`${label}: cookie value for "${name}" must not contain ";" or control characters`);
}

/**
 * Normalise key/value input to a list of {name, value}: `key=value` strings (the flag form, split at the first "=") or a plain
 * object of string values (the JSON form).
 * @param {string[]|Record<string, string>|undefined} input
 * @param {string} label flag or JSON path
 * @param {'storage'|'cookie'} kind what the entries become
 * @returns {{name: string, value: string}[]}
 * @throws {UsageError} on a malformed pair, a non-string value, a bad cookie name or value, or a name given twice
 */
export function validateEntries(input, label, kind) {
  if (input === undefined) return [];
  const pairs = Array.isArray(input) ? input.map((text) => splitPair(text, label)) : objectPairs(input, label);
  const seen = new Set();
  for (const pair of pairs) {
    checkEntry(pair, label, kind);
    if (seen.has(pair.name)) throw new UsageError(`${label}: "${pair.name}" is given twice`);
    seen.add(pair.name);
  }
  return pairs;
}

function splitPair(text, label) {
  const at = String(text).indexOf('=');
  if (at < 0) throw new UsageError(`${label}: ${JSON.stringify(text)} must be key=value`);
  return { name: text.slice(0, at), value: text.slice(at + 1) };
}

function objectPairs(input, label) {
  if (input === null || typeof input !== 'object') throw new UsageError(`${label}: must be an object of string values`);
  return Object.entries(input).map(([name, value]) => {
    if (typeof value !== 'string') throw new UsageError(`${label}.${name}: must be a string`);
    return { name, value };
  });
}

/** Merge two entry lists by name; entries of `over` win. */
export function mergeEntries(base, over) {
  const byName = new Map(base.map((entry) => [entry.name, entry]));
  for (const entry of over) byName.set(entry.name, entry);
  return [...byName.values()];
}

/** Require a non-empty list of integer widths >= 200. @throws {UsageError} naming `label` */
export function validateWidths(widths, label) {
  if (!Array.isArray(widths) || widths.length === 0 || widths.some((w) => !Number.isInteger(w) || w < MIN_WIDTH)) {
    throw new UsageError(`${label}: must be a non-empty list of integers >= ${MIN_WIDTH}`);
  }
  return widths;
}

/**
 * Read and validate the context flags from parsed argv values.
 * @param {Record<string, unknown>} values parsed flags (keys absent = flag not given)
 * @returns {{locale?: string, colorScheme: 'light'|'dark', storage: {name: string, value: string}[], cookies: {name: string, value: string}[], expectDir?: 'ltr'|'rtl'}}
 * @throws {UsageError} naming the first bad flag
 */
export function readContextFlags(values) {
  const given = (name) => values[name] !== undefined;
  return {
    locale: given('locale') ? validateLocale(values.locale, '--locale') : undefined,
    colorScheme: given('color-scheme') ? validateChoice(values['color-scheme'], COLOR_SCHEMES, '--color-scheme') : 'light',
    storage: validateEntries(values.storage, '--storage', 'storage'),
    cookies: validateEntries(values.cookie, '--cookie', 'cookie'),
    expectDir: given('expect-dir') ? validateChoice(values['expect-dir'], DIRECTIONS, '--expect-dir') : undefined,
  };
}
