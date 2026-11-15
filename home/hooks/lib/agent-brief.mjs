// What agent-model-guard.mjs reads for an Agent brief and the lines it adds to one. Each line is fixed text plus at most one path:
// nothing from the prompt or from STATUS.md is ever copied into it.
// - Standing rules (every subagent type): a brief that does not contain "STATUS.md" gets one line before it naming the project's
//   STATUS.md, when that file's `## Standing rules` section has a non-empty line. Inside git the project is the top folder of the work
//   tree the call's cwd belongs to (of its superproject when cwd is in a submodule), and its STATUS.md counts only while git does not
//   track it and ignores it (.gitignore, .git/info/exclude or the global ignore file): the owner's own note, never a file a repository
//   brings, and never one in a subfolder. Outside git the project is cwd itself. The agent reads the file itself.
// - Design lists (architect and Plan): a brief without "Reuse inventory" gets one line after it asking for the Reuse inventory and
//   Contract facts lists, with unstated product facts under "Unconfirmed".
// Each line holds the text that suppresses it, so a brief is never extended twice. A STATUS.md is read only as a regular file whose real
// path is inside the project: a link out of it is ignored. Only its first MAX_STATUS_BYTES are read. Git runs without a shell, with fixed
// arguments (the path after `--`) and at most GIT_TIMEOUT_MS per call; git missing, slow or failing means no rules line.
// Exports: withBriefLines(toolInput, cwd) -> input | null, readFileHead(path, maxBytes) -> text | undefined (the UI brief gate reads its
// matrix with it too), UNPRINTABLE. Invariants: withBriefLines never throws (any failure: null, the brief stays as it is); bounded work
// (at most 3 git calls and 1 read of at most MAX_STATUS_BYTES).
import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const STATUS_FILE = 'STATUS.md';
const MAX_STATUS_BYTES = 1024 * 1024; // only the start of a longer STATUS.md is read; the rules section sits near the top
const GIT_TIMEOUT_MS = 1000; // per git call: a normal one takes about 10 ms, and three of them stay inside the hook's 5 s
// git's message (in the C locale) when no folder from cwd up is a repository; "not a git repository: <path>" (a broken link) is a failure
const OUTSIDE_GIT = /not a git repository \(or any/;
const UNTRACKED_EXIT = 1; // `git ls-files --error-unmatch` for a path the index does not hold (a failure exits 128)
const IGNORED_EXIT = 0; // `git check-ignore -q` for an ignored path (1: not ignored, which a tracked file never is)
const RULES_HEADING = '## Standing rules';
const SECTION_END = /^#{1,2}[ \t]/; // the next heading of level 1 or 2 ends the section
const DESIGN_TYPES = ['architect', 'Plan'];
const REUSE_WORDS = 'Reuse inventory';
const DESIGN_LISTS = 'Your spec must include "Reuse inventory" (the existing component, string or helper for each need, or none: <search used>) '
  + 'and "Contract facts" (every default, fallback, limit and enum the API schema states, and what the design does about each); '
  + 'list product facts the repo does not state under "Unconfirmed".';
export const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu; // control and format characters (bidi marks included) and line separators
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0); // a FIFO swapped in after a stat never blocks (POSIX only)

const rulesLine = (path) => `Read "## Standing rules" in ${path.replace(UNPRINTABLE, '')} first; where they differ from this brief, follow them.`;

/**
 * The start of a regular file, read through a handle that is checked again after the open.
 * @param {string} path the file (the caller has checked with stat that it is a regular file: a FIFO or device is never opened)
 * @param {number} maxBytes the most that is read
 * @returns {string | undefined} its first maxBytes as UTF-8; undefined when the open handle is not a regular file
 * @throws {Error} when the file cannot be opened (the callers catch it)
 */
export function readFileHead(path, maxBytes) {
  const fd = openSync(path, READ_FLAGS);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) return undefined;
    const buffer = Buffer.alloc(Math.min(opened.size, maxBytes));
    return buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, 0));
  } finally {
    closeSync(fd);
  }
}

/** @returns {boolean} true when the real path `path` is the real folder `project` or inside it */
function isInside(path, project) {
  const rest = relative(project, path);
  return !isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`);
}

/** @returns {boolean} true when path is a regular file inside project whose `## Standing rules` section has a non-empty line */
function hasStandingRules(path, project) {
  try {
    const real = realpathSync(path);
    if (!isInside(real, project) || !statSync(real).isFile()) return false; // a link out of the project, a folder, FIFO or device
    const lines = (readFileHead(real, MAX_STATUS_BYTES) ?? '').split(/\r?\n/);
    const start = lines.findIndex((line) => line.trimEnd() === RULES_HEADING);
    const section = start === -1 ? [] : lines.slice(start + 1);
    const end = section.findIndex((line) => SECTION_END.test(line));
    return (end === -1 ? section : section.slice(0, end)).some((line) => line.trim() !== '');
  } catch {
    return false; // missing or unreadable: no rules to point at
  }
}

/** Runs git in cwd: no shell, fixed arguments, the C locale (so its messages can be matched), at most GIT_TIMEOUT_MS; never throws. */
const runGit = (args, cwd) => spawnSync('git', args, {
  cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true, env: { ...process.env, LC_ALL: 'C' },
});

/**
 * @param {string} cwd the call's folder
 * @returns {string | null | undefined} the top folder of the work tree cwd belongs to, or of its superproject when cwd is in a submodule;
 *   null outside git; undefined when git is missing, too slow or fails
 */
function workTreeTop(cwd) {
  // git prints the superproject's top (only inside a submodule) before the work tree's own, so the first line is the one wanted
  const result = runGit(['rev-parse', '--show-superproject-working-tree', '--show-toplevel'], cwd);
  if (result.status === 0) return result.stdout.split(/\r?\n/)[0] || undefined;
  return result.error === undefined && OUTSIDE_GIT.test(result.stderr) ? null : undefined;
}

/** @returns {boolean} true when git does not track the STATUS.md at the top folder `top` and ignores it */
const isLocalNote = (top) => runGit(['ls-files', '--error-unmatch', '--', STATUS_FILE], top).status === UNTRACKED_EXIT
  && runGit(['check-ignore', '-q', '--', STATUS_FILE], top).status === IGNORED_EXIT;

/** @returns {string | undefined} the project's STATUS.md when it has standing rules and may be named (see the header) */
function standingRulesFile(cwd) {
  const top = workTreeTop(cwd);
  if (top === undefined) return undefined; // git missing or failing: no line
  const project = top ?? resolve(cwd);
  const path = join(project, STATUS_FILE);
  return hasStandingRules(path, realpathSync(project)) && (top === null || isLocalNote(top)) ? path : undefined;
}

/**
 * The Agent input with the brief lines added (see the header): the rules line first, the design line last.
 * @param {unknown} toolInput the call's tool_input, or the copy the model routing made of it
 * @param {unknown} cwd the call's cwd; when it is not a string, this process's folder
 * @returns {object | null} a copy of toolInput with the longer prompt; null when no line applies or anything fails
 */
export function withBriefLines(toolInput, cwd) {
  try {
    const prompt = toolInput?.prompt;
    if (typeof prompt !== 'string') return null;
    const rules = prompt.includes(STATUS_FILE) ? undefined : standingRulesFile(typeof cwd === 'string' ? cwd : process.cwd());
    const design = DESIGN_TYPES.includes(toolInput.subagent_type) && !prompt.includes(REUSE_WORDS);
    if (rules === undefined && !design) return null;
    const lines = [...(rules === undefined ? [] : [rulesLine(rules)]), prompt, ...(design ? [DESIGN_LISTS] : [])];
    return { ...toolInput, prompt: lines.join('\n') };
  } catch {
    return null; // a reminder, not a rule: any failure leaves the brief as it is
  }
}
