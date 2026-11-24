// The UI brief gate of agent-model-guard.mjs: denies once with advice for UI briefs. A `dev-pixel` or `pixel-qa` call is quiet when
// its prompt has a line that starts (after optional blanks) with `MATRIX: <path>` naming a coverage matrix (a JSON object with a
// `surfaces` array; a relative path starts at the call's cwd, `~` is the home folder; the whole value, else matrixPathToken, so a trailing
// note is allowed) or with `MATRIX: none: <reason>` for any change with no visual part (15+ characters, and only when the brief names no
// Figma, frame, baseline or design export anywhere, its MATRIX lines included: such a brief needs a matrix, G7, and a `none:` reason that
// names one is no way around it). Otherwise it is denied once with the ui-coverage init advice and the identical call sent again runs:
// lib/bounce-once.mjs adviceOnce keeps the digest of cwd, type and prompt in this session's store and logs "advice", "advice-retry" or
// "advice-unrecorded" with the subagent type, the digest and a fixed reason class only (no prompt text). The MATRIX lines are checked in
// order, at most MAX_MATRIX_LINES, and the first usable one ends the check.
// A quality hint, not a safety rule: never the owner, and any failure lets the call run. The path comes from the prompt, so it is
// untrusted: it is stat-ed and read only as a regular file of at most MAX_MATRIX_BYTES, never run, its content never printed, a value
// longer than MAX_PATH_CHARS or a UNC or device path (two leading slashes or backslashes) is never looked up; the deny text quotes it
// cleaned and cut (lib/agent-brief.mjs quotedValue). Only these two types load the Bash guard's modules (bounce-once.mjs, imported when
// needed), so the guard's model routing never depends on them.
// Exports: uiBriefDeny(input, env) (the gate), matrixLines, matrixPathToken, namesDesignSource (pure), MAX_MATRIX_BYTES.
// Invariants: never throws; denies an identical call at most once per session.
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { quotedValue, readFileHead } from './agent-brief.mjs';

const UI_AGENT_TYPES = ['dev-pixel', 'pixel-qa']; // the agents of the pixel path (dev-pixel builds, pixel-qa is its final gate)
// A line that starts with `MATRIX:` after optional blanks. Lines end at \n; a CRLF line's \r is left out of the value.
const MATRIX_LINE = /(?:^|\n)[ \t]*MATRIX:([^\r\n]*)/g;
const MAX_MATRIX_LINES = 5; // a brief names one matrix; the cap bounds the files read for one call
const NONE_PREFIX = 'none:';
const MIN_REASON_CHARS = 15; // what ui-coverage asks of every reason
const MAX_PATH_CHARS = 4096; // PATH_MAX on Linux: a longer value is not looked up
export const MAX_MATRIX_BYTES = 2 * 1024 * 1024; // 2 MB: far above a real matrix (a few KB); bounds the memory and time of one read
const HOME_PREFIX = /^~(?=$|[\\/])/; // `~` and `~/...`; `~user` is left as it is
// A UNC or device path (\\host\share, //host/share, \\.\pipe\x): on Windows a lookup reaches the network (and may send the user's
// NTLM credentials) or a pipe, so a value written like that is never looked up
const NETWORK_PATH = /^[\\/]{2}/;
const NOT_STARTED = 'Not started: the UI brief names no coverage matrix (the owner was not asked).';
const INIT_ADVICE = 'Before the first UI lane run `node ~/.claude/tools/ui-coverage/ui-coverage.mjs init <matrix.json> --locales .. --widths .. '
  + '--surfaces .. [--frames frames.json]` and add the line `MATRIX: <path>` (or `MATRIX: none: <reason>` for any change with no visual part).';
const SEND_AGAIN = 'Send the same call again unchanged and it runs.';
const SHORT_REASON = `\`MATRIX: none:\` needs a reason of ${MIN_REASON_CHARS} or more characters.`;
const NONE_WITH_DESIGN = '`MATRIX: none:` is for a change with no visual part: this brief names Figma, a frame, a baseline or an export '
  + '(its `none:` reason counts too), so it needs a coverage matrix.';
const QUOTE_MARKS = '"\'`'; // a path in these marks may hold blanks
const TOKEN_END_MARKS = ',;'; // sentence punctuation after the path token, never part of a matrix path
// What makes a brief design work (G7). "export" counts unless it is the JS keyword (`export default`, `export const`, `export {`).
const DESIGN_SOURCE = /figma|فیگما|\bframes?\b|\bbaselines?\b|\bexport(?:s|ed)?\b(?!\s+(?:default|const|let|var|function|async|class|type|interface|enum|\{|\*))/i;
// The log names the problems by these fixed classes, never by prompt text
const NO_MATRIX_LINE = 'no MATRIX line';
const PROBLEM_CLASSES = new Map([[SHORT_REASON, 'short none reason'], [NONE_WITH_DESIGN, 'none with a design source']]);
const problemClass = (problem) => PROBLEM_CLASSES.get(problem) ?? 'not a matrix';

/**
 * Whether the brief names a design source anywhere, its MATRIX lines included: a `none:` reason that names Figma or a frame ("match
 * Figma frame 12:34, no matrix needed") marks design work as surely as any other line, so it never lets a design brief skip the matrix.
 * @param {string} prompt the Agent call's prompt
 * @returns {boolean} true when it names Figma, a frame, a baseline or an export
 */
export function namesDesignSource(prompt) {
  return DESIGN_SOURCE.test(prompt);
}

/**
 * The values of a prompt's MATRIX lines. Only a line that starts with `MATRIX:` after optional blanks counts (a line inside a code
 * fence too); `MATRIX:` later in a line never does.
 * @param {string} prompt the Agent call's prompt
 * @returns {string[]} the text after each `MATRIX:`, trimmed, empty ones left out; at most MAX_MATRIX_LINES
 */
export function matrixLines(prompt) {
  const values = [];
  for (const [, text] of prompt.matchAll(MATRIX_LINE)) {
    const value = text.trim();
    if (value !== '') values.push(value);
    if (values.length === MAX_MATRIX_LINES) break;
  }
  return values;
}

/** @returns {boolean} true when path is a regular file of at most MAX_MATRIX_BYTES holding a JSON object with a `surfaces` array */
function isMatrixFile(path) {
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > MAX_MATRIX_BYTES) return false; // a folder, FIFO, device or bigger file is never opened
    const text = readFileHead(path, MAX_MATRIX_BYTES);
    return text !== undefined && Array.isArray(JSON.parse(text)?.surfaces); // of all JSON values only an object has a `surfaces` key
  } catch {
    return false; // missing, unreadable or not JSON: not a matrix
  }
}

/**
 * @param {boolean} designBrief the brief names a design source (namesDesignSource), so `none:` is refused
 * @returns {string | undefined} undefined for a usable matrix or an allowed `none:` reason, else the advice line naming the problem
 */
function matrixProblem(value, cwd, env, designBrief) {
  if (value.startsWith(NONE_PREFIX)) {
    if (value.slice(NONE_PREFIX.length).trim().length < MIN_REASON_CHARS) return SHORT_REASON;
    return designBrief ? NONE_WITH_DESIGN : undefined;
  }
  const usable = [...new Set([value, matrixPathToken(value)])].some((path) => path.length <= MAX_PATH_CHARS && !NETWORK_PATH.test(path)
    && isMatrixFile(resolve(cwd, path.replace(HOME_PREFIX, () => env.HOME || env.USERPROFILE || homedir()))));
  return usable ? undefined : `\`${quotedValue(value)}\` does not exist or is not a matrix.`;
}

/**
 * The first path token of a MATRIX value (pure, linear), so a trailing note (`docs/matrix.json (3 surfaces)`) is no part of the path; the
 * gate tries the whole value first, so an unquoted path with blanks reads as before. @param {string} value a matrixLines value
 * @returns {string} a path in quote marks up to its closing mark, else the text up to the first blank without a trailing `,` or `;` */
export function matrixPathToken(value) {
  const close = QUOTE_MARKS.includes(value[0]) ? value.indexOf(value[0], 1) : -1;
  if (close !== -1) return value.slice(1, close);
  const blank = value.search(/\s/);
  let end = blank === -1 ? value.length : blank;
  while (end > 0 && TOKEN_END_MARKS.includes(value[end - 1])) end -= 1;
  return value.slice(0, end);
}

const denyOutput = (reason) => `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`;

/**
 * The UI brief gate (see the header): the deny for a dev-pixel or pixel-qa call whose prompt names no usable coverage matrix,
 * given once per identical call.
 * @param {unknown} input the hook input: tool_input {subagent_type, prompt}, cwd (else this process's folder), session_id
 * @param {Record<string, string | undefined>} env process environment (HOME for `~` and the store, CLAUDE_GUARD_LOG)
 * @returns {Promise<string>} the deny JSON line on the first send; '' when the gate is quiet, on the identical retry, when the send
 *   cannot be recorded, and on any failure
 */
export async function uiBriefDeny(input, env = process.env) {
  try {
    const { subagent_type: type, prompt } = input?.tool_input ?? {};
    if (!UI_AGENT_TYPES.includes(type) || typeof prompt !== 'string') return '';
    const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
    const problems = [];
    const designBrief = namesDesignSource(prompt);
    for (const value of matrixLines(prompt)) {
      const problem = matrixProblem(value, cwd, env, designBrief);
      if (problem === undefined) return ''; // one usable MATRIX line is enough: the files named after it are never read
      problems.push(problem);
    }
    const advice = [...new Set(problems), INIT_ADVICE];
    const logged = { type, class: problems.length === 0 ? NO_MATRIX_LINE : [...new Set(problems.map(problemClass))].join(', ') };
    const { adviceOnce } = await import('./bounce-once.mjs');
    // adviceOnce stores the digest (the identical retry runs) and logs the send as `logged`; its deny text is worded for Bash, so the gate
    // words its own
    const recorded = adviceOnce(advice, { command: `${type}: ${prompt}`, cwd, input, hook: 'agent-model-guard', tool: 'Agent', logged }, env);
    return recorded === '' ? '' : denyOutput([NOT_STARTED, ...advice.map((line) => `- ${line}`), SEND_AGAIN].join('\n'));
  } catch {
    return ''; // a quality hint, not a safety rule: any failure lets the call run
  }
}
