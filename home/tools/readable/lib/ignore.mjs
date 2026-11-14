// Purpose: read .gitignore text and say whether a path is ignored, so `readable` skips what git skips.
// Exports: parseGitignore(text), matchRules(rules, relPath, isDir).
// Invariants: pure; paths are posix and relative to the folder that holds the .gitignore; the last matching rule wins;
//   supports comments, `!` negation, a trailing `/` (folders only), a leading or inner `/` (anchored), `*`, `?`, `**`.

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

/** Turns one glob (no leading `!`, no trailing `/`) into a regex source. */
function globToRegexSource(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const rest = glob.slice(i);
    if (rest.startsWith('**/')) { out += '(?:.*/)?'; i += 2; }
    else if (rest.startsWith('/**')) { out += '/.*'; i += 2; }
    else if (rest.startsWith('**')) { out += '.*'; i += 1; }
    else if (glob[i] === '*') out += '[^/]*';
    else if (glob[i] === '?') out += '[^/]';
    else out += glob[i].replace(REGEX_SPECIALS, '\\$&');
  }
  return out;
}

/**
 * Parses .gitignore text into rules.
 * @param {string} text file content
 * @returns {{negate: boolean, dirOnly: boolean, regex: RegExp}[]}
 */
export function parseGitignore(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    if (line === '') continue;
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    const source = globToRegexSource(line);
    rules.push({ negate, dirOnly, regex: new RegExp(anchored ? `^${source}$` : `^(?:.*/)?${source}$`) });
  }
  return rules;
}

/**
 * Decides one path against one rule list.
 * @returns {boolean|null} true ignored, false re-included by `!`, null when no rule matches
 */
export function matchRules(rules, relPath, isDir) {
  let result = null;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (rule.regex.test(relPath)) result = !rule.negate;
  }
  return result;
}
