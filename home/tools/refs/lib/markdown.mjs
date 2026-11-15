// Purpose: reader for *.md and *.mdc files: relative links that point nowhere (md-link) and backticked paths that look
//   like they were meant to exist (md-path?, a hint).
// Exports: readMarkdown.
// Invariants: fenced code and inline code are never searched for links. A link is relative to the markdown file; one that starts with `/` (site root) or points outside the scanned
//   folder is skipped; a target may hold balanced parentheses or be written in `<...>`. `#anchor` and `?query` are removed first. A backticked token is a hint
//   only when its first segment is a top-level folder of the scanned directory, the full path is missing and it is
//   not an npm name (`@scope/pkg`, or a dependency of a scanned package.json).
import { dirname, relative } from 'node:path';
import { resolveRef } from './ref-path.mjs';

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const LINK_CLOSE = /^\s*(?:"[^"]*"|'[^']*')?\s*\)/; // after the target: an optional title, then the closing parenthesis
const NOT_LOCAL = /^([a-z][a-z0-9+.-]*:|\/|#)/i; // a scheme, a site-root path (`/api/users`, `//host`) or a bare anchor
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
  return path === '' || NOT_LOCAL.test(path) || TEMPLATE.test(path) ? null : path;
}

function decoded(path) {
  try {
    return decodeURI(path);
  } catch {
    return path; // a lone % is a literal character
  }
}

/** The raw link targets of a line: after each `](` read `<...>` or text with balanced parentheses, then require the closing `)`. */
function linkTargets(text) {
  const targets = [];
  for (const opening of text.matchAll(/\]\(/g)) {
    let index = opening.index + 2;
    while (text[index] === ' ') index += 1;
    const start = index;
    if (text[index] === '<') index = text.indexOf('>', index) + 1;
    else for (let depth = 0; index < text.length && (depth > 0 || text[index] !== ')') && !/\s/.test(text[index]); index += 1) depth += (text[index] === '(') - (text[index] === ')');
    if (index > 0 && LINK_CLOSE.test(text.slice(index))) targets.push(text.slice(start, index));
  }
  return targets;
}

/** True when the link target exists, as written or with %XX escapes decoded. */
function linkExists(disk, file, path) {
  const base = dirname(file.abs);
  return disk.exists(resolveRef(base, path)) || disk.exists(resolveRef(base, decoded(path)));
}

function linkResults(prose, file, disk) {
  const results = [];
  for (const { line, text } of prose) {
    const withoutCode = text.replace(/(`+)[^`]*\1/g, (code) => ' '.repeat(code.length));
    for (const target of linkTargets(withoutCode)) {
      const path = linkPath(target);
      const outside = path !== null && relative(disk.root, resolveRef(dirname(file.abs), path)).startsWith('..');
      if (path !== null && !outside && !linkExists(disk, file, path)) results.push({ kind: 'md-link', value: path, line });
    }
  }
  return results;
}

function backtickedPath(token) {
  const path = token.replace(/^\.\//, '').replace(/[#].*$/, '').replace(/:\d+(?::\d+)?$/, '');
  return path.includes('/') && !path.includes('...') && !NOT_A_PATH.test(path) && !path.startsWith('/') && !path.includes('://') ? path : null;
}

/** True for a token that is an npm name, not a project path: `@scope/pkg`, or `pkg/sub` when pkg is a dependency of a scanned package.json. */
const isNpmName = (path, dependencies) => path.startsWith('@') || dependencies.has(path.split('/')[0]);

function pathHintResults(prose, { disk, dependencies }) {
  const topFolders = new Set(disk.entries(disk.root).filter((entry) => entry.isDir).map((entry) => entry.name));
  const results = [];
  for (const { line, text } of prose) {
    for (const match of text.matchAll(/`([^`\n]+)`/g)) {
      const path = backtickedPath(match[1]);
      if (path !== null && !isNpmName(path, dependencies) && topFolders.has(path.split('/')[0]) && !disk.exists(resolveRef(disk.root, path))) results.push({ kind: 'md-path?', value: path, line });
    }
  }
  return results;
}

/**
 * @param {{abs: string, text: string}} file markdown file
 * @param {{disk: import('./disk.mjs').Disk, dependencies: Set<string>}} context
 */
export function readMarkdown(file, context) {
  const prose = proseLines(file.text);
  return [...linkResults(prose, file, context.disk), ...pathHintResults(prose, context)];
}
