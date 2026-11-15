// Skill router hook. Skills are model-invoked from their descriptions only, so in busy projects (many project and
// plugin skills, delegated subagents) the UI skills get skipped. This hook makes the choice deterministic.
// UserPromptSubmit: prompt keywords -> names the skills to invoke (additionalContext). Besides the UI routes, a bug/fix
// prompt names root-cause-debug and a done/ship prompt names verify-done (one line each, every project, also Gradle). The first routed prompt of a
// session (and any prompt that routes a skill not named before) gets the full text; the rest get a one-line form.
// SessionStart(compact): forgets this session's prompt marker, so the next routed prompt gets the full text again.
// PostToolUse(Edit|Write|MultiEdit) on a UI file -> reminds once per session and agent (subagents included), except
// in ui-implementer (it preloads the UI skills).
// UI marker (per session, never cleared on compact): set when a prompt routes a skill or a UI file is edited. While
// it exists, weak UI words ("now style the settings page header") get a UI follow-up line.
// Quiet (no output) when CLAUDE_SKILL_ROUTER=off or in a Gradle project without package.json (Android routing
// lives in the personal per-project layer there). Never blocks: always exits 0; unparsable input produces no output.
import { mkdirSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROMPT_ROUTES = [
  { test: /figma\.com|figma|pixel[\s-]?perfect|match (the )?(design|frame)|فیگما/i, skills: ['figma-pixel-perfect', 'responsive-ui'] },
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
// Harness events (background task results, injected reminders) arrive as prompts but are not user text.
const HARNESS_EVENT = /^(<(task-notification|system-reminder|agent-message)|\[SYSTEM NOTIFICATION)/;
// Gate routes: workflow skills that are not UI specific, named once per session (and again after a compact); the
// repeated-report route names no skill and fires on every match (`everyTime`). Triggers
// are intents, not words: an imperative "fix ..." / a bug, crash or failing test; a "done?", "ship it", "ready to
// merge" request; a repository-level restructure ("remove Nx", "merge the apps into one project"); git history or
// branch work ("clean up the git tree", "rebase", "delete the merged branches", "merge everything to master"). "fixed",
// "prefix", "when you are done", "merge conflicts", "restructure this function", "branch coverage" and "merge sort" do not fire.
const SENTENCE_START = String.raw`(?:^|[.!?:]\s+|\b(?:please|pls|can you|could you|would you|need to|needs to|let'?s|and|then|go)\s+)`;
// Build tools and layers whose removal restructures a whole repository. "nx-cache", "module federation remote" and
// "remove nx from .gitignore" are single-file talk, so the name must not continue that way.
const REMOVABLE_LAYER = String.raw`(?:the\s+)?(?:nx|turborepo|lerna|module federation|monorepo tool)(?![\w-]|\s+(?:cache|remotes?)\b|\s+(?:from|in)\s+(?:the\s+)?\.?(?:gitignore|package\.json|tsconfig|eslint|readme))`;
const REPO_NOUN = String.raw`(?:repo(?:sitory)?|project|monorepo|codebase|workspace)`;
// Branch names a merge lands on. "main.ts" is a file, so the name must not continue as a path or word.
const BASE_BRANCH = String.raw`(?:master|main|trunk|develop|the\s+base(?:\s+branch)?|the\s+default\s+branch)(?![\w-]|\.\w)`;
const GATE_ROUTES = [
  {
    skill: 'root-cause-debug',
    test: new RegExp(
      `${SENTENCE_START}(?:fix|debug|diagnose|troubleshoot)\\b` +
        String.raw`|\b(?:bugs?|crash(?:es|ed|ing)?|regressions?|flaky|stack ?traces?)\b` +
        String.raw`|\b(?:is|are|was|were|keeps?|still|now|got)\s+(?:broken|failing|crashing)\b` +
        String.raw`|\b(?:failing|broken)\s+(?:tests?|build|ci|pipeline)\b|\b(?:tests?|build|ci|pipeline)\s+(?:is |are )?(?:failing|red|broken)\b` +
        String.raw`|\b(?:does(?:n'?t| not)|do(?:n'?t| not)|won'?t|isn'?t|not)\s+work(?:ing)?\b` +
        String.raw`|باگ|رفع (?:باگ|خطا|مشکل)|کار نمی`,
      'i',
    ),
    line: 'Skill router: bug or failure - invoke root-cause-debug (skip if already loaded) before proposing a fix; tdd-loop for the fix itself.',
  },
  {
    skill: 'verify-done',
    test: new RegExp(
      String.raw`\b(?:(?:is|was) (?:it|this|that) (?:done|finished|ready)|(?:are we|we'?re|we are|i'?m|i am|it'?s|it is|all) (?:all )?(?:done|finished)` +
        String.raw`|ready (?:to|for) (?:ship|merge|release|review|deploy)|(?:ship|merge|release) (?:it|this|that|the (?:pr|branch|change|changes|work))` +
        String.raw`|(?:can|should|could) (?:we|i) (?:ship|merge|release)|wrap(?:ping)? (?:it )?up|mark (?:it )?(?:as )?done)\b` +
        String.raw`|تمام شد|merge کن|آماده merge`,
      'i',
    ),
    line: 'Skill router: done or ship - invoke verify-done (skip if already loaded) before claiming done, fixed or ready.',
  },
  {
    skill: 'repo-restructure',
    test: new RegExp(
      String.raw`\brestructur\w*\s+(?:the\s+|our\s+|this\s+|my\s+)?(?:whole\s+|entire\s+)?${REPO_NOUN}\b` +
        String.raw`|\b(?:remove|drop|delete|get rid of|eliminate|replace|migrate (?:off|away from)|move (?:off|away from))\s+${REMOVABLE_LAYER}` +
        String.raw`|\b(?:nx|turborepo|lerna|module federation)\s+(?:is |are )?(?:no longer|not) (?:needed|used|required)\b` +
        String.raw`|\bmerge\s+(?:(?:all|the|our)\s+)*(?:everything|apps?|packages?|libs?|libraries|projects|repos|workspaces)\b[^.!?]{0,30}\binto\s+(?:an?|one|1|single|the)\b` +
        String.raw`|\bconvert\s+(?:the\s+|our\s+|this\s+)?monorepo\b` +
        String.raw`|\bclean[\s-]?up\s+(?:the\s+|our\s+)?(?:(?:root|top[\s-]level)\s+(?:folder\s+)?of\s+(?:the\s+|our\s+)?)?${REPO_NOUN}\b` +
        String.raw`|(?:تغییر|بازسازی|بازآرایی)\s*ساختار\s*(?:پروژه|ریپو|مخزن|مونوریپو)`,
      'i',
    ),
    line: 'Skill router: repository restructure - invoke repo-restructure (skip if already loaded) before moving or deleting anything.',
  },
  {
    skill: 'git-linear-history',
    test: new RegExp(
      String.raw`\bgit\s+(?:tree|history|graph)\b` +
        String.raw`|\brebas(?:e|ing)\b` +
        String.raw`|\b(?:remove|delete|prune|drop|clean(?:[\s-]?up)?|get rid of)\s+(?:(?:the|all|old|stale|merged|leftover|local|remote|git)\s+)*(?:branches|worktrees)\b` +
        String.raw`|\bmerged\s+(?:branch|worktree)\b` +
        String.raw`|\bmerge\s+(?:(?:all|the|our|every|this|that|my)\s+)*(?:everything|branch(?:es)?|lanes?|worktrees?)\b[^.!?]{0,30}\b(?:to|into|onto)\s+${BASE_BRANCH}` +
        String.raw`|\bland\s+(?:(?:the|all|our|these|my)\s+)*(?:lanes?|branch(?:es)?|worktrees?)\b` +
        String.raw`|\bsquash\w*\s+(?:(?:the|these|those|my|all|our)\s+)*(?:commits?|history)\b` +
        String.raw`|تاریخچه[\s‌]*گیت|درخت[\s‌]*گیت|برنچ`,
      'i',
    ),
    line: 'Skill router: git history or branches - invoke git-linear-history (skip if already loaded) before merging, rebasing or deleting branches.',
  },
  {
    // The owner reports the same defect again or repeats an instruction. No skill to name, so no once-per-session
    // marker: the line shows on every match (`everyTime`), because each repeat is a new failure of the last fix.
    // "still", "again" and "same" alone are common words ("is it still running", "run it again"), so each pattern needs
    // its partner: still + a symptom word, "not fixed", "same <defect> again", "i told you", "<ordinal> time".
    everyTime: true,
    test: new RegExp(
      String.raw`\bstill\s+(?:wrong|broken|failing|incorrect|flash\w*|flicker\w*|blink\w*|not\s+(?:fixed|working|right|correct|resolved|solved|showing|visible))\b` +
        String.raw`|\bnot\s+(?:yet\s+)?(?:fixed|resolved|solved)\b` +
        String.raw`|\b(?:same|similar)\s+(?:problem|issue|bug|error|defect)s?\s+again\b|\bagain\s+(?:the\s+)?same\s+(?:problem|issue|bug|error|defect)` +
        String.raw`|\bi\s+(?:already\s+)?(?:told|said|mentioned)\s+(?:you\b|(?:this|that|it)\s+before\b|before\b)` +
        String.raw`|\bas\s+(?:i|we)\s+(?:said|talked|told|discussed|mentioned|agreed)\b` +
        String.raw`|\bthe\s+(?:second|third|fourth|fifth|sixth|\d+(?:st|nd|rd|th))\s+time\b` +
        String.raw`|هنوز\s*(?:هم\s*)?(?:درست|حل|رفع)?\s*(?:نشده|نشد|خراب|اشتباه)` +
        String.raw`|دوباره\s+(?:همان|همون|همین)\s+(?:مشکل|باگ|خطا)`,
      'i',
    ),
    line: 'Skill router: repeated report - the last fix did not hold: reproduce the exact symptom first, change approach (C22), and check that symptom itself before replying.',
  },
];
const UI_FILE = /\.(tsx|jsx|vue|svelte|html|css|scss|sass|less)$/i;
const NON_UI_FILE = /\.(test|spec|stories)\.\w+$/i;
const SAFE_ID = /^[\w-]{1,128}$/;
const STATE_DIR = join(tmpdir(), 'claude-skill-router');
const PROMPT_STATE_DIR = join(STATE_DIR, 'prompt'); // one file per session: the skills already named in full text
const UI_STATE_DIR = join(STATE_DIR, 'ui'); // one empty file per session: this session is UI work
const UI_IMPLEMENTER = 'ui-implementer';
const FOLLOW_UP_SKILLS = ['accessibility-build', 'responsive-ui', 'ui-quality-pass'];
const COMPACT_SOURCE = 'compact';
const OFF_ENV = 'CLAUDE_SKILL_ROUTER';
const GRADLE_FILES = ['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts'];

/** Returns the gate routes (bug -> root-cause-debug, done/ship -> verify-done, repo restructure -> repo-restructure, git history -> git-linear-history) a prompt calls for. */
function gatesForPrompt(prompt) {
  return HARNESS_EVENT.test(prompt.trim()) ? [] : GATE_ROUTES.filter((gate) => gate.test.test(prompt));
}

/** Returns the gate-route lines a prompt calls for, without the once-per-session filter. */
export function gateLinesForPrompt(prompt) {
  return gatesForPrompt(prompt).map((gate) => gate.line);
}

/** Returns the skills a prompt calls for, in first-match order, without duplicates. */
export function skillsForPrompt(prompt) {
  if (HARNESS_EVENT.test(prompt.trim())) return [];
  const picked = PROMPT_ROUTES.filter((route) => route.test.test(prompt)).flatMap((route) => route.skills);
  return [...new Set(picked)];
}

// Too vague alone (hence "header" only in UI phrases, never HTTP; no "table", "tab", "menu", "grid"); they count only
// in a session already marked as UI work.
const WEAK_UI =
  /\b(styles?|styled|layout|align\w*|margin|padding|colou?rs?|fonts?|icons?|sidebar|footer|hero|banner|tooltip|cards?|theme|dark mode|hover|animation|(page|site|nav|section) header|header (bar|section|area|nav)|pages?)\b|رنگ|فونت|هدر|منو|دکمه|آیکون|چیدمان|فاصله/i;

/** True when a prompt has a weak UI word (follow-up styling talk); the caller checks the session is UI work. */
export function weakUiPrompt(prompt) {
  return !HARNESS_EVENT.test(prompt.trim()) && WEAK_UI.test(prompt);
}

/** True when an edited path is UI source (not a test or story). */
export const isUiFile = (file) => UI_FILE.test(file) && !NON_UI_FILE.test(file);

const fullPromptText = (skills) =>
  `Skill router: this request involves UI. Before writing UI code, invoke with the Skill tool: ${skills.join(', ')}` +
  ' (skip any already loaded in this context). A project skill with the same purpose whose paths match wins.' +
  ' Delegate UI implementation to the `ui-implementer` agent, not `implementer`, and name these skills in the' +
  ' delegation prompt (a project\'s own `ui-implementer` preloads only project skills);' +
  ' run `ui-quality-pass` before saying done.';

const shortPromptText = (skills) =>
  `Skill router: UI request - invoke ${skills.join(', ')} (skip any already loaded); delegate to ui-implementer; ` +
  'ui-quality-pass before done.';

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
      'delegate to ui-implementer; ui-quality-pass before done.';
  }
  return fullPromptText(FOLLOW_UP_SKILLS);
}

function promptContext(prompt, sessionId) {
  const skills = skillsForPrompt(prompt);
  if (skills.length === 0) return weakUiPrompt(prompt) && isUiSession(sessionId) ? followUpContext(sessionId) : null;
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

function editContext(input) {
  const file = input.tool_input?.file_path ?? '';
  if (!isUiFile(file)) return null;
  markUiSession(input.session_id);
  if (input.agent_type === UI_IMPLEMENTER || !firstUiEdit(input.session_id, input.agent_id)) return null;
  return 'Skill router: you are editing UI code. If not yet loaded in this context, invoke `responsive-ui` and' +
    ' `accessibility-build` now (also `forms-validation` for forms, `async-ui-states` for server data,' +
    ' `figma-pixel-perfect` when there is a Figma frame), and run `ui-quality-pass` before reporting done.';
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
  if (!context) return;
  const hookSpecificOutput = { hookEventName: input.hook_event_name, additionalContext: context };
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
