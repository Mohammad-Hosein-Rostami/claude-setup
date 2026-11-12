// Skill router hook. Skills are model-invoked from their descriptions only, so in busy projects (many project and
// plugin skills, delegated subagents) the UI skills get skipped. This hook makes the choice deterministic.
// UserPromptSubmit: prompt keywords -> names the skills to invoke (additionalContext, every matching prompt).
// PostToolUse(Edit|Write|MultiEdit) on a UI file -> reminds once per session and agent (subagents included).
// Never blocks: always exits 0; unparsable input produces no output.
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROMPT_ROUTES = [
  { test: /figma\.com|figma|pixel[\s-]?perfect|match (the )?(design|frame)|فیگما/i, skills: ['figma-pixel-perfect', 'responsive-ui'] },
  { test: /responsive|mobile|tablet|breakpoint|overflow|viewport|reflow|ریسپانسیو|موبایل/i, skills: ['responsive-ui'] },
  { test: /\b(forms?|validation|validate|inputs?|fields?|submit)\b|فرم/i, skills: ['forms-validation'] },
  { test: /\b(loading|empty state|error state|skeleton|pagination|fetch(es|ing)?)\b/i, skills: ['async-ui-states'] },
  { test: /a11y|accessib|keyboard|focus|contrast|aria|screen reader/i, skills: ['accessibility-build'] },
  {
    test: /\b(ui|ux|pages?|screens?|components?|layouts?|steps?|modals?|dialogs?|drawers?|cards?|buttons?|styles?|styling|css|scss|sx|tailwind|mui|theme|spacing|align\w*)\b|صفحه|کامپوننت|استایل|طراحی/i,
    skills: ['accessibility-build', 'responsive-ui', 'ui-quality-pass'],
  },
];
const UI_FILE = /\.(tsx|jsx|vue|svelte|html|css|scss|sass|less)$/i;
const NON_UI_FILE = /\.(test|spec|stories)\.\w+$/i;
const SAFE_ID = /^[\w-]{1,128}$/;
const STATE_DIR = join(tmpdir(), 'claude-skill-router');

/** Returns the skills a prompt calls for, in first-match order, without duplicates. */
export function skillsForPrompt(prompt) {
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
    ' Delegate UI implementation to the `ui-implementer` agent (it preloads the UI skills), not `implementer`;' +
    ' run `ui-quality-pass` before saying done.';
}

// First UI edit per session and agent only; a marker file in the temp dir records that the reminder was sent.
function firstUiEdit(sessionId, agentId) {
  const ids = [sessionId, agentId ?? 'main'];
  if (!ids.every((id) => SAFE_ID.test(id))) return false;
  const marker = join(STATE_DIR, ids.join('--'));
  if (existsSync(marker)) return false;
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(marker, '');
  return true;
}

function editContext(input) {
  const file = input.tool_input?.file_path ?? '';
  if (!isUiFile(file) || !firstUiEdit(input.session_id, input.agent_id)) return null;
  return 'Skill router: you are editing UI code. If not yet loaded in this context, invoke `responsive-ui` and' +
    ' `accessibility-build` now (also `forms-validation` for forms, `async-ui-states` for server data,' +
    ' `figma-pixel-perfect` when there is a Figma frame), and run `ui-quality-pass` before reporting done.';
}

function route(input) {
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
