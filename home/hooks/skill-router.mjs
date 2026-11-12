// Skill router hook. Skills are model-invoked from their descriptions only, so in busy projects (many project and
// plugin skills, delegated subagents) the UI skills get skipped. This hook makes the choice deterministic.
// UserPromptSubmit: prompt keywords -> names the skills to invoke (additionalContext, every matching prompt).
// PostToolUse(Edit|Write|MultiEdit) on a UI file -> reminds once per session and agent (subagents included).
// Quiet (no output) when CLAUDE_SKILL_ROUTER=off or in a Gradle project without package.json (Android routing
// lives in the personal per-project layer there). Never blocks: always exits 0; unparsable input produces no output.
import { mkdirSync, existsSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROMPT_ROUTES = [
  { test: /figma\.com|figma|pixel[\s-]?perfect|match (the )?(design|frame)|فیگما/i, skills: ['figma-pixel-perfect', 'responsive-ui'] },
  { test: /responsive|mobile[\s-]?(first|layout|view|screen|width|breakpoint)|tablet|breakpoint|overflow|viewport|reflow|ریسپانسیو|موبایل/i, skills: ['responsive-ui'] },
  { test: /\b(forms?|validation|validate)\b|فرم/i, skills: ['forms-validation'] },
  { test: /\b(loading|empty|error) states?\b|\bskeleton|\bpagination/i, skills: ['async-ui-states'] },
  // Bare "keyboard", "focus" and "aria" (in "variable") fired on non-UI prompts, so they need UI context words.
  {
    test: /a11y|accessib|keyboard[\s-]?(nav\w*|access\w*|trap|support|only)|focus[\s-]?(ring|trap|order|state|visible|management)|\baria\b|aria-|contrast|screen reader/i,
    skills: ['accessibility-build'],
  },
  {
    // Bare "page", "step", "style", "card", "theme", "layout" fired on non-UI prompts: require a UI noun or phrase.
    test: /\b(ui|ux|components?|screens?|modals?|dialogs?|drawers?|buttons?|navbar|css|scss|sx|tailwind|mui|styling|spacing|responsive|page[\s-]?layouts?|form[\s-]?fields?)\b|صفحه|کامپوننت|استایل|طراحی/i,
    skills: ['accessibility-build', 'responsive-ui', 'ui-quality-pass'],
  },
];
// Harness events (background task results, injected reminders) arrive as prompts but are not user text.
const HARNESS_EVENT = /^<(task-notification|system-reminder)/;
const UI_FILE = /\.(tsx|jsx|vue|svelte|html|css|scss|sass|less)$/i;
const NON_UI_FILE = /\.(test|spec|stories)\.\w+$/i;
const SAFE_ID = /^[\w-]{1,128}$/;
const STATE_DIR = join(tmpdir(), 'claude-skill-router');
const OFF_ENV = 'CLAUDE_SKILL_ROUTER';
const GRADLE_FILES = ['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts'];

/** Returns the skills a prompt calls for, in first-match order, without duplicates. */
export function skillsForPrompt(prompt) {
  if (HARNESS_EVENT.test(prompt.trim())) return [];
  const picked = PROMPT_ROUTES.filter((route) => route.test.test(prompt)).flatMap((route) => route.skills);
  return [...new Set(picked)];
}

/** True when an edited path is UI source (not a test or story). */
export const isUiFile = (file) => UI_FILE.test(file) && !NON_UI_FILE.test(file);

function promptContext(prompt) {
  const skills = skillsForPrompt(prompt);
  if (skills.length === 0) return null;
  return `Skill router: this request involves UI. Before writing UI code, invoke with the Skill tool: ${skills.join(', ')}` +
    ' (skip any already loaded in this context). A project skill with the same purpose whose paths match wins.' +
    ' Delegate UI implementation to the `ui-implementer` agent, not `implementer`, and name these skills in the' +
    ' delegation prompt (a project\'s own `ui-implementer` preloads only project skills);' +
    ' run `ui-quality-pass` before saying done.';
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
  if (!isUiFile(file) || !firstUiEdit(input.session_id, input.agent_id)) return null;
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
  if (isQuiet(input.cwd)) return null;
  if (input.hook_event_name === 'UserPromptSubmit') return promptContext(String(input.prompt ?? ''));
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
