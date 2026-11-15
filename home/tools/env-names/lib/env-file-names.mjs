// The only code that sees the content of an env file: it returns the variable names and a count of other lines, never a value.
// Exports: namesFromEnvText(text) -> { names, otherLines }; isRegularEnvText(text) -> boolean;
//   readEnvFile(path) -> { names, otherLines, irregular?, status? }; MAX_ENV_FILE_BYTES.
// Invariants: of every line only the text left of the first `=` (or of `: ` in the dotenv colon form) is looked at as a name;
//   the rest is used for one thing, to see whether the value goes on over the next lines, and is never stored or returned.
//   When the reader is not sure a token is a name it counts the line (`otherLines`) and keeps nothing:
//   - a line that is not blank, a comment or a definition starts a skipped region that lasts until the next blank line;
//   - a PEM block (`-----BEGIN` to `-----END`, wherever it starts, also inside a value) is skipped whole;
//   - lines inside a value that opens a quote, ends with a backslash or is a YAML block scalar (`|`, `>`) are skipped;
//   - a line whose value is only `=` characters (base64 or base32 padding) is not a definition.
//   A file is REGULAR only when every line is blank, a comment or one complete definition on that line (see isRegularEnvText);
//   `irregular: true` tells the caller to show none of its names that no other file corroborates.
//   A file that cannot be read gives a `status` text built from the error code, never from the error message or content.
import { readRegularFile } from './read-regular-file.mjs';

export const MAX_ENV_FILE_BYTES = 16 * 1024 * 1024;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EXPORT_PREFIX = /^export\s+/;
const COLON_SEPARATOR = /:(?:\s|$)/;
const BLOCK_SCALAR = /^[|>][-+0-9]*\s*(?:#.*)?$/;
const PADDING_ONLY = /^=+$/;
const QUOTES = ['"', "'", '`'];
const BYTE_ORDER_MARK = '﻿';
const PEM_BEGIN = '-----BEGIN';
const PEM_END = '-----END';

/** Index of the first unescaped `quote` in `text` at or after `from`, or -1. A backslash escapes the next character. */
function closingQuote(text, quote, from) {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === quote) return i;
  }
  return -1;
}

/** The quote character that opens a value continuing past this line (`"`, `'`, backtick, or bash `$'`), or null. */
function openQuoteOf(afterSeparator) {
  let value = afterSeparator.trimStart();
  if (value[0] === '$') value = value.slice(1);
  if (!QUOTES.includes(value[0])) return null;
  return closingQuote(value, value[0], 1) === -1 ? value[0] : null;
}

/** A `-----END` line ends the PEM region only; an open quote stays open unless it closes on that line after the END text. */
function endPemRegion(state, line) {
  Object.assign(state, { pem: false, backslash: false, block: false, skipping: false });
  if (state.quote !== null && closingQuote(line, state.quote, line.indexOf(PEM_END)) !== -1) state.quote = null;
}

/** Splits `NAME=rest` or `NAME: rest` at whichever separator comes first; null when the left side is not a name. */
function splitDefinition(line) {
  const equalsAt = line.indexOf('=');
  const colonAt = line.search(COLON_SEPARATOR);
  const colonFirst = colonAt !== -1 && (equalsAt === -1 || colonAt < equalsAt);
  const at = colonFirst ? colonAt : equalsAt;
  if (at === -1) return null;
  const name = line.slice(0, at).trim().replace(EXPORT_PREFIX, '');
  if (!NAME_PATTERN.test(name)) return null;
  const rest = line.slice(at + 1);
  return PADDING_ONLY.test(rest.trim()) ? null : { name, rest, colon: colonFirst };
}

/**
 * Names defined in env file text and the number of lines that are not a comment, blank or a definition (or sit inside a value).
 * @param {string} text the file content (any line ends, optional BOM)
 * @returns {{ names: string[], otherLines: number }} names sorted and unique
 */
export function namesFromEnvText(text) {
  const names = new Set();
  let otherLines = 0;
  const state = { pem: false, quote: null, backslash: false, block: false, skipping: false };
  for (const line of text.replace(BYTE_ORDER_MARK, '').split(/\r\n|\r|\n/)) {
    if (state.pem) {
      otherLines += 1;
      if (line.includes(PEM_END)) endPemRegion(state, line);
      continue;
    }
    const pemAt = line.indexOf(PEM_BEGIN);
    if (pemAt !== -1) state.pem = line.indexOf(PEM_END, pemAt) === -1;
    const blank = line.trim() === '';
    if (state.quote !== null) {
      otherLines += 1;
      if (closingQuote(line, state.quote, 0) !== -1) state.quote = null;
    } else if (state.backslash) {
      otherLines += 1;
      state.backslash = line.trimEnd().endsWith('\\');
      state.quote = openQuoteOf(line);
    } else if (state.block && (blank || /^\s/.test(line))) {
      otherLines += blank ? 0 : 1;
    } else if (state.skipping) {
      state.skipping = !blank;
      otherLines += blank ? 0 : 1;
    } else if (!blank && !line.trimStart().startsWith('#')) {
      state.block = false;
      const definition = splitDefinition(line);
      if (definition === null) {
        otherLines += 1;
        state.skipping = true;
        continue;
      }
      names.add(definition.name);
      state.quote = openQuoteOf(definition.rest);
      state.backslash = state.quote === null && definition.rest.trimEnd().endsWith('\\');
      state.block = definition.colon && BLOCK_SCALAR.test(definition.rest.trim());
    }
  }
  return { names: [...names].sort(), otherLines };
}

const LONE_CARRIAGE_RETURN = /\r(?!\n)/;
const BACKSLASH_BEFORE_QUOTE = /\\["'`]/;
const DEFINITION_LINE = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=(.*)$/;

/** A value that is complete on its line: balanced quotes, nothing after a closing quote but a comment, no heredoc, no trailing backslash, no backslash before a quote. */
function isCompleteValue(value) {
  const text = value.trim();
  if (BACKSLASH_BEFORE_QUOTE.test(text)) return false; // dotenv reads `\"` as an escaped quote, this reader does not: they could disagree on where the value ends
  if (text.endsWith('\\') || text.includes('<<')) return false;
  if ((text[0] === '$' && QUOTES.includes(text[1])) || /^=+$/.test(text)) return false; // bash `$'...'`, base64 padding
  if (!QUOTES.includes(text[0])) return QUOTES.every((quote) => (text.split(quote).length - 1) % 2 === 0);
  const close = closingQuote(text, text[0], 1);
  const after = close === -1 ? 'open' : text.slice(close + 1).trim();
  return after === '' || after.startsWith('#');
}

/**
 * True when the file is regular: every line (split on CRLF, LF) is blank, a comment or ONE complete definition `NAME=value` or
 * `export NAME=value` with no backslash right before a quote character, and the file has no lone CR, no NUL, no PEM header text and no heredoc marker. Anything else is
 * irregular: the reader cannot be sure where a value ends, so the caller shows only names that other files corroborate.
 */
export function isRegularEnvText(text) {
  if (LONE_CARRIAGE_RETURN.test(text) || text.includes('\0') || text.includes(PEM_BEGIN)) return false;
  for (const line of text.replace(BYTE_ORDER_MARK, '').split(/\r\n|\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const match = DEFINITION_LINE.exec(line);
    if (match === null || !isCompleteValue(match[1])) return false;
  }
  return true;
}

const notRead = (reason) => ({ names: [], otherLines: 0, status: `${reason}, not read` });

/**
 * Reads one env file from disk. Only a regular file is read, through one descriptor opened without following links or blocking
 * (see read-regular-file.mjs): a symlink, a FIFO, a socket or a device is not, even if the path is swapped during the scan.
 * A binary or oversized file is not read.
 * @param {string} path absolute path of the file
 * @returns {{ names: string[], otherLines: number, irregular?: true, status?: string }} `status` is set when the file was not read
 */
export function readEnvFile(path) {
  try {
    const { bytes, skipped } = readRegularFile(path, MAX_ENV_FILE_BYTES);
    if (skipped !== undefined) return notRead(skipped);
    if (bytes.includes(0)) return notRead('binary');
    const content = bytes.toString('utf8');
    const result = namesFromEnvText(content);
    // A line the parser had to count as `other` is also a reason to doubt the file, whatever the line check says.
    return isRegularEnvText(content) && result.otherLines === 0 ? result : { ...result, irregular: true };
  } catch (err) {
    return notRead(`unreadable (${err.code ?? 'error'})`);
  }
}
