// Purpose: how scripts/share-check.mjs finds a deny word: the list format, the text a word is looked for in, and the pattern of a word.
// Exports: DENY_MAX_BYTES, parseDenyList(text), wordPattern(word), findHits(text, denied), findHitsInBytes(bytes, denied),
//   nameWords(name, denied).
// Invariants:
// - A text is searched after format and default-ignorable characters (zero-width space, joiners, soft hyphen) are removed and NFKC
//   folded, so a fullwidth or zero-width-split word is the word. Line breaks survive both steps, so line numbers stay the file's.
// - A word matches literally (regex characters included) and case-insensitively. A run of white space inside a list entry matches
//   any run of white space, line breaks and no-break spaces included, or a camelCase seam, so a name split over two lines or joined
//   as `QuokkaLtd` still hits (at its first line).
// - Only whole words or word parts hit: a letter or digit beside the word means no hit (`ant` never hits `giant`), unless that edge
//   is a part seam of an identifier: camelCase (`ZebracorpFrontend`), an acronym before a word (`ZEBRACORPFrontend`) or a letter-digit
//   change (`zebracorp2`). `_`, `-`, `/`, spaces and every other non-letter are separators.
// - No bytes are skipped: a UTF-16 BOM decodes as UTF-16; bytes with a NUL are also searched as UTF-8 (NUL as a separator), as UTF-8
//   with the NULs removed (UTF-16 or UTF-32 ASCII at any alignment) and as UTF-16 LE and BE, so a binary or BOM-less file still hits.
// - Every pattern is linear: literal letters, `\s+` or a seam between parts and fixed-width look-arounds, so a hostile file cannot stall it.

/** The largest deny list share-check reads (read as a plain file, no link followed); a larger one is refused. */
export const DENY_MAX_BYTES = 1024 * 1024;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const IGNORED = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const SPACE_RUN = /\s+/u;
// A seam inside a run of letters and digits where an identifier starts a new part: aB, ABc (between A and Bc), a1, 1a.
const SEAM = '(?<=\\p{Ll})(?=\\p{Lu})|(?<=\\p{Lu})(?=\\p{Lu}\\p{Ll})|(?<=\\p{L})(?=\\p{N})|(?<=\\p{N})(?=\\p{L})';
const START = `(?:(?<![\\p{L}\\p{N}])|${SEAM})`;
const END = `(?:(?![\\p{L}\\p{N}])|${SEAM})`;
const UTF16LE_BOM = [0xff, 0xfe];
const UTF16BE_BOM = [0xfe, 0xff];

/**
 * The deny words of a list: one per line, `#` lines and blank lines left out, CRLF and a BOM accepted, duplicates (any case) once.
 * @param {string} text the list file
 * @returns {string[]} the words, trimmed, in list order
 */
export function parseDenyList(text) {
  const seen = new Set();
  const words = [];
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const word = raw.trim();
    if (word === '' || word.startsWith('#') || seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    words.push(word);
  }
  return words;
}

/**
 * A text as it is searched: format and default-ignorable characters removed, then NFKC folded (line breaks kept).
 * @param {string} text any text
 * @returns {string} the folded text
 */
function searchable(text) {
  return text.replace(IGNORED, '').normalize('NFKC').replace(IGNORED, '');
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** One character of a word, matching it in any case (a case form that is longer, as ß and SS, is an alternative). */
function caseless(char) {
  const forms = [...new Set([char, char.toLowerCase(), char.toUpperCase()])].map(escapeRegex);
  return forms.length === 1 ? forms[0] : `(?:${forms.join('|')})`;
}

/**
 * The pattern of one deny word (see the invariants above). It has no `i` flag, so the case of the text decides the part seams.
 * @param {string} word a deny word
 * @returns {RegExp} a global, Unicode pattern over searchable() text
 */
export function wordPattern(word) {
  const chars = [...searchable(word).trim()];
  const body = chars.join('').split(SPACE_RUN).map((part) => [...part].map(caseless).join('')).join(`(?:\\s+|${SEAM})`);
  const before = WORD_CHAR.test(chars.at(0) ?? '') ? START : '';
  const after = WORD_CHAR.test(chars.at(-1) ?? '') ? END : '';
  return new RegExp(`${before}${body}${after}`, 'gu');
}

/** The 1-based line of each offset, from the offsets of the line breaks (sorted). */
function lineAt(breaks, offset) {
  let low = 0;
  let high = breaks.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (breaks[middle] < offset) low = middle + 1;
    else high = middle;
  }
  return low + 1;
}

/**
 * The hits of the deny words in a text: one per line and word, a match over several lines counted at its first line.
 * @param {string} text the content
 * @param {{word: string, pattern: RegExp}[]} denied the words with their patterns (wordPattern)
 * @returns {{line: number, word: string}[]} 1-based line numbers, in line order, then list order
 */
export function findHits(text, denied) {
  const searched = searchable(text);
  const breaks = [...searched.matchAll(/\n/g)].map((match) => match.index);
  const hits = new Map();
  denied.forEach(({ word, pattern }, order) => {
    for (const match of searched.matchAll(pattern)) {
      const line = lineAt(breaks, match.index);
      hits.set(`${line}\n${order}`, { line, order, word });
    }
  });
  return [...hits.values()].sort((a, b) => a.line - b.line || a.order - b.order).map(({ line, word }) => ({ line, word }));
}

const startsWith = (bytes, prefix) => prefix.every((byte, index) => bytes[index] === byte);
const decode = (encoding, bytes) => new TextDecoder(encoding).decode(bytes); // drops a BOM of its own encoding

/** The texts a file's bytes are searched as (see the invariants above). */
function textViews(bytes) {
  const views = [];
  if (startsWith(bytes, UTF16LE_BOM)) views.push(decode('utf-16le', bytes));
  else if (startsWith(bytes, UTF16BE_BOM)) views.push(decode('utf-16be', bytes));
  if (!bytes.includes(0)) return views.length === 0 ? [decode('utf-8', bytes)] : views;
  return [...views, decode('utf-8', bytes), decode('utf-8', bytes.filter((byte) => byte !== 0)), decode('utf-16le', bytes), decode('utf-16be', bytes)];
}

/**
 * The hits of the deny words in a file's bytes, over every view of them; a line and word found in two views counts once.
 * @param {Uint8Array} bytes the file content
 * @param {{word: string, pattern: RegExp}[]} denied the words with their patterns
 * @returns {{line: number, word: string}[]} in line order, then list order
 */
export function findHitsInBytes(bytes, denied) {
  const order = new Map(denied.map(({ word }, index) => [word, index]));
  const hits = new Map();
  for (const view of textViews(bytes)) for (const hit of findHits(view, denied)) hits.set(`${hit.line}\n${hit.word}`, hit);
  return [...hits.values()].sort((a, b) => a.line - b.line || order.get(a.word) - order.get(b.word));
}

/**
 * The deny words a file or folder name holds (a path's folders included), in list order.
 * @param {string} name a path
 * @param {{word: string, pattern: RegExp}[]} denied the words with their patterns
 * @returns {string[]} the words
 */
export function nameWords(name, denied) {
  const searched = searchable(name);
  return denied.filter(({ pattern }) => searched.search(pattern) !== -1).map(({ word }) => word);
}
