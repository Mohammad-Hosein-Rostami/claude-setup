// The files a CLAUDE.md pulls in by whole-line `@path` imports, as Claude Code loads them: the installer's ~/.claude/CLAUDE.md is
// a marker line plus `@<repo>/home/CLAUDE.md` and `@<repo>/personal/CLAUDE.md`, so a size count of the file alone misses the rules.
// Exports: IMPORT_MAX_HOPS, importedFiles(text, dir, read), fileWithImports(path, label, read).
// Invariants: only a line that is nothing but `@<path>` counts (an `@` inside prose or code is never followed); `~/` is the home
// folder, a relative path is relative to the importing file's folder; at most IMPORT_MAX_HOPS hops deep and each file once, so an
// import loop ends; every read goes through the caller's `read`, which decides how a file is opened and capped.
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** How deep Claude Code follows `@` imports (the Claude Code memory docs, as the layering spec section 6 records them: 4 hops). */
export const IMPORT_MAX_HOPS = 4;
const IMPORT_LINE = /^@(\S+)\s*$/;

/**
 * The files `text` imports, depth first, each with its own text.
 * @param {string} text the importing file's text
 * @param {string} dir the importing file's folder (relative imports start there)
 * @param {(path: string) => string | null} read the text of a file, or null when it is not counted (missing, a FIFO, too big)
 * @returns {{ path: string, text: string }[]} every imported file that `read` gave text for
 */
export function importedFiles(text, dir, read) {
  const seen = new Set();
  const follow = (from, folder, hop) => {
    if (hop > IMPORT_MAX_HOPS) return [];
    return from.split(/\r?\n/).flatMap((line) => {
      const spec = IMPORT_LINE.exec(line)?.[1];
      if (!spec) return [];
      const path = spec.startsWith('~/') ? join(homedir(), spec.slice(2)) : resolve(folder, spec);
      if (seen.has(path)) return [];
      seen.add(path);
      const found = read(path);
      return found === null ? [] : [{ path, text: found }, ...follow(found, dirname(path), hop + 1)];
    });
  };
  return follow(text, dir, 1);
}

/**
 * A CLAUDE.md and every file it imports, the way a size count needs them.
 * @param {string} path the CLAUDE.md
 * @param {string} label how the CLAUDE.md itself is named in the rows (`~/.claude/CLAUDE.md`)
 * @param {(path: string) => string | null} read as for importedFiles
 * @returns {{ path: string, text: string }[]} the file first, then its imports; empty when `read` gives no text for it
 */
export function fileWithImports(path, label, read) {
  const text = read(path);
  return text === null ? [] : [{ path: label, text }, ...importedFiles(text, dirname(path), read)];
}
