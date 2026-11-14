// Purpose: find keys in yaml, toml, ini and example-env files that have no comment explaining them (rule C35).
// Exports: configKind(path), findUncommentedKeys(path, text, changedLines, removedText).
// Invariants: pure. json is exempt (it cannot hold comments). A key is covered by an inline comment, a comment on the line
//   directly above, a comment on its enclosing section (yaml parent key, toml or ini [section]), or, in an env file, a
//   comment that opens its block of lines. `changedLines` is a Set of 1-based line numbers, or null for "every line"; a
//   line whose key also appears in `removedText` (the lines the change deleted) is an edited key, not a new one, and is
//   skipped. Not checked: locale files (every key is a message) and the CI step keys `uses` and `run`.

import { isLocaleFile } from './exemptions.mjs';

const ENV_EXAMPLE = /(^|\/)(\.env(\.[\w-]+)*\.(example|sample|template)|[\w-]*\.env\.(example|sample|template))$/i;
const KEY_PATTERNS = {
  yaml: /^(\s*)(?:-\s+)?("[^"]+"|'[^']+'|[^\s#:'"-][^:#]*?)\s*:(?:\s|$)/,
  toml: /^(\s*)([\w."'-]+)\s*=/,
  ini: /^(\s*)([^\s=:;#[][^=:]*?)\s*[=:]/,
  env: /^(\s*)(?:export\s+)?([A-Za-z_]\w*)=/,
};
const STEP_KEYS = new Set(['uses', 'run']); // CI workflow steps: the key is the instruction, not a setting
const SECTION_HEADER = /^\s*\[[^\]]+\]/;

/** @returns {'yaml'|'toml'|'ini'|'env'|null} the config format a path uses, or null when it is not one we check */
export function configKind(path) {
  if (isLocaleFile(path)) return null;
  if (ENV_EXAMPLE.test(path)) return 'env';
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'yml' || ext === 'yaml') return 'yaml';
  if (ext === 'toml') return 'toml';
  if (ext === 'ini' || ext === 'cfg') return 'ini';
  return null;
}

const isCommentLine = (kind, line) => line.trim().startsWith('#') || (kind === 'ini' && line.trim().startsWith(';'));
const hasInlineComment = (kind, line) => /\s#/.test(line) || (kind === 'ini' && /\s;/.test(line));
const indentOf = (line) => line.length - line.trimStart().length;

/** True when line `index` is explained by a comment on it or just above it. */
function ownComment(kind, lines, index) {
  return hasInlineComment(kind, lines[index]) || (index > 0 && isCommentLine(kind, lines[index - 1]));
}

/** Index of the line that encloses line `index` (yaml parent key, toml/ini section header), or -1. */
function enclosingLine(kind, lines, index) {
  if (kind === 'yaml') {
    const indent = indentOf(lines[index]);
    for (let j = index - 1; j >= 0; j--) {
      const text = lines[j];
      if (text.trim() === '' || isCommentLine(kind, text)) continue;
      if (indentOf(text) < indent && KEY_PATTERNS.yaml.test(text)) return j;
    }
    return -1;
  }
  if (kind === 'toml' || kind === 'ini') {
    for (let j = index - 1; j >= 0; j--) if (SECTION_HEADER.test(lines[j])) return j;
  }
  return -1;
}

/** Env files: a comment that opens the block (no blank line between it and the key) explains the whole block. */
function envBlockComment(lines, index) {
  for (let j = index - 1; j >= 0 && lines[j].trim() !== ''; j--) if (isCommentLine('env', lines[j])) return true;
  return false;
}

function isCovered(kind, lines, index) {
  if (ownComment(kind, lines, index)) return true;
  if (kind === 'env') return envBlockComment(lines, index);
  let parent = enclosingLine(kind, lines, index);
  while (parent >= 0) {
    if (ownComment(kind, lines, parent)) return true;
    parent = enclosingLine(kind, lines, parent);
  }
  return false;
}

/**
 * C35: keys that have no comment. Section headers and comment lines are never keys.
 * @param {string} path file path (decides the format)
 * @param {string} text file content
 * @param {Set<number>|null} changedLines lines to check, or null for all
 * @param {string[]} [removedText] lines the change deleted; their keys count as edited, not added
 * @returns {object[]} findings, one per uncommented key
 */
export function findUncommentedKeys(path, text, changedLines, removedText = []) {
  const kind = configKind(path);
  if (kind === null) return [];
  const editedKeys = new Set(removedText.map((line) => KEY_PATTERNS[kind].exec(line)?.[2].trim()).filter(Boolean));
  const lines = text.split(/\r?\n/);
  const findings = [];
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (changedLines && !changedLines.has(lineNumber)) return;
    if (isCommentLine(kind, line) || (kind !== 'yaml' && SECTION_HEADER.test(line))) return;
    const match = KEY_PATTERNS[kind].exec(line);
    if (!match || isCovered(kind, lines, index)) return;
    const key = match[2].trim();
    if (editedKeys.has(key) || (kind === 'yaml' && STEP_KEYS.has(key))) return;
    findings.push({
      path, line: lineNumber, rule: 'C35', check: 'config-comment', files: [path],
      message: `key "${key}" has no comment.`,
      fix: 'add a short comment saying why the value is what it is (and its unit).',
    });
  });
  return findings;
}
