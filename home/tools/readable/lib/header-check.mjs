// Purpose: check that a source file opens with a comment that says what the file is for (rule C26).
// Exports: hasHeaderComment(path, text), findMissingHeader(path, text).
// Invariants: pure; a shebang line and a directive such as 'use strict' or "use client" before the comment are allowed;
//   an empty file is not flagged; only the kind of comment that fits the language counts.

const SLASH_STYLE = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'go', 'rs', 'java', 'kt', 'php', 'cs', 'c', 'cpp', 'h', 'swift']);
const HASH_STYLE = new Set(['py', 'rb', 'sh']);
const DIRECTIVE = /^(['"])use [a-z ]+\1;?$/;

const extensionOf = (path) => path.slice(path.lastIndexOf('.') + 1).toLowerCase();

function openingComment(ext, line) {
  if (SLASH_STYLE.has(ext)) return line.startsWith('//') || line.startsWith('/*');
  if (HASH_STYLE.has(ext)) return line.startsWith('#') || (ext === 'py' && /^[rRuU]?("""|''')/.test(line));
  return true; // an unknown language is never flagged
}

/** @returns {boolean} true when the first real line of the file is a comment (or the file is empty) */
export function hasHeaderComment(path, text) {
  const ext = extensionOf(path);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#!') || DIRECTIVE.test(line)) continue;
    return openingComment(ext, line);
  }
  return true;
}

/** C26: a source file with no header comment gives one finding on line 1. */
export function findMissingHeader(path, text) {
  if (hasHeaderComment(path, text)) return [];
  return [{
    path, line: 1, rule: 'C26', check: 'no-header', files: [path],
    message: 'the file does not open with a comment.',
    fix: 'start it with 2-4 lines: what the file is for, what it exports, what must stay true.',
  }];
}
