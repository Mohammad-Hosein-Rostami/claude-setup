// The model and effort an agent file pins, and the floor they set: a per-call value may raise a pin, never lower it.
// Exports: readPin(agentType, cwd, env), floorDrops(call, pin), flooredAgentInput(toolInput, cwd, env).
// Why: Claude Code ranks the Agent call's `model` above the agent file's frontmatter, so a lower per-call value silently
// undoes the pin (recommendations item 2). agent-model-guard.mjs drops such a value from the call; it never adds one.
// Which file: the one Claude Code loads. Read from the Claude Code 2.1.329 bundle (minified names):
//   dkr(): the personal folder is jl()/agents (jl: the config folder, CLAUDE_CONFIG_DIR or ~/.claude); the project folders are
//     Ioe(): every <folder>/.claude/agents from the session folder up, stopping before the home folder and after the git root
//     (lib/agent-folders.mjs walks the same way), plus int(): the main checkout's .claude/agents for a linked worktree whose root
//     has none. RK()/ukr(): every `*.md` file below a folder, at any depth, links followed.
//   nTn()/R5r(): a file is an agent only with a string `name` and a string `description`; its type is `name`, never the file name.
//   Oee(): a Map by type filled in the order personal, then project folders sorted by tPe() (fewer path separators first), so
//     the deepest project folder wins, and any project agent beats the personal one.
//   Pqo(): the model is the call's, else the file's, else CLAUDE_CODE_SUBAGENT_MODEL (unless "inherit"); AKs(): an agent without
//     `effort` gets CLAUDE_CODE_SUBAGENT_EFFORT when set. So a file that pins nothing is floored at those defaults.
// Safe side: a file whose frontmatter is not in the plain subset (lib/agent-frontmatter.mjs), a folder reached through a link the
// walk does not follow, a walk that may miss folders further up, or two files of one type with different pins: no floor, since
// the loaded pin is not known. A file Claude Code skips (no name or description, no closed frontmatter, over 1 MB,
// not a `.md` file) is skipped here too; a frontmatter still open after the first 64 KB read is unsure.
// The type comes from the call, so it is untrusted: it must match TYPE_PATTERN before any path is joined.
// Order: model family haiku < sonnet < opus (by substring), then, inside a family, the version of a full id (claude-opus-4-1 <
// claude-opus-5-5; an alias has none and ranks equal); effort low < medium < high < xhigh < max. A value outside both (fable,
// inherit, ultra, two families in one id, an id over 100 characters or with a character outside A-Z a-z 0-9 . _ - [ ]) is
// unknown and never dropped or rewritten; a pin that is unknown or missing sets no floor.
// Invariants: read-only (no file is written, so two calls at once cannot collide); at most MAX_FILES_PER_FOLDER files of at most
// MAX_AGENT_FILE_BYTES read per folder, MAX_FOLDER_DEPTH folders deep; LF and CRLF frontmatter read alike.
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { gitDirOf, nearestGitEntry, readFileHead, sharedGitDir } from './agent-brief.mjs';
import { frontmatterOf, plainFrontmatter } from './agent-frontmatter.mjs';
import { agentFolders } from './agent-folders.mjs';

const TYPE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_AGENT_FILE_BYTES = 64 * 1024; // 64 KB: an agent file is a few KB; only this much of a bigger one is read
const MAX_MARKDOWN_BYTES = 1048576; // e8t in the CLI: a bigger markdown file is skipped ("exceeds 1048576 byte limit")
const MAX_FILES_PER_FOLDER = 500; // far above a real agents folder; more makes the folder "unsure" instead of a long scan
const MAX_FOLDER_DEPTH = 8; // subfolders below an agents folder
const CONFIG_FOLDER = '.claude';
const AGENTS_FOLDER = 'agents';
const GIT_ENTRY = '.git';
const AGENT_FILE_SUFFIX = '.md';
const FAMILY_ORDER = ['haiku', 'sonnet', 'opus'];
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
const KNOWN_MODEL_TEXT = /^[A-Za-z0-9._\-[\]]{1,100}$/; // aliases and full ids such as claude-opus-5-5[1m]; anything else is unknown
const PIN_LINE = /^(model|effort|description):[ \t]*(.*?)[ \t]*$/; // a top-level key line; deeper lines belong to other keys
const LINE_END = /\r\n|\n|\r/;
const TRAILING_COMMENT = /[ \t]+#.*$/;
const QUOTED = /^(["'])(.*)\1$/;
const UNSURE = Object.freeze({ state: 'unsure' });
const NOT_FOUND = Object.freeze({ state: 'none' });

/** @returns {string | null} a key's value without quotes or a trailing comment; null for an empty value */
function pinValue(raw) {
  const value = raw.replace(TRAILING_COMMENT, '');
  const unquoted = QUOTED.exec(value)?.[2] ?? value;
  return unquoted === '' ? null : unquoted;
}

/**
 * What one file says about the agent type asked for.
 * @returns {'skip' | 'unsure' | { model: string | null, effort: string | null }} `skip`: not that agent (or no agent at all);
 *   `unsure`: a frontmatter outside the plain subset, which may or may not name it; else the pin of that agent.
 */
function fileVerdict(path, agentType) {
  const size = statSync(path).size;
  if (size > MAX_MARKDOWN_BYTES) return 'skip';
  const text = readFileHead(path, MAX_AGENT_FILE_BYTES);
  const found = text === undefined ? undefined : frontmatterOf(text);
  if (found?.kind === 'open' && size > MAX_AGENT_FILE_BYTES) return 'unsure'; // a frontmatter longer than the part read
  if (found?.kind !== 'closed') return 'skip';
  const plain = plainFrontmatter(found.text);
  if (!plain.plain) return 'unsure';
  if (plain.name !== agentType) return 'skip';
  const lines = { model: null, effort: null, description: null };
  for (const line of found.text.split(LINE_END)) {
    const match = PIN_LINE.exec(line);
    if (match) lines[match[1]] = pinValue(match[2]);
  }
  return lines.description === null ? 'skip' : { model: lines.model, effort: lines.effort };
}

/** @returns {string[] | undefined} the `.md` files below `folder` (links followed, each folder once), or undefined past the caps */
function agentFiles(folder) {
  const files = [];
  const seen = new Set();
  const pending = [{ path: folder, depth: 0 }];
  while (pending.length > 0) {
    const { path, depth } = pending.shift();
    const stats = statSync(path, { throwIfNoEntry: false, bigint: true });
    if (!stats?.isDirectory() || seen.has(`${stats.dev}:${stats.ino}`)) continue;
    seen.add(`${stats.dev}:${stats.ino}`);
    for (const name of readdirSync(path)) {
      const entry = join(path, name);
      const kind = statSync(entry, { throwIfNoEntry: false }); // a dangling link: skipped, as the CLI does
      if (kind?.isDirectory()) {
        if (depth >= MAX_FOLDER_DEPTH) return undefined;
        pending.push({ path: entry, depth: depth + 1 });
      } else if (kind?.isFile() && name.endsWith(AGENT_FILE_SUFFIX)) files.push(entry);
      if (files.length > MAX_FILES_PER_FOLDER) return undefined;
    }
  }
  return files;
}

/** @returns {{ state: 'none' | 'unsure' } | { state: 'found', pin: { model: string | null, effort: string | null } }} */
function folderVerdict(folder, agentType) {
  const files = agentFiles(folder);
  if (files === undefined) return UNSURE;
  const pins = [];
  for (const file of files) {
    const verdict = fileVerdict(file, agentType);
    if (verdict === 'unsure') return UNSURE;
    if (verdict !== 'skip') pins.push(verdict);
  }
  if (pins.length === 0) return NOT_FOUND;
  const same = pins.every(({ model, effort }) => model === pins[0].model && effort === pins[0].effort);
  return same ? { state: 'found', pin: pins[0] } : UNSURE; // which of two files the CLI keeps is not known
}

/** @returns {string | undefined} the main checkout's agents folder of the linked worktree the session folder is in */
function mainCheckoutAgents(sessionDir) {
  const found = nearestGitEntry(sessionDir);
  const gitDir = found?.entry.isFile() ? gitDirOf(found.top, found.entry) : undefined;
  const shared = gitDir === undefined ? undefined : sharedGitDir(gitDir);
  if (shared === undefined) return undefined;
  return join(basename(shared) === GIT_ENTRY ? dirname(shared) : shared, CONFIG_FOLDER, AGENTS_FOLDER);
}

/**
 * The project agents folders, the one Claude Code ranks highest first.
 * @returns {{ folders: string[], unsure: boolean } | undefined} `unsure`: the CLI may also load folders further up (lower ranked than
 *   these, higher than the personal one); undefined when a folder lies behind a link the walk does not follow.
 */
function projectFolders(sessionDir, personalDir) {
  const walk = agentFolders(sessionDir, homedir(), personalDir);
  if (walk.folders.some(({ kind }) => kind !== 'real')) return undefined; // a link the walk does not follow
  const folders = walk.folders.map(({ path }) => path);
  const main = walk.mainCheckout ? mainCheckoutAgents(sessionDir) : undefined;
  if (main !== undefined) folders.push(main);
  const depth = (path) => path.split(sep).length;
  // tPe sorts by depth with a stable sort and the later folder wins: deepest first, and on a tie the later one (the main checkout)
  const ranked = folders.map((path, at) => ({ path, at })).sort((a, b) => depth(b.path) - depth(a.path) || b.at - a.at);
  return { folders: ranked.map(({ path }) => path), unsure: walk.unsure };
}

/**
 * The model and effort pinned by the agent file Claude Code loads for this type.
 * @param {string} agentType - the call's subagent_type (untrusted).
 * @param {string} cwd - the session folder the project walk starts from.
 * @param {Record<string, string | undefined>} env - CLAUDE_CONFIG_DIR (the personal folder).
 * @returns {{ model: string | null, effort: string | null } | null} null for a type outside TYPE_PATTERN, no agent of that type,
 *   or no certain answer (see the header); a null field when the file sets no such line.
 * @throws when a file or folder cannot be read (the guard catches it and lets the call run).
 */
export function readPin(agentType, cwd, env = process.env) {
  if (typeof agentType !== 'string' || !TYPE_PATTERN.test(agentType)) return null;
  const personal = join(env.CLAUDE_CONFIG_DIR || join(homedir(), CONFIG_FOLDER), AGENTS_FOLDER);
  const project = typeof cwd === 'string' && cwd !== '' ? projectFolders(cwd, personal) : { folders: [], unsure: false };
  if (project === undefined) return null;
  for (const folder of project.folders) {
    const verdict = folderVerdict(folder, agentType);
    if (verdict.state !== 'none') return verdict.state === 'found' ? verdict.pin : null;
  }
  if (project.unsure) return null; // a project folder further up may hold the agent, and it would beat the personal one
  const personalVerdict = folderVerdict(personal, agentType);
  return personalVerdict.state === 'found' ? personalVerdict.pin : null;
}

/** @returns {number[] | null} [family, major, minor] of a model value (-1 for no version), or null when it is unknown */
function modelRank(value) {
  if (typeof value !== 'string' || !KNOWN_MODEL_TEXT.test(value)) return null;
  const families = FAMILY_ORDER.filter((name) => value.includes(name));
  if (families.length !== 1) return null;
  const [family] = families;
  // claude-opus-4-1-20250805 and claude-opus-5-5 (version after the family), claude-3-5-sonnet-20241022 (before it); a date is no version
  const version = new RegExp(`${family}-(\\d{1,2})(?!\\d)(?:-(\\d{1,2})(?!\\d))?`).exec(value)
    ?? new RegExp(`(?:^|-)(\\d{1,2})(?:-(\\d{1,2}))?-${family}`).exec(value);
  return [FAMILY_ORDER.indexOf(family), Number(version?.[1] ?? -1), Number(version?.[2] ?? 0)];
}

/** @returns {boolean} true only when both model values are known and the call's ranks below the pin's */
function isLowerModel(callValue, pinnedValue) {
  const call = modelRank(callValue);
  const pin = modelRank(pinnedValue);
  if (call === null || pin === null) return false;
  if (call[0] !== pin[0]) return call[0] < pin[0];
  if (call[1] < 0 || pin[1] < 0) return false; // an alias names no version: equal to any id of its family
  return call[1] < pin[1] || (call[1] === pin[1] && call[2] < pin[2]);
}

/** @returns {boolean} true only when both effort values are known levels and the call's is below the pin's */
function isLowerEffort(callValue, pinnedValue) {
  const call = EFFORT_ORDER.indexOf(callValue);
  const pin = EFFORT_ORDER.indexOf(pinnedValue);
  return call >= 0 && pin >= 0 && call < pin;
}

/**
 * Which per-call values lie below the pin.
 * @param {{ model?: unknown, effort?: unknown }} call - the Agent call's input.
 * @param {{ model: string | null, effort: string | null }} pin - from readPin, with the env defaults filled in.
 * @returns {{ dropModel: boolean, dropEffort: boolean }} true for a value that is known, lower than a known pin, and so dropped.
 */
export function floorDrops(call, pin) {
  return { dropModel: isLowerModel(call.model, pin.model), dropEffort: isLowerEffort(call.effort, pin.effort) };
}

/**
 * The Agent call's input with every value below the pin left out, so the pin applies.
 * @param {unknown} toolInput - `tool_input` of the Agent / Task call (untrusted).
 * @param {string} cwd - the call's folder.
 * @param {Record<string, string | undefined>} env - CLAUDE_CODE_SUBAGENT_MODEL and CLAUDE_CODE_SUBAGENT_EFFORT: the floor for a
 *   file without a `model` or `effort` line, as Claude Code applies them; CLAUDE_CONFIG_DIR.
 * @returns {object | null} a copy without the dropped keys, or null when nothing is dropped.
 * @throws when an agent file or folder cannot be read (see readPin).
 */
export function flooredAgentInput(toolInput, cwd, env = process.env) {
  if (toolInput === null || typeof toolInput !== 'object') return null;
  if (toolInput.model === undefined && toolInput.effort === undefined) return null; // no file read for a call that sets neither
  const pin = readPin(toolInput.subagent_type, cwd, env);
  if (pin === null) return null;
  const withDefaults = { model: pin.model ?? env.CLAUDE_CODE_SUBAGENT_MODEL ?? null, effort: pin.effort ?? env.CLAUDE_CODE_SUBAGENT_EFFORT ?? null };
  const { dropModel, dropEffort } = floorDrops(toolInput, withDefaults);
  if (!dropModel && !dropEffort) return null;
  const floored = { ...toolInput };
  if (dropModel) delete floored.model;
  if (dropEffort) delete floored.effort;
  return floored;
}
