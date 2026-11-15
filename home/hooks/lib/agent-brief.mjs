// What agent-model-guard.mjs reads for an Agent brief and the lines it adds to one. Each line is fixed text plus at most one path:
// nothing from the prompt or from STATUS.md is ever copied into it.
// - Standing rules (every subagent type): when the call's cwd, or a folder above it up to the git root (at most MAX_PARENT_LEVELS up;
//   outside git, cwd only), holds a STATUS.md whose `## Standing rules` section has a non-empty line, and the brief does not contain
//   "STATUS.md", one line naming the nearest such file goes before the brief. The agent reads the file itself.
// - Design lists (architect and Plan): a brief without "Reuse inventory" gets one line after it asking for the Reuse inventory and
//   Contract facts lists, with unstated product facts under "Unconfirmed".
// Each line holds the text that suppresses it, so a brief is never extended twice. A STATUS.md is read only as a regular file whose real
// path is inside the project (the git root, or cwd outside git): a link out of it is ignored. Only its first MAX_STATUS_BYTES are read.
// Exports: withBriefLines(toolInput, cwd) -> input | null, readFileHead(path, maxBytes) -> text | undefined (the UI brief gate reads its
// matrix with it too), UNPRINTABLE. Invariants: withBriefLines never throws (any failure: null, the brief stays as it is); bounded work
// (at most 6 folders, 6 reads of at most MAX_STATUS_BYTES).
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const STATUS_FILE = 'STATUS.md';
const MAX_PARENT_LEVELS = 5; // how far above cwd the git root is looked for
const MAX_STATUS_BYTES = 1024 * 1024; // only the start of a longer STATUS.md is read; the rules section sits near the top
const RULES_HEADING = '## Standing rules';
const SECTION_END = /^#{1,2}[ \t]/; // the next heading of level 1 or 2 ends the section
const DESIGN_TYPES = ['architect', 'Plan'];
const REUSE_WORDS = 'Reuse inventory';
const DESIGN_LISTS = 'Your spec must include "Reuse inventory" (the existing component, string or helper for each need, or none: <search used>) '
  + 'and "Contract facts" (every default, fallback, limit and enum the API schema states, and what the design does about each); '
  + 'list product facts the repo does not state under "Unconfirmed".';
export const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu; // control and format characters (bidi marks included) and line separators
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0); // a FIFO swapped in after a stat never blocks (POSIX only)

const rulesLine = (path) => `Read "## Standing rules" in ${path.replace(UNPRINTABLE, '')} first; they are the owner's and override this brief.`;

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

/** @returns {string | undefined} the nearest STATUS.md with standing rules, from cwd up to the git root (see the header) */
function standingRulesFile(cwd) {
  const folders = [resolve(cwd)];
  while (folders.length <= MAX_PARENT_LEVELS && dirname(folders.at(-1)) !== folders.at(-1)) folders.push(dirname(folders.at(-1)));
  const root = folders.findIndex((folder) => existsSync(join(folder, '.git')));
  const searched = root === -1 ? folders.slice(0, 1) : folders.slice(0, root + 1);
  const project = realpathSync(searched.at(-1));
  return searched.map((folder) => join(folder, STATUS_FILE)).find((path) => hasStandingRules(path, project));
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
