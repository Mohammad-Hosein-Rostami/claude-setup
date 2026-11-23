// What a project's own AI setup brings, read from its files for the project-merge note (project-merge.mjs).
// Exports: OUR_SWITCHES, SHOWN_VALUE_KEYS, scanProjectSetup(top, cwd, options), teamSetEnv(top), globMatches(pattern, path).
// Read: in every folder from the repository root `top` down to the session folder (at most MAX_FOLDER_LEVELS): CLAUDE.md,
// .claude/CLAUDE.md, CLAUDE.local.md, AGENTS.md, .claude/rules (counted), .claude/skills, .claude/agents, .claude/settings.json,
// .claude/settings.local.json and .mcp.json.
// Trust (P14): every name, path and value here is repository data. Values leave this file only for SHOWN_VALUE_KEYS (a model,
// an effort, a mode, a switch); every other setting, and every other env value, is reported by its key alone, so a secret in a
// project's env never reaches the note. The text layer (project-merge-text.mjs) quotes and caps what it shows.
// Bounds (F4, F5): no link is followed, not even to see what it leads to (a link loop or an automounter in .claude cannot hold
// the hook): `.claude` and every folder are told from an lstat, and a link is reported by its name. Listings are read entry by
// entry, at most MAX_ENTRIES in one scan; files are read only as regular files without waiting (lib/plain-file.mjs), at most
// TEXT_MAX_BYTES (instructions) or SETTINGS_MAX_BYTES (settings, .mcp.json: a bigger file is "not checked"). One deadline
// (`budgetMs`) is checked before each part; a part it stops is named in `notChecked`, never skipped silently. claudeMdExcludes
// globs are matched by globMatches (linear in the pattern times the path squared, no regex built from repository text).
// Invariants: read-only; never throws; the same files give the same answer (listings are sorted), so parallel sessions agree.
import { lstatSync, opendirSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { isInside } from './agent-brief.mjs';
import { readAgentFile } from './agent-file-walk.mjs';
import { frontmatterOf, plainFrontmatter } from './agent-frontmatter.mjs';
import { readPlainFile } from './plain-file.mjs';
import { shownPath } from './shown-name.mjs';

export const OUR_SWITCHES = ['DONE_CHECK_SKIP', 'CLAUDE_POST_EDIT_SKIP', 'CLAUDE_SKILL_ROUTER'];
export const SHOWN_VALUE_KEYS = ['model', 'effortLevel', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
  'CLAUDE_CODE_EFFORT_LEVEL', 'permissions.defaultMode', 'disableAllHooks', ...OUR_SWITCHES]; // every other value: key only

const CLAUDE_FILES = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];
const AGENTS_FILE = 'AGENTS.md';
const LOCAL_FILE = 'CLAUDE.local.md';
const SETTINGS_FILES = ['.claude/settings.local.json', '.claude/settings.json']; // the local file wins: read first
const TEAM_SETTINGS = '.claude/settings.json';
const LOCAL_SETTINGS = '.claude/settings.local.json';
const MCP_FILE = '.mcp.json';
const MAX_FOLDER_LEVELS = 16; // folders below the root on the way to the session folder: deeper than real projects nest
const MAX_ENTRIES = 5000; // folder entries listed in one scan (500 skills, a big rules tree)
const MAX_DEPTH = 8; // subfolder levels walked in .claude/rules and .claude/agents
const MAX_AGENT_FILES = 100; // agent files whose frontmatter is read
const MAX_KEYS = 200; // keys of one settings object, env or hooks map looked at
const MAX_EXCLUDES = 20; // claudeMdExcludes patterns matched; more than this counts as "may hide" (real projects list a few)
const MAX_GLOB_CHARS = 300; // a longer pattern, or a path, is not matched: it counts as "may hide"
const TEXT_MAX_BYTES = 64 * 1024; // the head of an instruction file searched for an @import
const SETTINGS_MAX_BYTES = 256 * 1024; // a real settings file is a few KiB; a 5 MB one is "not checked"
const DEFAULT_BUDGET_MS = 1000;
const MD_FILE = /\.md$/i;
const AGENTS_IMPORT = /(?:^|\s)@(?:\.\/)?AGENTS\.md(?=\s|$)/m;
const NOTE_IMPORT = /(?:^|\s)@\S*project-notes\/[^\s/]+\.md(?=\s|$)/m;
const UNCERTAIN_GLOB = /[[\]{}()!+@\\]/; // glob syntax globMatches does not model: such a pattern "may hide" ours
const CLAUDE_ENV = /^(?:ANTHROPIC|CLAUDE)_/; // variables that change how Claude Code itself runs
const REPLACING_KEYS = ['statusLine', 'outputStyle', 'agent', 'apiKeyHelper']; // project scalars that win over ours
const MODEL_FAMILIES = ['haiku', 'sonnet', 'opus']; // weakest first
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const NO_OURS = Object.freeze({ model: '', subagentModel: '', effortLevel: '', envKeys: new Set(), memoryPaths: [], agentsMdSetting: false });

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const byName = (a, b) => (a.name < b.name ? -1 : Number(a.name > b.name));
const keysOf = (value) => (isObject(value) ? Object.keys(value).slice(0, MAX_KEYS) : []);
const shownRel = (rel, name) => (rel === '' ? name : shownPath(rel, name));

/** The real path of the session folder, or the input itself when it is no string or cannot be resolved. */
function realOrSelf(path) {
  try {
    return typeof path === 'string' ? realpathSync.native(path) : '';
  } catch {
    return path;
  }
}

/** lstat, or null when nothing (or nothing readable) is there. */
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** The entries of a real folder (not a link), sorted, taking each from the scan's entry budget; `state.cut` when it ran out. */
function listFolder(dir, state) {
  if (!lstatOrNull(dir)?.isDirectory()) return [];
  const entries = [];
  let handle;
  try {
    handle = opendirSync(dir);
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      if (state.entries <= 0) { state.cut = true; break; }
      state.entries -= 1;
      entries.push(entry);
    }
  } catch {
    state.cut = true; // unreadable, or gone while listed: what was read stands, the rest is "not checked"
  } finally {
    handle?.closeSync();
  }
  return entries.sort(byName);
}

/** `*.md` files under a folder, subfolders included up to MAX_DEPTH; a link is listed by name (`link`), never entered. */
function markdownFiles(dir, rel, state, depth = 0) {
  const found = [];
  for (const entry of listFolder(dir, state)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && depth < MAX_DEPTH) found.push(...markdownFiles(path, `${rel}${entry.name}/`, state, depth + 1));
    else if (entry.isDirectory()) state.cut = true;
    else if ((entry.isFile() || entry.isSymbolicLink()) && MD_FILE.test(entry.name)) found.push({ path, name: entry.name, link: entry.isSymbolicLink() });
  }
  return found;
}

/** The folders from the root down to the session folder, each with its `.claude` folder when that is a real folder. */
function projectFolders(top, cwd, setup) {
  const here = realOrSelf(cwd); // git prints real paths; the session folder may be spelled through a link (/tmp, a linked HOME)
  const below = here !== '' && here !== top && isInside(here, top) ? relative(top, here).split(sep) : [];
  const folders = [];
  for (let level = 0; level <= Math.min(below.length, MAX_FOLDER_LEVELS); level += 1) {
    const parts = below.slice(0, level);
    const dir = join(top, ...parts);
    if (level > 0 && !lstatOrNull(dir)?.isDirectory()) break; // a link on the way down: the folders below it are not read
    const rel = parts.length ? `${parts.join('/')}/` : '';
    const claude = lstatOrNull(join(dir, '.claude'));
    if (claude?.isSymbolicLink()) setup.notChecked.push(`${shownRel(rel, '.claude')} (a link: not followed)`);
    folders.push({ dir, rel, claude: claude?.isDirectory() ? join(dir, '.claude') : null });
  }
  return folders;
}

/** A JSON file: { value } (undefined when missing) or { problem } (a link, not a regular file, too big, not JSON). */
function readJson(path) {
  const stat = lstatOrNull(path);
  if (stat === null) return { value: undefined };
  if (stat.isSymbolicLink()) return { problem: 'a link: not read' };
  if (!stat.isFile()) return { problem: 'not a regular file' };
  if (stat.size > SETTINGS_MAX_BYTES) return { problem: `larger than ${SETTINGS_MAX_BYTES / 1024} KiB: not read` };
  try {
    return { value: JSON.parse(readPlainFile(path, SETTINGS_MAX_BYTES)) };
  } catch {
    return { problem: 'unreadable or not JSON' };
  }
}

/** The head of a regular instruction file, '' when it is a link or unreadable (it is still listed). */
function instructionHead(path) {
  try {
    return readPlainFile(path, TEXT_MAX_BYTES);
  } catch {
    return '';
  }
}

/** Instructions: which files exist, whether AGENTS.md loads, whether CLAUDE.local.md imports a project note. */
function scanInstructions(folders, setup, { ours }) {
  let claudeFiles = 0;
  let imported = false;
  let hasAgents = false;
  for (const { dir, rel, claude } of folders) {
    for (const name of [...CLAUDE_FILES, AGENTS_FILE]) {
      if (name.startsWith('.claude/') && claude === null) continue;
      const stat = lstatOrNull(join(dir, name));
      if (!stat?.isFile() && !stat?.isSymbolicLink()) continue;
      setup.instructions.push(`${rel}${name}`);
      if (name === AGENTS_FILE) { hasAgents = true; continue; }
      claudeFiles += 1;
      const head = stat.isFile() ? instructionHead(join(dir, name)) : '';
      imported ||= AGENTS_IMPORT.test(head);
      if (name === LOCAL_FILE) setup.localImportsNote ||= NOTE_IMPORT.test(head);
    }
  }
  if (!hasAgents) setup.agentsMdLoads = 'none';
  else if (claudeFiles === 0) setup.agentsMdLoads = 'native';
  else if (imported) setup.agentsMdLoads = 'import';
  else setup.agentsMdLoads = ours.agentsMdSetting ? 'setting' : 'none';
}

/** Rules: the `*.md` files under each .claude/rules. */
function scanRules(folders, setup, { state }) {
  for (const { claude, rel } of folders) if (claude) setup.rules += markdownFiles(join(claude, 'rules'), `${rel}.claude/rules/`, state).length;
}

/** Skills: each .claude/skills/<name> holding a SKILL.md (or a link, listed by name); hidden when ours has that name (any case). */
function scanSkills(folders, setup, { state, personalSkills }) {
  for (const { claude, rel } of folders) {
    if (!claude) continue;
    const dir = join(claude, 'skills');
    for (const entry of listFolder(dir, state)) {
      const isSkill = entry.isSymbolicLink() || (entry.isDirectory() && lstatOrNull(join(dir, entry.name, 'SKILL.md'))?.isFile());
      if (!isSkill) continue;
      setup.skills.push(entry.name);
      if (personalSkills.has(entry.name.toLowerCase())) setup.hiddenSkills.push({ name: entry.name, path: `${rel}.claude/skills/${entry.name}/SKILL.md` });
    }
  }
}

/** One agent file as the note names it: its frontmatter name when plain, else the file's base name with why. */
function agentOf({ path, name, link }) {
  const baseName = name.replace(MD_FILE, '');
  if (link) return { name: baseName, mark: 'a link: not read' };
  const read = readAgentFile(path);
  if (read.kind !== 'file') return { name: baseName, mark: 'not read' };
  const frontmatter = frontmatterOf(read.head);
  if (frontmatter.kind === 'none') return undefined; // Claude Code loads no agent from it
  const plain = frontmatter.kind === 'closed' ? plainFrontmatter(frontmatter.text) : { plain: false };
  if (!plain.plain) return { name: baseName, mark: 'frontmatter not plain' };
  return plain.name === '' ? undefined : { name: plain.name, mark: plain.turns };
}

/** Agents: every `*.md` under .claude/agents, the first MAX_AGENT_FILES read for their name and maxTurns. */
function scanAgents(folders, setup, { state }) {
  const files = folders.flatMap(({ claude, rel }) => (claude ? markdownFiles(join(claude, 'agents'), `${rel}.claude/agents/`, state) : []));
  for (const file of files.slice(0, MAX_AGENT_FILES)) {
    const agent = agentOf(file);
    if (agent) setup.agents.push(agent);
  }
  if (files.length > MAX_AGENT_FILES) setup.notChecked.push(`${files.length - MAX_AGENT_FILES} agent files past ${MAX_AGENT_FILES} (not read)`);
}

/** The rank of a model or effort name in its list (0: unknown). */
const rankOf = (value, list) => list.findIndex((word) => String(value).toLowerCase().includes(word)) + 1;
const strengthEffect = (value, ours, list) => {
  const [theirs, mine] = [rankOf(value, list), rankOf(ours, list)];
  return theirs > 0 && mine > 0 && theirs < mine ? 'weaker-model' : 'replaces-ours';
};

/** What one project env variable does to ours, or undefined when it does not touch our setup. */
function envEffect(key, value, ours) {
  if (OUR_SWITCHES.includes(key)) return 'our-switch';
  if (key === 'ANTHROPIC_MODEL') return strengthEffect(value, ours.model, MODEL_FAMILIES);
  if (key === 'CLAUDE_CODE_SUBAGENT_MODEL') return strengthEffect(value, ours.subagentModel, MODEL_FAMILIES);
  if (key === 'CLAUDE_CODE_EFFORT_LEVEL') return strengthEffect(value, ours.effortLevel, EFFORT_LEVELS);
  return ours.envKeys.has(key) || CLAUDE_ENV.test(key) ? 'replaces-ours' : undefined;
}

/**
 * Whether a glob matches a path: `**` any characters, `*` and `?` any but `/`, everything else itself (case kept).
 * @param {string} pattern - a claudeMdExcludes entry (untrusted); at most MAX_GLOB_CHARS.
 * @param {string} path - an absolute path of ours, with `/` separators.
 * @returns {boolean} true on a match. Work: one pass over the path per pattern character (pattern x path steps).
 */
export function globMatches(pattern, path) {
  let reach = Array.from({ length: path.length + 1 }, (_, at) => at === 0); // reach[i]: the pattern so far matches path[0, i)
  for (let at = 0; at < pattern.length; at += 1) {
    const char = pattern[at];
    const doubleStar = pattern.startsWith('**', at);
    const next = new Array(path.length + 1).fill(false);
    let open = false; // a star run that reaches this position
    for (let to = 0; to <= path.length; to += 1) {
      if (char === '*') {
        open = reach[to] || (open && (doubleStar || path[to - 1] !== '/'));
        next[to] = open;
      } else if (to > 0 && reach[to - 1]) next[to] = char === '?' ? path[to - 1] !== '/' : path[to - 1] === char;
    }
    if (doubleStar) at += 1;
    reach = next;
  }
  return reach[path.length];
}

/** Whether claudeMdExcludes may leave out one of our memory files: a match, or a pattern too long, too rich or past the count to judge. */
function hidesOurs(patterns, memoryPaths) {
  if (patterns.length > MAX_EXCLUDES) return true;
  return patterns.some((pattern) => typeof pattern === 'string' && (pattern.length > MAX_GLOB_CHARS
    || UNCERTAIN_GLOB.test(pattern) || memoryPaths.some((path) => path.length <= MAX_GLOB_CHARS && globMatches(pattern, path))));
}

/** The settings of one file that change ours, added to `found` (the first file to set a key wins: the local file is read first). */
function settingsOverrides(settings, ours, found) {
  const add = (key, value, effect) => {
    if (effect === undefined || found.some((item) => item.key === key)) return;
    const shown = SHOWN_VALUE_KEYS.includes(key) && ['string', 'number', 'boolean'].includes(typeof value);
    found.push({ key, value: shown ? String(value) : null, effect });
  };
  if (settings.disableAllHooks === true) add('disableAllHooks', true, 'hooks-off');
  if (Array.isArray(settings.claudeMdExcludes) && hidesOurs(settings.claudeMdExcludes, ours.memoryPaths)) add('claudeMdExcludes', null, 'hides-our-rules');
  if (typeof settings.model === 'string') add('model', settings.model, strengthEffect(settings.model, ours.model, MODEL_FAMILIES));
  if (typeof settings.effortLevel === 'string') add('effortLevel', settings.effortLevel, strengthEffect(settings.effortLevel, ours.effortLevel, EFFORT_LEVELS));
  const mode = isObject(settings.permissions) ? settings.permissions.defaultMode : undefined;
  if (typeof mode === 'string' && mode !== 'default') add('permissions.defaultMode', mode, 'permission-mode');
  for (const key of REPLACING_KEYS) if (Object.hasOwn(settings, key)) add(key, null, 'replaces-ours');
  for (const key of keysOf(settings.env)) add(key, settings.env[key], envEffect(key, settings.env[key], ours));
}

/** Settings: what changes ours, and the hooks beside ours (handlers per event, over all settings files). */
function scanSettings(folders, setup, { ours }) {
  const hooks = new Map();
  for (const { dir, rel, claude } of folders) {
    for (const file of claude ? SETTINGS_FILES : []) {
      const { value, problem } = readJson(join(dir, file));
      if (problem) setup.notChecked.push(`${shownRel(rel, file)} (${problem})`);
      if (!isObject(value)) continue;
      settingsOverrides(value, ours, setup.overrides);
      for (const event of keysOf(value.hooks)) {
        const matchers = Array.isArray(value.hooks[event]) ? value.hooks[event].slice(0, MAX_KEYS) : [];
        const count = matchers.reduce((sum, matcher) => sum + (Array.isArray(matcher?.hooks) ? matcher.hooks.length : 0), 0);
        if (count > 0) hooks.set(event, (hooks.get(event) ?? 0) + count);
      }
    }
  }
  setup.hooks = [...hooks].map(([event, count]) => ({ event, count })).sort((a, b) => (a.event < b.event ? -1 : Number(a.event > b.event)));
}

/** MCP: the server names of each .mcp.json. */
function scanMcp(folders, setup) {
  for (const { dir, rel } of folders) {
    const { value, problem } = readJson(join(dir, MCP_FILE));
    if (problem) setup.notChecked.push(`${shownRel(rel, MCP_FILE)} (${problem})`);
    for (const name of keysOf(value?.mcpServers)) if (!setup.mcp.includes(name)) setup.mcp.push(name);
  }
}

const PARTS = [['instructions', scanInstructions], ['settings', scanSettings], ['skills', scanSkills], ['agents', scanAgents],
  ['rules', scanRules], ['MCP', scanMcp]];

/** Our personal skill names, lower case (skill names clash in any case: skills docs). */
function personalSkillNames(dir) {
  try {
    return new Set(readdirSync(dir).map((name) => name.toLowerCase()));
  } catch {
    return new Set();
  }
}

/**
 * What the project's AI setup brings.
 * @param {string} top - the project root (project-note-key.mjs repoIdentity).
 * @param {string} cwd - the session folder; folders between it and `top` are read too.
 * @param {{ personalSkillsDir: string, budgetMs?: number, ours?: { model: string, subagentModel: string, effortLevel: string,
 *   envKeys: Set<string>, memoryPaths: string[], agentsMdSetting: boolean } }} options - our skills folder, the time this scan may
 *   take, and our own settings (what "weaker" and "replaces ours" compare with; project-merge.mjs reads them).
 * @returns {ProjectSetup}
 */
export function scanProjectSetup(top, cwd, { personalSkillsDir, budgetMs = DEFAULT_BUDGET_MS, ours = NO_OURS }) {
  const setup = { instructions: [], agentsMdLoads: 'none', rules: 0, skills: [], hiddenSkills: [], agents: [], hooks: [], overrides: [],
    mcp: [], localImportsNote: false, notChecked: [] };
  const deadline = performance.now() + budgetMs;
  const context = { ours, state: { entries: MAX_ENTRIES, cut: false }, personalSkills: personalSkillNames(personalSkillsDir) };
  const folders = projectFolders(top, cwd, setup);
  for (const [name, scan] of PARTS) {
    if (performance.now() > deadline) setup.notChecked.push(`${name} (time budget used up)`);
    else {
      try {
        scan(folders, setup, context);
      } catch {
        setup.notChecked.push(`${name} (could not be read)`);
      }
    }
  }
  if (context.state.cut) setup.notChecked.push(`folders past ${MAX_ENTRIES} entries or ${MAX_DEPTH} levels (the rest not listed)`);
  return setup;
}

/**
 * The env variables the committed project settings set and the local file does not (for our skip switches: team-set ones are ignored).
 * @param {string} top - the project root.
 * @returns {{ keys: ReadonlySet<string>, readable: boolean }} `readable` false when either file is there but cannot be read as JSON.
 */
export function teamSetEnv(top) {
  const team = readJson(join(top, TEAM_SETTINGS));
  const local = readJson(join(top, LOCAL_SETTINGS));
  const localKeys = new Set(keysOf(local.value?.env));
  return { keys: new Set(keysOf(team.value?.env).filter((key) => !localKeys.has(key))), readable: !team.problem && !local.problem };
}

/** @typedef {{ instructions: string[], agentsMdLoads: 'native'|'setting'|'import'|'none', rules: number, skills: string[],
 *  hiddenSkills: {name: string, path: string}[], agents: {name: string, mark: string}[], hooks: {event: string, count: number}[],
 *  overrides: {key: string, value: string|null, effect: 'weaker-model'|'our-switch'|'hides-our-rules'|'permission-mode'|'hooks-off'|'replaces-ours'}[],
 *  mcp: string[], localImportsNote: boolean, notChecked: string[] }} ProjectSetup
 * `instructions`, `skills`, `hiddenSkills`, `agents[].name`, `hooks[].event`, `overrides[].key` (env names), `overrides[].value`
 * and `mcp` are raw repository text (the text layer quotes them); `agents[].mark` and `notChecked` are this file's own words
 * (paths in them already shown by shown-name.mjs). */
