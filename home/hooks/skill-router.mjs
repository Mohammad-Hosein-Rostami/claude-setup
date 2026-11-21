// Skill router hook. Skills are model-invoked from their descriptions only, so in busy projects (many project and
// plugin skills, delegated subagents) the UI skills get skipped. This hook makes the choice deterministic.
// UserPromptSubmit: prompt keywords -> names the skills to invoke (additionalContext). The UI routes are in this file;
// the gate routes (every project, also Gradle) are in lib/gate-routes.mjs, one line each: a bug or fix names
// root-cause-debug, a done or ship request names verify-done, a repository restructure names repo-restructure, git
// history or branch work names git-linear-history (each once per session), and a repeated report ("still wrong", "i told
// you before") names no skill and shows on every match. The first routed UI prompt of a
// session (and any prompt that routes a skill not named before) gets the full text; the rest get a one-line form.
// SessionStart(compact): forgets this session's prompt marker, so the next routed prompt gets the full text again.
// Every UI text names the proof step (`ui-check run` rounds in the UI lane, then visual-qa's final gate on the tree that lands), but only
// when the owner turned the `ui` check on with /check; otherwise withoutUiChecks drops ui-quality-pass and the proof step, and the
// verify-done route is left out while test, types and ui are all off (lib/checks-on.mjs, spec r9-checks-off).
// FA Figma words: فیگما, پیکسل, طرح, دیزاین, مطابق, تطابق; a figma.com link inside a `<pasted_content>` block routes too (pastedText).
// PostToolUse(Edit|Write|MultiEdit) on a UI file (markup, styles, and `.ts`/`.js` style scripts under a styles/theme/sx folder
// or named *.styles.ts, *.theme.ts, *.sx.ts, as in ui-proof's lib/ui-files.mjs) -> reminds once per session and agent (subagents
// included), except in the user's own ui-implementer (it preloads the UI skills). A project copy of ui-implementer (the
// project's `.claude/agents/ui-implementer.md` differs in content from the user's) is reminded: the file decides, not the name.
// UI marker (per session, never cleared on compact): set when a prompt routes a skill or a UI file is edited. While it exists, weak UI
// words ("now style the settings page header") and job follow-ups ("continue", "finish it", FA "ادامه") get a UI follow-up line.
// Quiet (no output) when CLAUDE_SKILL_ROUTER=off or in a Gradle project without package.json (Android routing
// lives in the personal per-project layer there). Never blocks: always exits 0; unparsable input produces no output.
import { mkdirSync, existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isOn } from './lib/checks-on.mjs';
import { GATE_ROUTES } from './lib/gate-routes.mjs';
import { ownerWords, pastedText } from './lib/owner-words.mjs';

const FIGMA_SKILLS = ['figma-pixel-perfect', 'responsive-ui'];
// A Figma file link: the one word that still routes from inside a pasted block (a large paste often carries the frame link).
const FIGMA_LINK = /figma\.com\/(?:design|file|proto|board|make)\//i;
const PROMPT_ROUTES = [
  // FA: figma, pixel, design (طرح, دیزاین), matching (مطابق, تطابق)
  { test: /figma\.com|figma|pixel[\s-]?perfect|match (the )?(design|frame)|فیگما|پیکسل|طرح|دیزاین|مطابق|تطابق/i, skills: FIGMA_SKILLS },
  { test: /responsive|mobile[\s-]?(first|layout|view|screen|width|breakpoint)|tablet[\s-]?(layout|view|width|screen|breakpoint|size)|on (a )?tablets?\b|breakpoint|overflow-[xy]|(text|horizontal|content|scroll) overflow|overflow (hidden|scroll|auto)|viewport|reflow|ریسپانسیو|موبایل/i, skills: ['responsive-ui'] },
  { test: /\bforms?\b(?!\s*data)|\bform[\s-]?validation|\bvalidat\w* (the )?(form|field)s?\b|فرم/i, skills: ['forms-validation'] },
  { test: /\b(loading|empty|error) states?\b|\bskeleton|\bpagination/i, skills: ['async-ui-states'] },
  // Bare "validation", "tablet" and "overflow" fired on backend prompts ("validate the JSON payload", "stack overflow").
  // Bare "keyboard", "focus" and "aria" (in "variable") fired on non-UI prompts, so they need UI context words.
  {
    test: /a11y|accessib|keyboard[\s-]?(nav\w*|access\w*|trap|support|only)|focus[\s-]?(ring|trap|order|state|visible|management)|\baria\b|aria-|contrast|screen reader/i,
    skills: ['accessibility-build'],
  },
  {
    // Coverage-matrix words. Bare "locale" fires on backend prompts, so it needs a UI-ish partner.
    test: /\brtl\b|\bltr\b|right[\s-]to[\s-]left|\bi18n\b|\bl10n\b|\blocali[sz](?:e[sd]?|ing|ations?)\b|\b(every|all|each|supported|per)[\s-]locales?\b|\blocale (switch|picker|selector)\b|\b(email|mail) templates?\b|\b(all|every) (the )?(screens|forms|pages)\b|\bevery (screen|form|page)\b|راست[\s‌-]*به[\s‌-]*چپ|راست‌چین|چندزبانه|قالب ایمیل/i,
    skills: ['ui-coverage'],
  },
  {
    // Bare "page", "step", "style", "card", "theme", "layout" fired on non-UI prompts: require a UI noun or phrase.
    test: /\b(ui|ux|components?|screens?|modals?|dialogs?|drawers?|buttons?|navbar|css|scss|sx|tailwind|mui|styling|spacing|responsive|page[\s-]?layouts?|form[\s-]?fields?)\b|صفحه|کامپوننت|استایل|طراحی/i,
    skills: ['accessibility-build', 'responsive-ui', 'ui-quality-pass'],
  },
];
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
const UI_STATE_DIR = join(STATE_DIR, 'ui'); // one empty file per session: this session is UI work
const UI_IMPLEMENTER = 'ui-implementer';
const AGENT_FILE_MAX_BYTES = 64 * 1024; // an agent file is a few KB; a bigger one is not read and counts as a project copy
const FOLLOW_UP_SKILLS = ['accessibility-build', 'responsive-ui', 'ui-quality-pass'];
const COMPACT_SOURCE = 'compact';
const OFF_ENV = 'CLAUDE_SKILL_ROUTER';
const GRADLE_FILES = ['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts'];

/** Returns the gate routes (bug -> root-cause-debug, done/ship -> verify-done, repo restructure -> repo-restructure, git history -> git-linear-history) a prompt calls for. */
function gatesForPrompt(prompt) {
  const words = ownerWords(prompt);
  return HARNESS_EVENT.test(prompt.trim()) ? [] : GATE_ROUTES.filter((gate) => gate.test.test(words));
}

/** Returns the gate-route lines a prompt calls for, without the once-per-session filter. */
export function gateLinesForPrompt(prompt) {
  return gatesForPrompt(prompt).map((gate) => gate.line);
}

/** Returns the skills a prompt calls for, in first-match order, without duplicates. */
export function skillsForPrompt(prompt) {
  if (HARNESS_EVENT.test(prompt.trim())) return [];
  const words = ownerWords(prompt);
  const picked = PROMPT_ROUTES.filter((route) => route.test.test(words)).flatMap((route) => route.skills);
  if (FIGMA_LINK.test(pastedText(prompt))) picked.push(...FIGMA_SKILLS);
  return [...new Set(picked)];
}

// Too vague alone (hence "header" only in UI phrases, never HTTP; no "table", "tab", "menu", "grid"); they count only
// in a session already marked as UI work.
const WEAK_UI =
  /\b(styles?|styled|layout|align\w*|margin|padding|colou?rs?|fonts?|icons?|sidebar|footer|hero|banner|tooltip|cards?|theme|dark mode|hover|animation|(page|site|nav|section) header|header (bar|section|area|nav)|pages?)\b|رنگ|فونت|هدر|منو|دکمه|آیکون|چیدمان|فاصله/i;

/** True when a prompt has a weak UI word (follow-up styling talk); the caller checks the session is UI work. */
export function weakUiPrompt(prompt) {
  return !HARNESS_EVENT.test(prompt.trim()) && WEAK_UI.test(ownerWords(prompt));
}

// "continue" / "finish it" after a UI prompt: the same UI job goes on, so it gets the follow-up line (only in a UI session).
const JOB_FOLLOW_UP = /\b(continue|carry on|keep going|go on|resume|proceed|finish)\b|ادامه|تمامش|تمومش|تمام کن|تموم کن/i;

/** True when a prompt asks to go on with the current job ("continue", "finish it"); the caller checks the session is UI work. */
export function jobFollowUpPrompt(prompt) {
  return !HARNESS_EVENT.test(prompt.trim()) && JOB_FOLLOW_UP.test(ownerWords(prompt));
}

/** True when an edited path is UI source (not a test or story): markup, styles, or a style script under styles/theme/sx. */
export const isUiFile = (file) =>
  !NON_UI_FILE.test(file) && (UI_FILE.test(file) || (STYLE_SCRIPT.test(file) && (STYLE_FOLDER.test(file) || STYLE_NAME.test(file))));

const PROOF_STEP = ' Proof before "done" or "fixed": the UI lane runs `ui-check run` rounds until every state passes, then a' +
  ' `visual-qa` lane runs the final gate on the tree that lands; only its PASS counts.';
const PROOF_SHORT = 'proof: ui-check run PASS, then the visual-qa final gate';

const fullPromptText = (skills) =>
  `Skill router: this request involves UI. Before writing UI code, invoke with the Skill tool: ${skills.join(', ')}` +
  ' (skip any already loaded in this context). A project skill with the same purpose whose paths match wins.' +
  ' Delegate UI implementation to the `ui-implementer` agent, not `implementer`, and name these skills in the' +
  ' delegation prompt (a project\'s own `ui-implementer` preloads only project skills);' +
  ` run \`ui-quality-pass\` before saying done.${PROOF_STEP}`;

const shortPromptText = (skills) =>
  `Skill router: UI request - invoke ${skills.join(', ')} (skip any already loaded); delegate to ui-implementer; ` +
  `ui-quality-pass before done; ${PROOF_SHORT}.`;

const promptMarkerPath = (sessionId) =>
  typeof sessionId === 'string' && SAFE_ID.test(sessionId) ? join(PROMPT_STATE_DIR, sessionId) : null;

/**
 * Records `skills` as named for this session and returns true when every one was already named before (short text
 * is enough). Unsafe session id or unwritable temp dir -> false (full text), never throws: the hook must not block.
 */
function alreadyNamed(sessionId, skills) {
  const marker = promptMarkerPath(sessionId);
  if (!marker) return false;
  try {
    const known = existsSync(marker) ? new Set(readFileSync(marker, 'utf8').split('\n').filter(Boolean)) : new Set();
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

function markUiSession(sessionId) {
  const marker = uiMarkerPath(sessionId);
  if (!marker) return;
  try {
    mkdirSync(UI_STATE_DIR, { recursive: true });
    writeFileSync(marker, '');
  } catch {
    // temp dir not writable: weak follow-ups just stay silent; never fail the hook
  }
}

const isUiSession = (sessionId) => {
  const marker = uiMarkerPath(sessionId);
  return marker !== null && existsSync(marker);
};

function followUpContext(sessionId) {
  const marker = promptMarkerPath(sessionId);
  // Marker gone (compact) or never written: the skill text is not in context, so send the full text.
  if (marker && existsSync(marker)) {
    return 'Skill router: UI follow-up - invoke accessibility-build, responsive-ui (skip any already loaded); ' +
      `delegate to ui-implementer; ui-quality-pass before done; ${PROOF_SHORT}.`;
  }
  return fullPromptText(FOLLOW_UP_SKILLS);
}

function promptContext(prompt, sessionId) {
  const skills = skillsForPrompt(prompt);
  if (skills.length === 0) {
    const followUp = weakUiPrompt(prompt) || jobFollowUpPrompt(prompt);
    return followUp && isUiSession(sessionId) ? followUpContext(sessionId) : null;
  }
  markUiSession(sessionId);
  return alreadyNamed(sessionId, skills) ? shortPromptText(skills) : fullPromptText(skills);
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

// First UI edit per session and agent only; a marker file in the temp dir records that the reminder was sent.
function firstUiEdit(sessionId, agentId) {
  const ids = [sessionId, agentId ?? 'main'];
  if (!ids.every((id) => typeof id === 'string' && SAFE_ID.test(id))) return false;
  const marker = join(STATE_DIR, ids.join('--'));
  if (existsSync(marker)) return false;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(marker, '');
  } catch {
    return false; // temp dir not writable: skip the reminder rather than fail a hook that must never block
  }
  return true;
}

/** The text of a regular file of at most AGENT_FILE_MAX_BYTES; null when it is missing, bigger or unreadable. */
function agentFileText(path) {
  try {
    const stats = statSync(path);
    return stats.isFile() && stats.size <= AGENT_FILE_MAX_BYTES ? readFileSync(path, 'utf8') : null;
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

function editContext(input) {
  const file = input.tool_input?.file_path ?? '';
  if (!isUiFile(file)) return null;
  markUiSession(input.session_id);
  if (input.agent_type === UI_IMPLEMENTER && !isProjectUiImplementer(input)) return null;
  if (!firstUiEdit(input.session_id, input.agent_id)) return null;
  return 'Skill router: you are editing UI code. If not yet loaded in this context, invoke `responsive-ui` and' +
    ' `accessibility-build` now (also `forms-validation` for forms, `async-ui-states` for server data,' +
    ' `figma-pixel-perfect` when there is a Figma frame), and run `ui-quality-pass` before reporting done.' +
    ' Proof: `ui-check run` until every state passes; visual-qa runs the final gate on the tree that lands.';
}

/**
 * True when the web UI routes do not apply: CLAUDE_SKILL_ROUTER=off, or a Gradle (Android/JVM) project without a
 * package.json, where words like "screen" or "layout" mean Compose/XML and have their own skills.
 */
export function isQuiet(cwd, env = process.env) {
  if (env[OFF_ENV] === 'off') return true;
  if (!cwd) return false;
  const has = (name) => existsSync(join(cwd, name));
  return GRADLE_FILES.some(has) && !has('package.json');
}

const UI_CHECK_TEXTS = [PROOF_STEP, `; ${PROOF_SHORT}`, ` run \`ui-quality-pass\` before saying done.`, 'ui-quality-pass before done; ',
  ' Proof: `ui-check run` until every state passes; visual-qa runs the final gate on the tree that lands.'];

/** A route text with the UI checks taken out (the `ui` check is off): no ui-quality-pass, no proof step. */
export function withoutUiChecks(text) {
  const cut = UI_CHECK_TEXTS.reduce((rest, part) => rest.split(part).join(''), text);
  return cut.replace(', and run `ui-quality-pass` before reporting done.', '.').replace(/, ui-quality-pass\b/g, '').replace(/; delegate to ui-implementer\.?$/, '; delegate to ui-implementer.');
}

/** The route text for one input with the checks the owner left off taken out. */
function routeChecked(input) {
  const text = route(input);
  if (text === null) return null;
  const uiChecked = isOn('ui', input.session_id) ? text : withoutUiChecks(text).replace(/skills\);(?=\n|$)/, 'skills).');
  return isOn('test', input.session_id) ? uiChecked : uiChecked.replace('; tdd-loop for the fix itself.', '.'); // tdd-loop is a `test` check
}

const anyCheckBeforeDone = (sessionId) => ['test', 'types', 'ui'].some((category) => isOn(category, sessionId));

function route(input) {
  if (input.hook_event_name === 'SessionStart') {
    if (input.source === COMPACT_SOURCE) clearPromptMarker(input.session_id);
    return null;
  }
  if (input.hook_event_name === 'UserPromptSubmit') {
    const prompt = String(input.prompt ?? '');
    if (process.env[OFF_ENV] === 'off') return null;
    const ui = isQuiet(input.cwd) ? null : promptContext(prompt, input.session_id);
    // The gate lines share the UI "named skills" marker, so each shows once per session and again after a compact; an `everyTime` route shows on every match.
    const gates = gatesForPrompt(prompt).filter((gate) => gate.skill !== 'verify-done' || anyCheckBeforeDone(input.session_id))
      .filter((gate) => gate.everyTime || !alreadyNamed(input.session_id, [gate.skill])).map((gate) => gate.line);
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
  const context = routeChecked(input);
  if (!context) return;
  const hookSpecificOutput = { hookEventName: input.hook_event_name, additionalContext: context };
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
