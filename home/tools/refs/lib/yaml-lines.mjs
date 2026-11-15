// Purpose: read the few YAML keys refs needs, line by line, without a YAML library. Only plain, quoted and `- item`
//   values are understood; anything else (anchors, flow lists, block scalars, templates) comes back as null, so a
//   reader skips it instead of guessing.
// Exports: scanYaml.
// Invariants: every entry is {line, key, value, isItem, parents}: `key` is null for a bare `- value` item, `value` is
//   null when the value is not a plain or quoted scalar, `parents` are the keys that enclose the entry (by
//   indentation). `- key: value` is one entry with isItem true. Lines inside a block scalar (`|`, `>`) are skipped.
const KEY_LINE = /^("[^"]*"|'[^']*'|[^\s'"#\-&*[{|>!%@`][^#]*?|-[^\s#][^#]*?)\s*:(?:\s+|$)(.*)$/;
const UNSUPPORTED_START = /^[&*[{|>!%@`]/;

/** The scalar in `raw` (trailing comment removed): {value, opensBlock, blockScalar}. value is null when unsupported or empty. */
function readScalar(raw) {
  const text = raw.trim();
  if (text === '' || text.startsWith('#')) return { value: null, opensBlock: true, blockScalar: false };
  if (text[0] === '"' || text[0] === "'") {
    const close = text[0] === '"' ? text.slice(1).search(/(?<!\\)"/) : text.slice(1).search(/'(?!')/);
    return { value: close === -1 ? null : text.slice(1, close + 1), opensBlock: false, blockScalar: false };
  }
  if (UNSUPPORTED_START.test(text)) return { value: null, opensBlock: false, blockScalar: /^[|>]/.test(text) };
  return { value: text.replace(/\s+#.*$/, '').trim(), opensBlock: false, blockScalar: false };
}

function splitLine(text) {
  const match = /^(\s*)(-(?:\s+|$))?(.*)$/.exec(text);
  const indent = match[1].length;
  const dash = match[2] ?? null;
  const rest = match[3];
  const key = KEY_LINE.exec(rest);
  return { indent, isItem: dash !== null, contentIndent: indent + (dash?.length ?? 0), key, rest };
}

/**
 * @param {string} text YAML file content
 * @returns {{line: number, key: string|null, value: string|null, isItem: boolean, parents: string[]}[]}
 */
export function scanYaml(text) {
  const entries = [];
  const stack = []; // {indent, key} of the open mappings
  let blockIndent = null; // indentation of the key whose block scalar is being skipped
  text.replace(/^﻿/, '').split(/\r?\n/).forEach((lineText, index) => {
    const trimmed = lineText.trim();
    if (trimmed === '' || (blockIndent !== null && /^\s*/.exec(lineText)[0].length > blockIndent)) return;
    blockIndent = null;
    if (trimmed.startsWith('#') || trimmed === '---' || trimmed === '...') return;
    const { indent, isItem, contentIndent, key, rest } = splitLine(lineText);
    const keyIndent = isItem ? contentIndent : indent;
    while (stack.length > 0 && (key === null ? stack.at(-1).indent > indent : stack.at(-1).indent >= keyIndent)) stack.pop();
    const scalar = readScalar(key === null ? rest : key[2]);
    const keyName = key === null ? null : key[1].replace(/^(["'])(.*)\1$/, '$2');
    entries.push({ line: index + 1, key: keyName, value: scalar.value, isItem, parents: stack.map((open) => open.key) });
    if (key !== null && scalar.opensBlock) stack.push({ indent: keyIndent, key: keyName });
    if (scalar.blockScalar) blockIndent = keyIndent;
  });
  return entries;
}
