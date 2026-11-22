// The model and effort an agent file pins, and the floor they set: a per-call value may raise a pin, never lower it.
// Exports: readPin(agentType, cwd), floorDrops(call, pin), flooredAgentInput(toolInput, cwd).
// Why: Claude Code ranks the Agent call's `model` above the agent file's frontmatter, so a lower per-call value silently
// undoes the pin (recommendations item 2). agent-model-guard.mjs drops such a value from the call; it never adds one.
// The agent file: `<cwd>/.claude/agents/<type>.md` when it exists, else `<home>/.claude/agents/<type>.md` (a project agent
// replaces a personal one of the same name). The first file found decides, also when it pins nothing or cannot be read.
// The type comes from the call, so it is untrusted: it must match TYPE_PATTERN before any path is joined.
// Order: model family haiku < sonnet < opus, found as a substring of the value; effort low < medium < high < xhigh < max.
// A value outside both (fable, inherit, ultra, two families in one id, an id over 100 characters or with a character outside
// A-Z a-z 0-9 . _ - [ ]) is unknown and never dropped or rewritten; a pin that is unknown or missing sets no floor.
// Invariants: read-only (no file is written, so two calls at once cannot collide); one file of at most MAX_AGENT_FILE_BYTES
// read per call; LF and CRLF frontmatter read alike.
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileHead } from './agent-brief.mjs';
import { frontmatterOf } from './agent-frontmatter.mjs';

const TYPE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_AGENT_FILE_BYTES = 64 * 1024; // 64 KB: an agent file is a few KB; a bigger one is not read at all
const CONFIG_FOLDER = '.claude';
const AGENTS_FOLDER = 'agents';
const AGENT_FILE_SUFFIX = '.md';
const FAMILY_ORDER = ['haiku', 'sonnet', 'opus'];
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
const KNOWN_MODEL_TEXT = /^[A-Za-z0-9._\-[\]]{1,100}$/; // aliases and full ids such as claude-opus-5-5[1m]; anything else is unknown
const PIN_LINE = /^(model|effort):[ \t]*(.*?)[ \t]*$/; // a top-level key line; deeper lines belong to other keys
const LINE_END = /\r\n|\n|\r/;
const TRAILING_COMMENT = /[ \t]+#.*$/;
const QUOTED = /^(["'])(.*)\1$/;

/** @returns {string | null} a key's value without quotes or a trailing comment; null for an empty value */
function pinValue(raw) {
  const value = raw.replace(TRAILING_COMMENT, '');
  const unquoted = QUOTED.exec(value)?.[2] ?? value;
  return unquoted === '' ? null : unquoted;
}

/** @returns {{ model: string | null, effort: string | null }} the top-level model and effort lines; the last of a repeated key wins */
function pinOf(text) {
  const pin = { model: null, effort: null };
  const found = frontmatterOf(text);
  if (found.kind !== 'closed') return pin;
  for (const line of found.text.split(LINE_END)) {
    const match = PIN_LINE.exec(line);
    if (match) pin[match[1]] = pinValue(match[2]);
  }
  return pin;
}

/**
 * The model and effort an agent's own file pins.
 * @param {string} agentType - the call's subagent_type (untrusted).
 * @param {string} cwd - the call's folder; its `.claude/agents` is looked at first.
 * @returns {{ model: string | null, effort: string | null } | null} null for a type outside TYPE_PATTERN, no agent file, or a
 *   first file found that is not a regular file of at most MAX_AGENT_FILE_BYTES; a null field when the file sets no such line.
 * @throws when a found file cannot be read (the guard catches it and lets the call run).
 */
export function readPin(agentType, cwd) {
  if (typeof agentType !== 'string' || !TYPE_PATTERN.test(agentType)) return null;
  const fileName = `${agentType}${AGENT_FILE_SUFFIX}`;
  for (const base of [cwd, homedir()]) {
    if (typeof base !== 'string' || base === '') continue;
    const path = join(base, CONFIG_FOLDER, AGENTS_FOLDER, fileName);
    const stats = statSync(path, { throwIfNoEntry: false });
    if (stats === undefined) continue;
    if (!stats.isFile() || stats.size > MAX_AGENT_FILE_BYTES) return null;
    const text = readFileHead(path, MAX_AGENT_FILE_BYTES);
    return text === undefined ? null : pinOf(text);
  }
  return null;
}

/** @returns {number} the value's place in `order` (by substring for a model family), or -1 when it is unknown or ambiguous */
function rankOf(value, order, bySubstring) {
  if (typeof value !== 'string' || !KNOWN_MODEL_TEXT.test(value)) return -1;
  const places = order.flatMap((name, place) => ((bySubstring ? value.includes(name) : value === name) ? [place] : []));
  return places.length === 1 ? places[0] : -1;
}

/** @returns {boolean} true only when both values are known and the call's ranks below the pin's */
const isLower = (callValue, pinnedValue, order, bySubstring) => {
  const call = rankOf(callValue, order, bySubstring);
  const pin = rankOf(pinnedValue, order, bySubstring);
  return call >= 0 && pin >= 0 && call < pin;
};

/**
 * Which per-call values lie below the pin.
 * @param {{ model?: unknown, effort?: unknown }} call - the Agent call's input.
 * @param {{ model: string | null, effort: string | null }} pin - from readPin.
 * @returns {{ dropModel: boolean, dropEffort: boolean }} true for a value that is known, lower than a known pin, and so dropped.
 */
export function floorDrops(call, pin) {
  return {
    dropModel: isLower(call.model, pin.model, FAMILY_ORDER, true),
    dropEffort: isLower(call.effort, pin.effort, EFFORT_ORDER, false),
  };
}

/**
 * The Agent call's input with every value below its agent file's pin left out, so the pin applies.
 * @param {unknown} toolInput - `tool_input` of the Agent / Task call (untrusted).
 * @param {string} cwd - the call's folder.
 * @returns {object | null} a copy without the dropped keys, or null when nothing is dropped.
 * @throws when the agent file cannot be read (see readPin).
 */
export function flooredAgentInput(toolInput, cwd) {
  if (toolInput === null || typeof toolInput !== 'object') return null;
  if (toolInput.model === undefined && toolInput.effort === undefined) return null; // no file read for a call that sets neither
  const pin = readPin(toolInput.subagent_type, cwd);
  if (pin === null) return null;
  const { dropModel, dropEffort } = floorDrops(toolInput, pin);
  if (!dropModel && !dropEffort) return null;
  const floored = { ...toolInput };
  if (dropModel) delete floored.model;
  if (dropEffort) delete floored.effort;
  return floored;
}
