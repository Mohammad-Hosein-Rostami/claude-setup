// The Bash guard's rule for its own files (F13 of round 9): a write, removal, link or FIFO under ~/.claude/private (the production-host
// list) or the guard's own state (its remembered allows, its bounce records, its log) asks, since it would change what the guard knows.
// Reading them is allowed. Read by pre-bash-guard.mjs.
// Exports: checkGuardStateWrite(cmd, words, cwd) -> reason | undefined.
// Paths are read as written (`~` and `$HOME` expanded, relative ones from the command's folder); a path with another expansion, or a relative
// one in an unknown folder, is not judged. On macOS and Windows the comparison ignores case (APFS and NTFS do).
// Invariants: pure apart from reading homedir() and the state folder names; never touches the file system; only adds asks.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { allowedLiteralsDir } from './allowed-literals.mjs';
import { bouncedDir } from './bounce-once.mjs';
import { GUARD_LOG_FILE } from './guard-log.mjs';
import { expandHome, isUnder, nativePath } from './rm-paths.mjs';
import { OUTPUT_REDIRECT, QUOTED_MARK, flagsOf, withoutRedirects } from './shell-words.mjs';
import { shown } from './verdict.mjs';

// commands that change the files they are given; for these only the last path is written (the others are read)
const WRITERS = new Set(['rm', 'rmdir', 'unlink', 'mv', 'ln', 'mkfifo', 'mknod', 'tee', 'touch', 'truncate', 'chmod', 'chown', 'chflags', 'shred', 'mkdir']);
const LAST_PATH_WRITERS = new Set(['cp', 'install', 'rsync']);
const IN_PLACE_EDITORS = new Set(['sed', 'perl']);
const CASELESS_PATHS = process.platform === 'darwin' || process.platform === 'win32'; // APFS and NTFS: `~/.Claude/Private` is the same folder

/** ~/.claude/private (the production-host list) and the guard's own state: what a write there would change in the guard itself. */
const guardStatePaths = () => [join(homedir(), '.claude', 'private'), allowedLiteralsDir(), bouncedDir(), GUARD_LOG_FILE].map((path) => resolve(path));

/** The paths this command writes: redirection targets, and the paths a writer changes. */
function writtenPaths(cmd, words) {
  const redirected = words.flatMap((word, i) => {
    const match = OUTPUT_REDIRECT.exec(word);
    return match === null ? [] : [match[2] || (words[i + 1] ?? '')];
  });
  const paths = withoutRedirects(words).filter((word) => !word.startsWith('-') && word !== cmd);
  const changed = WRITERS.has(cmd) ? paths : LAST_PATH_WRITERS.has(cmd) ? paths.slice(-1) : [];
  const edited = IN_PLACE_EDITORS.has(cmd) && flagsOf(words).some((flag) => /^-[a-zA-Z]*i/.test(flag)) ? paths : [];
  const copied = cmd === 'dd' ? words.filter((word) => word.startsWith('of=')).map((word) => word.slice(3)) : [];
  return [...redirected, ...changed, ...edited, ...copied];
}

/**
 * A write, removal, link or FIFO under ~/.claude/private or the guard's own state asks: it would change what the guard knows
 * (the production hosts, the remembered allows, the bounce records, the log).
 * @param {string} cmd the command name
 * @param {string[]} words the words before the command and its arguments
 * @param {string | null} cwd the folder the command runs in (null: relative paths are not judged)
 * @returns {string | undefined} the ask reason, or undefined
 */
export function checkGuardStateWrite(cmd, words, cwd) {
  const fold = (path) => (CASELESS_PATHS ? path.toLowerCase() : path);
  const protectedPaths = guardStatePaths().map(fold);
  const hit = writtenPaths(cmd, words).find((written) => {
    const path = nativePath(expandHome(written.replace(QUOTED_MARK, '')));
    if (path === '' || /[$`]/.test(path) || (cwd === null && !path.startsWith('/') && !/^[a-zA-Z]:/.test(path))) return false;
    const abs = fold(resolve(cwd ?? '/', path));
    return protectedPaths.some((root) => abs === root || isUnder(root, abs));
  });
  return hit === undefined ? undefined : `changes the guard's own files (${shown(hit)}): ~/.claude/private and the guard's state hold its settings; confirm it`;
}
