// Skill router hook. Skills are model-invoked from their descriptions only, so in busy projects (many project and
// plugin skills, delegated subagents) the UI skills get skipped. This hook makes the choice deterministic.
// UserPromptSubmit: the owner's words -> names the skills to invoke (additionalContext). The UI routes are in lib/skill-router-routes.mjs,
// read with ui-proof's request evidence (ui-evidence.mjs): a clause that talks about the checks ("the ui check chain is too heavy",
// "what do u mean") or refuses ("don't do anything on pixel perfect", FA "نکن") routes no UI skill. Sized by evidence (owner R24/R28):
// design evidence (Figma, pixel perfect, match the design, FA فیگما, پیکسل, مطابق طرح; a Figma link anywhere, also inside a
// `<pasted_content>` block) gets today's pixel text, the full one first in a session (and for a skill not named before), then a
// one-line form; any other UI request gets one line: its skills, ui-quality-pass, and "the check plan decides the depth".
// The gate routes (every project, also Gradle) are in lib/gate-routes.mjs, one line each, read from the owner's words without the
// talk filter: a bug or fix names root-cause-debug, a repository restructure names repo-restructure, git history or branch work
// names git-linear-history (each once per session), and a repeated report ("still wrong", "i told you before") names no skill and
// shows on every match. SessionStart(compact): forgets this session's prompt marker, so the next pixel prompt gets the full text again.
// PostToolUse(Edit|Write|MultiEdit): the edit's old and new text (at most 128 KiB each) are classed by ui-evidence's classifyFile:
// look -> responsive-ui, accessibility-build, ui-quality-pass; logic -> async-ui-states / forms-validation and a test; text -> ui-coverage
// locales; docs pages, tests and config -> nothing. UI source files (markup, styles, `.ts`/`.js` style scripts under a styles/theme/sx
// folder or named *.styles.ts, *.theme.ts, *.sx.ts) get every class; other files only locale text and global look. Each class reminds
// once per session and agent (subagents included), except in the user's own ui-implementer (it preloads the UI skills); a project copy
// (its `.claude/agents/ui-implementer.md` differs in content from the user's) is reminded: the file decides, not the name.
// UI marker (per session, never cleared on compact): set when a prompt routes a skill or a UI edit is classed, `pixel` once a prompt had
// design evidence. While it exists, weak UI words ("now style the settings page header") and job follow-ups ("continue", FA "ادامه")
// get a UI follow-up line: the pixel one in a pixel session, else the check-plan one.
// Quiet (no output) when CLAUDE_SKILL_ROUTER=off from the shell or .claude/settings.local.json (a project's committed settings.json alone
// cannot: lib/team-switch.mjs, one warning per session) or in a Gradle project without package.json (Android routing lives in the
// personal per-project layer there). Never blocks: always exits 0; unparsable input produces no output.
import { mkdirSync, existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GATE_ROUTES } from './lib/gate-routes.mjs';
import { readPlainFile } from './lib/plain-file.mjs';
import { ownerWords, pastedText } from './lib/owner-words.mjs';
import { editGroups, FOLLOW_UP_SKILLS, promptRoutes } from './lib/skill-router-routes.mjs';
import { EDIT_TEXTS, FOLLOW_UP_SHORT_TEXT, fullPromptText, PLAN_FOLLOW_UP_TEXT, planPromptText, shortPromptText } from './lib/skill-router-text.mjs';
import { noticeOnce, switchDirs, trustedSwitch } from './lib/team-switch.mjs';

// Harness events that arrive as the whole prompt are not user text; wrapped blocks, pasted logs and compaction summaries are cut by ownerWords (lib/owner-words.mjs).
const HARNESS_EVENT = /^(<agent-message|\[SYSTEM NOTIFICATION)/;
const UI_FILE = /\.(tsx|jsx|vue|svelte|html|css|scss|sass|less)$/i;
// Style scripts (theme, palette, sx objects): the same rule as ui-proof's lib/ui-files.mjs, with Windows separators too.
const STYLE_SCRIPT = /\.m?[jt]s$/i;
const STYLE_FOLDER = /(^|[\\/])(styles?|themes?|sx)[\\/]/i;
const STYLE_NAME = /\.(styles?|theme|sx)\.m?[jt]s$/i;
const NON_UI_FILE = /\.(test|spec|stories)\.\w+$/i;
const SAFE_ID = /^[\w-]{1,128}$/;
const STATE_DIR = join(tmpdir(), 'claude-skill-router');
const PROMPT_STATE_DIR = join(STATE_DIR, 'prompt'); // one file per session: the skills already named in full text
const UI_STATE_DIR = join(STATE_DIR, 'ui'); // one file per session: this session is UI work; it holds PIXEL_SESSION once a prompt had design evidence
const PIXEL_SESSION = 'pixel';
const UI_IMPLEMENTER = 'ui-implementer';
const AGENT_FILE_MAX_BYTES = 64 * 1024; // an agent file is a few KB; a bigger one is not read and counts as a project copy
const PROMPT_MARKER_MAX_BYTES = 64 * 1024; // a marker lists skill names (about 1 KB for all); a bigger one is not read: full text
const COMPACT_SOURCE = 'compact';
const OFF_ENV = 'CLAUDE_SKILL_ROUTER';
const GRADLE_FILES = ['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts'];

/** Returns the gate routes (bug -> root-cause-debug, repo restructure -> repo-restructure, git history -> git-linear-history) a prompt calls for. */
function gatesForPrompt(prompt) {
  const words = ownerWords(prompt);
  return HARNESS_EVENT.test(prompt.trim()) ? [] : GATE_ROUTES.filter((gate) => gate.test.test(words));
}

/** Returns the gate-route lines a prompt calls for, without the once-per-session filter. */
export function gateLinesForPrompt(prompt) {
  return gatesForPrompt(prompt).map((gate) => gate.line);
}

/** The routes of a prompt (lib/skill-router-routes.mjs), or null for a harness event, which is not the owner's text. */
const routesOf = (prompt) => (HARNESS_EVENT.test(prompt.trim()) ? null : promptRoutes(ownerWords(prompt), pastedText(prompt)));

/** Returns the skills a prompt calls for, in first-match order, without duplicates (talk and negated clauses name none). */
export const skillsForPrompt = (prompt) => routesOf(prompt)?.skills ?? [];

/** True when a prompt has a weak UI word (follow-up styling talk) outside talk and negation; the caller checks the session is UI work. */
export const weakUiPrompt = (prompt) => routesOf(prompt)?.weak ?? false;

/** True when a prompt asks to go on with the current job ("continue", "finish it"); the caller checks the session is UI work. */
export const jobFollowUpPrompt = (prompt) => routesOf(prompt)?.followUp ?? false;

/** True when an edited path is UI source (not a test or story): markup, styles, or a style script under styles/theme/sx. */
export const isUiFile = (file) =>
  !NON_UI_FILE.test(file) && (UI_FILE.test(file) || (STYLE_SCRIPT.test(file) && (STYLE_FOLDER.test(file) || STYLE_NAME.test(file))));

const promptMarkerPath = (sessionId) =>
  typeof sessionId === 'string' && SAFE_ID.test(sessionId) ? join(PROMPT_STATE_DIR, sessionId) : null;

/**
 * The marker's text, '' when there is none. Read without waiting (lib/plain-file.mjs): the marker sits in the shared temp folder, where
 * a FIFO, device or link in its place is refused (throws) instead of holding the prompt.
 */
function namedBefore(marker) {
  try {
    return readPlainFile(marker, PROMPT_MARKER_MAX_BYTES);
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

/**
 * Records `skills` as named for this session and returns true when every one was already named before (short text
 * is enough). Unsafe session id or unwritable temp dir -> false (full text), never throws: the hook must not block.
 */
function alreadyNamed(sessionId, skills) {
  const marker = promptMarkerPath(sessionId);
  if (!marker) return false;
  try {
    const known = new Set(namedBefore(marker).split('\n').filter(Boolean));
    const allKnown = skills.every((skill) => known.has(skill));
    if (!allKnown) {
      mkdirSync(PROMPT_STATE_DIR, { recursive: true });
      writeFileSync(marker, [...new Set([...known, ...skills])].join('\n'));
    }
    return allKnown;
  } catch {
    return false;
  }
}

const uiMarkerPath = (sessionId) =>
  typeof sessionId === 'string' && SAFE_ID.test(sessionId) ? join(UI_STATE_DIR, sessionId) : null;

/** Marks the session as UI work; `pixel` (design evidence) is kept once written, a plain mark never lowers it. Never throws. */
function markUiSession(sessionId, pixel) {
  const marker = uiMarkerPath(sessionId);
  if (!marker || (!pixel && existsSync(marker))) return;
  try {
    mkdirSync(UI_STATE_DIR, { recursive: true });
    writeFileSync(marker, pixel ? PIXEL_SESSION : '');
  } catch {
    // temp dir not writable: weak follow-ups just stay silent; never fail the hook
  }
}

/** null: not a UI session; true: a UI session with design evidence (pixel texts); false: a UI session the check plan sizes. */
function uiSessionPixel(sessionId) {
  const marker = uiMarkerPath(sessionId);
  if (marker === null || !existsSync(marker)) return null;
  try {
    return readPlainFile(marker, PROMPT_MARKER_MAX_BYTES) === PIXEL_SESSION;
  } catch {
    return true; // unreadable marker (a link or FIFO in its place): the stricter text
  }
}

function followUpContext(sessionId) {
  const marker = promptMarkerPath(sessionId);
  // Marker gone (compact) or never written: the skill text is not in context, so send the full text.
  if (marker && existsSync(marker)) {
    return FOLLOW_UP_SHORT_TEXT;
  }
  return fullPromptText(FOLLOW_UP_SKILLS);
}

// Sized by evidence (owner R24/R28): design evidence keeps today's pixel texts; any other UI request gets the one check-plan line.
function promptContext(prompt, sessionId) {
  const routes = routesOf(prompt);
  if (routes === null) return null;
  if (routes.skills.length === 0) {
    const pixel = routes.weak || routes.followUp ? uiSessionPixel(sessionId) : null;
    return pixel === null ? null : pixel ? followUpContext(sessionId) : PLAN_FOLLOW_UP_TEXT;
  }
  markUiSession(sessionId, routes.design);
  if (!routes.design) return planPromptText(routes.skills);
  return alreadyNamed(sessionId, routes.skills) ? shortPromptText(routes.skills) : fullPromptText(routes.skills);
}

/** SessionStart(compact): the full routing text is gone from context, so forget what was named in this session. */
function clearPromptMarker(sessionId) {
  const marker = promptMarkerPath(sessionId);
  if (!marker) return;
  try {
    rmSync(marker, { force: true });
  } catch {
    // temp dir not writable: the next prompt just gets the short form; never fail the hook
  }
}

// First edit of a reminder group (look, logic, text) per session and agent only; a marker file in the temp dir records it was sent.
function firstUiEdit(sessionId, agentId, group) {
  const ids = [sessionId, agentId ?? 'main'];
  if (!ids.every((id) => typeof id === 'string' && SAFE_ID.test(id))) return false;
  const marker = join(STATE_DIR, `${ids.join('--')}--${group}`);
  if (existsSync(marker)) return false;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(marker, '');
  } catch {
    return false; // temp dir not writable: skip the reminder rather than fail a hook that must never block
  }
  return true;
}

/**
 * The text of a regular file of at most AGENT_FILE_MAX_BYTES; null when it is missing, bigger or unreadable. A link is followed once
 * by realpath; the read follows no link and never waits (lib/plain-file.mjs), so a FIFO at the path or behind a link never holds the hook.
 */
function agentFileText(path) {
  try {
    return readPlainFile(realpathSync(path), AGENT_FILE_MAX_BYTES);
  } catch {
    return null; // no readable file: no answer from it
  }
}

/**
 * True when the ui-implementer that runs is a project copy: the project's `.claude/agents/ui-implementer.md` exists and its content
 * differs from the user's (a project copy shadows the user's and preloads only what it lists). The content decides, not the name.
 * @param {object} input the hook input (cwd); CLAUDE_PROJECT_DIR wins over cwd as the project folder
 * @returns {boolean}
 */
function isProjectUiImplementer(input) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd;
  if (typeof projectDir !== 'string' || projectDir === '') return false;
  const agentFile = (root) => join(root, '.claude', 'agents', `${UI_IMPLEMENTER}.md`);
  const projectCopy = agentFileText(agentFile(projectDir));
  if (projectCopy === null) return false;
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  return projectCopy !== agentFileText(agentFile(home));
}

// The edit's lines decide (lib/skill-router-routes.mjs editGroups): look, logic and text each get their reminder; docs, tests, config none.
function editContext(input) {
  const file = input.tool_input?.file_path;
  if (typeof file !== 'string' || file === '') return null;
  const groups = editGroups(file, input.tool_input, isUiFile(file));
  if (groups.length === 0) return null;
  markUiSession(input.session_id, false);
  if (input.agent_type === UI_IMPLEMENTER && !isProjectUiImplementer(input)) return null;
  const fresh = groups.filter((group) => firstUiEdit(input.session_id, input.agent_id, group));
  return fresh.map((group) => EDIT_TEXTS[group]).join('\n') || null;
}

/** CLAUDE_SKILL_ROUTER as the router may honour it: a team file's `off` is ignored (lib/team-switch.mjs). */
const routerSwitch = (cwd, env = process.env) => trustedSwitch(env, OFF_ENV, switchDirs(env, cwd));

/**
 * True when the web UI routes do not apply: CLAUDE_SKILL_ROUTER=off (from the shell or settings.local.json, never a team file
 * alone), or a Gradle (Android/JVM) project without a package.json, where words like "screen" or "layout" mean Compose/XML.
 */
export function isQuiet(cwd, env = process.env) {
  if (routerSwitch(cwd, env).value === 'off') return true;
  if (!cwd) return false;
  const has = (name) => existsSync(join(cwd, name));
  return GRADLE_FILES.some(has) && !has('package.json');
}

function route(input) {
  if (input.hook_event_name === 'SessionStart') {
    if (input.source === COMPACT_SOURCE) clearPromptMarker(input.session_id);
    return null;
  }
  if (input.hook_event_name === 'UserPromptSubmit') {
    const prompt = String(input.prompt ?? '');
    if (routerSwitch(input.cwd).value === 'off') return null;
    const ui = isQuiet(input.cwd) ? null : promptContext(prompt, input.session_id);
    // The gate lines share the UI "named skills" marker, so each shows once per session and again after a compact; an `everyTime` route shows on every match.
    const gates = gatesForPrompt(prompt).filter((gate) => gate.everyTime || !alreadyNamed(input.session_id, [gate.skill])).map((gate) => gate.line);
    return [ui, ...gates].filter(Boolean).join('\n') || null;
  }
  if (isQuiet(input.cwd)) return null;
  if (input.hook_event_name === 'PostToolUse') return editContext(input);
  return null;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return; // not hook JSON: stay silent, never block the user
  }
  const context = route(input);
  const warning = switchWarning(input);
  if (!context && !warning) return;
  const hookSpecificOutput = context ? { hookEventName: input.hook_event_name, additionalContext: context } : undefined;
  process.stdout.write(JSON.stringify({ hookSpecificOutput, systemMessage: warning ?? undefined }));
}

/** The owner's warning that a team file's CLAUDE_SKILL_ROUTER was ignored (the router ran): once per session, on a prompt or an edit. */
function switchWarning(input) {
  if (!['UserPromptSubmit', 'PostToolUse'].includes(input.hook_event_name)) return null;
  const { ignored } = routerSwitch(input.cwd);
  return ignored !== null && noticeOnce(input.session_id, OFF_ENV) ? ignored : null;
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
