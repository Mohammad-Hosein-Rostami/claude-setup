// The entries of one project agents folder, walked the way Claude Code loads it, under fixed limits and never through a link.
// Exports: agentEntries(dir, shown, budget), readAgentFile(path), newBudget(), MAX_AGENT_FILES, MAX_WALKED_ENTRIES, AGENT_HEAD_BYTES.
// Read from the Claude Code 2.1.328 bundle and probed on that CLI (an agent in a subfolder and one behind a folder link are loaded;
// `UPPER.MD` is not):
//   F2(): UZ(["--files","--hidden","--follow","--no-ignore","--glob","*.md"],e,...)   ripgrep, or the CLI's own walk XDr(): the
//     folder is walked recursively, hidden entries included, links to folders and to files followed, names ending in .md taken.
//   rE(...,k,JKt) with JKt=1048576: only a regular file of at most 1 MiB is read.
// Re-read in the 2.1.329 bundle: RK() passes the same ripgrep arguments, now under `AbortSignal.timeout(3000)`: a scan that takes
// longer loads nothing from that folder. The 1 MiB read limit was not found again there (not re-read).
// The files come from whatever repository the session opens, so they are untrusted. Invariants: read-only; never throws (an
// unreadable folder or file counts as nothing there). Nothing is read through a link: a link is reported by its name, a linked folder
// is not entered, and a regular file is opened with O_NOFOLLOW and O_NONBLOCK and checked again on the open handle (a FIFO, device or
// folder is never read). A file with more than one hard link is not read either: its other name may lie outside the project.
// Bounded work: at most MAX_WALKED_ENTRIES entries are looked at and at most MAX_AGENT_FILES files read (AGENT_HEAD_BYTES of each),
// over all the folders that share one budget, and subfolders are entered at most MAX_FOLDER_DEPTH levels down (the walk calls
// itself once per level). Every entry past a limit is still reported, by name only, as 'unread' or 'folder-not-read', so the note
// can count it. The listing of one folder itself is not bounded (100,000 names measured 123 ms, 500,000 several seconds): the
// SessionStart hook therefore runs the whole note in a child process with a timeout (project-agents-timed.mjs).
import { constants, lstatSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readFileHead } from './agent-brief.mjs';

export const MAX_AGENT_FILES = 200; // a real project has a few dozen agents at most
export const MAX_WALKED_ENTRIES = 5000; // files, folders and links looked at, in all the agents folders of one session
export const AGENT_HEAD_BYTES = 8 * 1024; // the frontmatter sits at the top; a longer file is cut there
const MAX_FOLDER_DEPTH = 32; // levels of subfolders entered below an agents folder: deeper than any real project keeps agents
const AGENT_FILE = /\.md$/i; // wider than the CLI's `*.md`: a file it does not load may be reported, never the other way round
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0); // Windows has neither flag: lstat stands alone

/** A fresh budget for one session's walk: how many files may still be read and how many entries looked at. */
export const newBudget = () => ({ files: MAX_AGENT_FILES, entries: MAX_WALKED_ENTRIES });

/** The entries of a folder sorted by name, so that the same files are read on every run; none when it cannot be listed. */
function sortedEntries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : Number(a.name > b.name)));
  } catch {
    return [];
  }
}

/** Whether a link leads to a folder (the CLI would walk into it); false when it leads nowhere. */
function leadsToFolder(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * What the walk does with one entry, taking it from the budget.
 * @returns {'folder' | 'file' | 'unread' | 'link' | 'linked-folder' | 'folder-not-read' | undefined} `folder`: walk into it; `file`:
 *   an agent file to read; `unread`: an agent file past a limit; `link`: a link named like an agent file; `folder-not-read`: a folder,
 *   or a link that may lead to one, past the entry limit; undefined: nothing the CLI would load.
 */
function kindOf(dir, entry, budget) {
  const isAgentFile = AGENT_FILE.test(entry.name);
  budget.entries -= 1;
  if (budget.entries < 0) {
    if (isAgentFile) return 'unread';
    return entry.isDirectory() || entry.isSymbolicLink() ? 'folder-not-read' : undefined;
  }
  if (entry.isSymbolicLink()) {
    if (leadsToFolder(join(dir, entry.name))) return 'linked-folder';
    return isAgentFile ? 'link' : undefined;
  }
  if (entry.isDirectory()) return 'folder';
  if (!entry.isFile() || !isAgentFile) return undefined;
  budget.files -= 1;
  return budget.files < 0 ? 'unread' : 'file';
}

/**
 * Every entry of an agents folder that the note may have something to say about, subfolders included, in name order.
 * @param {string} dir - a real folder (the caller has checked that no link leads to it).
 * @param {string} shown - the folder as the note names it, ending in `/`.
 * @param {{ files: number, entries: number }} budget - from newBudget(); shared by all the folders of one session and counted down.
 * @param {number} [depth] - how many levels below the agents folder `dir` lies; a subfolder MAX_FOLDER_DEPTH levels down is
 *   reported as 'folder-not-read' instead of entered.
 * @yields {{ folder: string, name: string, path: string, kind: 'file' | 'unread' | 'link' | 'linked-folder' | 'folder-not-read' }}
 */
export function* agentEntries(dir, shown, budget, depth = 0) {
  for (const entry of sortedEntries(dir)) {
    const kind = kindOf(dir, entry, budget);
    const path = join(dir, entry.name);
    const tooDeep = kind === 'folder' && depth >= MAX_FOLDER_DEPTH;
    if (kind === 'folder' && !tooDeep) yield* agentEntries(path, `${shown}${entry.name}/`, budget, depth + 1);
    else if (kind !== undefined) yield { folder: shown, name: entry.name, path, kind: tooDeep ? 'folder-not-read' : kind };
  }
}

/**
 * The head of one agent file, when it is a regular file with a single name.
 * @param {string} path - the file.
 * @returns {{ kind: 'file', head: string, cutShort: boolean } | { kind: 'link' | 'hard-link' | 'gone' }} `cutShort`: the file is
 *   longer than the head that was read; `link`: a link was swapped in after the folder was listed; `gone`: no regular file is there
 *   any more, or it cannot be read.
 */
export function readAgentFile(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return { kind: 'link' };
    if (!stat.isFile()) return { kind: 'gone' };
    if (stat.nlink > 1) return { kind: 'hard-link' };
    return { kind: 'file', head: readFileHead(path, AGENT_HEAD_BYTES, OPEN_FLAGS) ?? '', cutShort: stat.size > AGENT_HEAD_BYTES };
  } catch {
    return { kind: 'gone' }; // gone, a link swapped in after the lstat (ELOOP), or unreadable: nothing found
  }
}
