// Purpose: reader for *.md and *.mdc files: relative links that point nowhere (md-link) and backticked paths that look
//   like they were meant to exist (md-path?, a hint).
// Exports: readMarkdown.
// Invariants: fenced code and inline code are never searched for links. A link is relative to the markdown file, or to
//   the scanned folder when it starts with `/`; `#anchor` and `?query` are removed first. A backticked token is a hint
//   only when its first segment is a top-level folder of the scanned directory and the full path is missing.
import { dirname } from 'node:path';
import { resolveRef } from './ref-path.mjs';

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const LINK = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const SCHEME = /^([a-z][a-z0-9+.-]*:|\/\/|#)/i;
const TEMPLATE = /\{\{|\$\{/;
const NOT_A_PATH = /[\s*<>{}$()[\]|\\,;:"'=?!^&]/;

/** Lines outside fenced code blocks: [{line, text}]. */
function proseLines(text) {
  const lines = [];
  let fence = null;
  text.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((raw, index) => {
    const marker = FENCE.exec(raw)?.[1];
    if (fence !== null) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    } else if (marker !== undefined) fence = marker;
    else lines.push({ line: index + 1, text: raw });
  });
  return lines;
}

/** The path a link target points to, without anchor and query, or null when it is not a local path. */
function linkPath(target) {
  const path = target.replace(/^<|>$/g, '').replace(/[#?].*$/, '');
  return path === '' || SCHEME.test(path) || TEMPLATE.test(path) ? null : path;
}

function decoded(path) {
  try {
    return decodeURI(path);
  } catch {
    return path; // a lone % is a literal character
  }
}

/** True when the link target exists, as written or with %XX escapes decoded. */
function linkExists(disk, file, path) {
  const base = path.startsWith('/') ? disk.root : dirname(file.abs);
  const relative = path.startsWith('/') ? `.${path}` : path;
  return disk.exists(resolveRef(base, relative)) || disk.exists(resolveRef(base, decoded(relative)));
}

function linkResults(prose, file, disk) {
  const results = [];
  for (const { line, text } of prose) {
    const withoutCode = text.replace(/(`+)[^`]*\1/g, (code) => ' '.repeat(code.length));
    for (const match of withoutCode.matchAll(LINK)) {
      const path = linkPath(match[1]);
      if (path !== null && !linkExists(disk, file, path)) results.push({ kind: 'md-link', value: path, line });
    }
  }
  return results;
}

function backtickedPath(token) {
  const path = token.replace(/^\.\//, '').replace(/[#].*$/, '').replace(/:\d+(?::\d+)?$/, '');
  return path.includes('/') && !path.includes('...') && !NOT_A_PATH.test(path) && !path.startsWith('/') && !path.includes('://') ? path : null;
}

function pathHintResults(prose, { disk, topFolders }) {
  const results = [];
  for (const { line, text } of prose) {
    for (const match of text.matchAll(/`([^`\n]+)`/g)) {
      const path = backtickedPath(match[1]);
      if (path !== null && topFolders.has(path.split('/')[0]) && !disk.exists(resolveRef(disk.root, path))) results.push({ kind: 'md-path?', value: path, line });
    }
  }
  return results;
}

/**
 * @param {{abs: string, text: string}} file markdown file
 * @param {{disk: import('./disk.mjs').Disk, topFolders: Set<string>}} context
 */
export function readMarkdown(file, context) {
  const prose = proseLines(file.text);
  return [...linkResults(prose, file, context.disk), ...pathHintResults(prose, context)];
}
