// The only code that sees the content of an env file: it returns the variable names and a count of other lines, never a value.
// Exports: namesFromEnvText(text) -> { names, otherLines }; readEnvFile(path) -> { names, otherLines, status? }; MAX_ENV_FILE_BYTES.
// Invariants: of every line only the text left of the first `=` is looked at as a name; the rest of the line is used for one
//   thing, to see whether a quoted value continues on the next lines, and is never stored or returned. Lines inside such a
//   multi-line quoted value, and lines that are not `NAME=...`, are only counted (`otherLines`). A file that cannot be read
//   gives a `status` text built from the error code, never from the error message or the file content.
import { lstatSync, readFileSync } from 'node:fs';

export const MAX_ENV_FILE_BYTES = 16 * 1024 * 1024;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EXPORT_PREFIX = /^export\s+/;
const QUOTES = ['"', "'", '`'];
const BYTE_ORDER_MARK = '﻿';

/** Index of the first unescaped `quote` in `text` at or after `from`, or -1. Only double quotes honour a backslash escape. */
function closingQuote(text, quote, from) {
  for (let i = from; i < text.length; i += 1) {
    if (quote === '"' && text[i] === '\\') i += 1;
    else if (text[i] === quote) return i;
  }
  return -1;
}

/** The quote character that opens a value continuing past this line, or null. `afterEquals` is read, never kept. */
function openQuoteOf(afterEquals) {
  const value = afterEquals.trimStart();
  if (!QUOTES.includes(value[0])) return null;
  return closingQuote(value, value[0], 1) === -1 ? value[0] : null;
}

/** The variable name a line defines (left of the first `=`), or null when the line is not `NAME=...`. */
function nameOfLine(line, equalsAt) {
  const left = line.slice(0, equalsAt).trim().replace(EXPORT_PREFIX, '');
  return NAME_PATTERN.test(left) ? left : null;
}

/**
 * Names defined in env file text and the number of lines that are neither a comment, blank nor `NAME=...`.
 * @param {string} text the file content (any line ends, optional BOM)
 * @returns {{ names: string[], otherLines: number }} names sorted and unique
 */
export function namesFromEnvText(text) {
  const names = new Set();
  let otherLines = 0;
  let openQuote = null;
  for (const line of text.replace(BYTE_ORDER_MARK, '').split(/\r\n|\r|\n/)) {
    if (openQuote !== null) {
      otherLines += 1;
      if (closingQuote(line, openQuote, 0) !== -1) openQuote = null;
      continue;
    }
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const equalsAt = line.indexOf('=');
    const name = equalsAt === -1 ? null : nameOfLine(line, equalsAt);
    if (name === null) {
      otherLines += 1;
      continue;
    }
    names.add(name);
    openQuote = openQuoteOf(line.slice(equalsAt + 1));
  }
  return { names: [...names].sort(), otherLines };
}

const notRead = (reason) => ({ names: [], otherLines: 0, status: `${reason}, not read` });

/**
 * Reads one env file from disk. A symlink is not followed; a binary or oversized file is not read.
 * @param {string} path absolute path of the file
 * @returns {{ names: string[], otherLines: number, status?: string }} `status` is set when the file was not read
 */
export function readEnvFile(path) {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return notRead('link');
    if (info.size > MAX_ENV_FILE_BYTES) return notRead('too large');
    const bytes = readFileSync(path);
    if (bytes.includes(0)) return notRead('binary');
    return namesFromEnvText(bytes.toString('utf8'));
  } catch (err) {
    return notRead(`unreadable (${err.code ?? 'error'})`);
  }
}
