// Project-merge hook: tells the main session (SessionStart) what the project's own AI setup brings beside ours, and the
// project's note found by its repo key (layering spec section 3, owner rule R22 and decisions R22-Q3, R22-L4). Main session only
// (plan 2026-11-24: workers get no note, and inside a subagent it prints nothing).
//   SessionStart (startup, resume, clear, compact) -> the lead note:
//     instructions (CLAUDE.md, AGENTS.md and whether it loads, .claude/rules), skills (ours hide a same-name project skill:
//     named with its path), agents (with maxTurns), hooks beside ours, settings that change ours (a weaker model, our check
//     switches, permission mode, and a clear warning when the project turns all hooks off or may hide our CLAUDE.md), MCP
//     servers, the note line, the project-agents line (lib/project-agents-timed.mjs; from the session folder by a filesystem
//     walk, also when git fails) and the notes.
// Notes: `<key>.md` in the setup's shared folder (home/project-notes, found from this file's real path), then the personal one
// (~/.claude/project-notes); a note CLAUDE.local.md already imports is named, not repeated.
// Parts: lib/project-note-key.mjs (key, notes), lib/project-setup-scan.mjs (what the project brings), lib/project-merge-text.mjs
// (wording, caps). Output: JSON { hookSpecificOutput: { hookEventName, additionalContext } }, at most LEAD_NOTE_MAX_CHARS
// characters, below the 10,000-character cap of a hook string (hooks docs), as its own hook entry in settings/base.json.
// Exports: HOOK_BUDGET_MS, GIT_TIMEOUT_MS, SCAN_BUDGET_MS, hookOutput(input, deps), ourSetup(home, coreHome).
// Invariants: read-only, no state file, so parallel sessions and agents get the same answer (F2); never blocks (exit 0, nothing
// on bad input); git runs hardened (lib/gated-folder.mjs runGit) with GIT_TIMEOUT_MS per call; one deadline, HOOK_BUDGET_MS from
// the start of the process, below the 5 s timeout of both entries: the scan gets at most SCAN_BUDGET_MS of it and the agents
// child what is left. Not covered: a read that hangs inside the kernel (a dead network mount) cancels this hook; only this note is lost.
import { readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runGit } from './lib/gated-folder.mjs';
import { readPlainFile } from './lib/plain-file.mjs';
import { findNotes, repoIdentity } from './lib/project-note-key.mjs';
import { scanProjectSetup } from './lib/project-setup-scan.mjs';
import { leadNote } from './lib/project-merge-text.mjs';
import { timedProjectAgentNote } from './lib/project-agents-timed.mjs';

export const HOOK_BUDGET_MS = 4000; // the 5,000 ms timeout of both entries minus 1,000 ms for node's start and the printing
export const GIT_TIMEOUT_MS = 1000; // one git call; two at most per run
export const SCAN_BUDGET_MS = 1000;
const NOTES_RESERVE_MS = 200; // kept back from the agents child for the notes and the printing
const SETTINGS_MAX_BYTES = 1024 * 1024; // our merged settings.json is about 30 KiB
const AGENTS_MD_SETTING = 'claude-md-and-agents-md';
const AGENTS_MD_PLUGIN = 'cc-plugin-agents-md@builtin';
const EVENT = 'SessionStart';

/** True inside a subagent: `agent_id` is a non-empty string (any other value is the main session). */
const isSubagent = (input) => typeof input?.agent_id === 'string' && input.agent_id !== '';
const CORE_HOME = dirname(dirname(fileURLToPath(import.meta.url))); // <repo>/home: import.meta.url is this file's real path

const defaultGit = (cwd, args) => runGit(cwd, args, GIT_TIMEOUT_MS);

/** A real path, or the path itself when it cannot be resolved. */
function realOr(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Our memory files as claudeMdExcludes would see them: ~/.claude/CLAUDE.md, what it imports, our rules; spelled and real. */
function memoryPaths(home, coreHome) {
  const claude = join(home, '.claude');
  let rules = [];
  try {
    rules = readdirSync(join(claude, 'rules')).map((name) => join(claude, 'rules', name));
  } catch {
    rules = []; // no rules folder: only the CLAUDE.md files are ours to protect
  }
  const files = [join(claude, 'CLAUDE.md'), join(coreHome, 'CLAUDE.md'), join(dirname(coreHome), 'personal', 'CLAUDE.md'), ...rules];
  return [...new Set(files.flatMap((file) => [file, realOr(file)]))].map((file) => file.replaceAll('\\', '/'));
}

/** The highest effortLevel our modelSettings give the model family `model` names, '' when none. */
function effortOf(settings, model) {
  if (typeof settings.effortLevel === 'string') return settings.effortLevel;
  const entry = Object.entries(settings.modelSettings ?? {}).find(([id]) => model !== '' && id.includes(model));
  return typeof entry?.[1]?.effortLevel === 'string' ? entry[1].effortLevel : '';
}

/**
 * Our own settings, as the scan compares a project's with them: ~/.claude/settings.json (the merged copy install writes).
 * @param {string} home - the home folder.
 * @param {string} [coreHome] - the setup's `home/` folder.
 * @returns {{ model: string, subagentModel: string, effortLevel: string, envKeys: Set<string>, memoryPaths: string[],
 *   agentsMdSetting: boolean }} '' and empty sets where the file says nothing or cannot be read (then nothing is called weaker).
 */
export function ourSetup(home, coreHome = CORE_HOME) {
  let settings = {};
  try {
    settings = JSON.parse(readPlainFile(realpathSync(join(home, '.claude', 'settings.json')), SETTINGS_MAX_BYTES)) ?? {};
  } catch {
    settings = {}; // missing or unreadable: no claim about ours
  }
  const model = typeof settings.model === 'string' ? settings.model : '';
  const env = settings.env !== null && typeof settings.env === 'object' ? settings.env : {};
  return {
    model,
    subagentModel: typeof env.CLAUDE_CODE_SUBAGENT_MODEL === 'string' ? env.CLAUDE_CODE_SUBAGENT_MODEL : '',
    effortLevel: effortOf(settings, model),
    envKeys: new Set(Object.keys(env)),
    memoryPaths: memoryPaths(home, coreHome),
    agentsMdSetting: settings.pluginConfigs?.[AGENTS_MD_PLUGIN]?.options?.instructionFiles === AGENTS_MD_SETTING,
  };
}

/** The file an `@` import in a CLAUDE.local.md names: `~/` from the home folder, a relative path from the file's own folder. */
const importTarget = (dir, path, home) => (path.startsWith('~/') ? join(home, path.slice(2)) : isAbsolute(path) ? path : join(dir, path));

/** The notes for the keys, each marked shared or personal, and imported when CLAUDE.local.md loads that very file. */
function notesFor(identity, setup, { home, coreHome }) {
  const personalDir = join(home, '.claude', 'project-notes');
  const sharedDir = join(coreHome, 'project-notes');
  // Compared by spelling, never resolved: the import text is repository data, and a stat through it could stall (P1).
  const imported = new Set((setup?.localNoteImports ?? []).map(({ dir, path }) => importTarget(dir, path, home)));
  const personalReal = realOr(personalDir); // our own folders, so resolving them is safe; today the two are one real folder
  const spellings = (note) => [note.path, join(note.dir, `${note.key}.md`),
    ...(realOr(note.dir) === personalReal ? [join(personalDir, `${note.key}.md`)] : [])];
  return findNotes(identity.keys, [sharedDir, personalDir]).map((note) => ({
    ...note,
    kind: note.dir === sharedDir ? 'shared' : 'personal',
    imported: spellings(note).some((path) => imported.has(path)),
  }));
}

/**
 * What the hook prints for one event.
 * @param {unknown} input - the parsed hook input (`hook_event_name`, `cwd`, `agent_id`).
 * @param {{ home?: string, coreHome?: string, git?: Function, now?: () => number, agentNoteOptions?: object }} [deps] - for
 *   tests: the home folder, the setup's home/ folder, the git runner, the clock (ms since the hook started), the agents child's options.
 * @returns {Promise<{ hookSpecificOutput: { hookEventName: string, additionalContext: string } } | null>} null for nothing to say,
 *   another event, or a SessionStart inside a subagent.
 */
export async function hookOutput(input, { home = homedir(), coreHome = CORE_HOME, git = defaultGit, now = () => performance.now(), agentNoteOptions } = {}) {
  const event = input?.hook_event_name;
  if (event !== EVENT || isSubagent(input)) return null;
  const timeLeft = () => HOOK_BUDGET_MS - now();
  const identity = repoIdentity(input.cwd, { git, home });
  const ours = ourSetup(home, coreHome);
  const setup = identity.top === null ? null : scanProjectSetup(identity.top, input.cwd,
    { personalSkillsDir: join(home, '.claude', 'skills'), budgetMs: Math.max(0, Math.min(SCAN_BUDGET_MS, timeLeft())), ours });
  const notes = notesFor(identity, setup, { home, coreHome });
  // From the session folder whatever git said: the child finds the agent folders by its own filesystem walk, so a missing or
  // failing git (identity.top null) never hides the line (review R1 of agents-note).
  const agentNote = timedProjectAgentNote(input.cwd, join(home, '.claude', 'agents'), { ...agentNoteOptions, budgetLeftMs: timeLeft() - NOTES_RESERVE_MS });
  const text = leadNote(setup, notes, agentNote, identity);
  return text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : null;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return; // not hook JSON: stay silent, never block
  }
  const output = await hookOutput(input);
  if (output) console.log(JSON.stringify(output));
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`project-merge hook: ${error.message}\n`);
  }
}
