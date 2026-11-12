// Tests for home/hooks/skill-router.mjs: prompt routing, full vs short text per session, compact reset, UI file detection, quiet mode, hook contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isQuiet, isUiFile, skillsForPrompt } from '../home/hooks/skill-router.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/skill-router.mjs', import.meta.url));

test('backend prompts route to no UI skill', () => {
  for (const prompt of [
    'validate the JSON payload in the API',
    'add validation to the endpoint',
    'fix stack overflow in parser',
    'fix the tablet bug',
    'add a REST endpoint for orders',
    'fix integer overflow in the hash function',
    'parse multipart form data in the upload handler',
    'transform the response and perform a retry',
    'fix the page cache and the step runner',
  ]) {
    assert.deepEqual(skillsForPrompt(prompt), [], prompt);
  }
});

test('UI prompts keep routing to their skills', () => {
  const cases = [
    ['fix the form validation', 'forms-validation'],
    ['add a form to the page', 'forms-validation'],
    ['validate the form fields', 'forms-validation'],
    ['text overflow on mobile', 'responsive-ui'],
    ['use overflow-x hidden here', 'responsive-ui'],
    ['it breaks on a tablet', 'responsive-ui'],
    ['tablet layout is off', 'responsive-ui'],
    ['فرم ثبت نام', 'forms-validation'],
    ['make it responsive', 'responsive-ui'],
    ['add a loading state', 'async-ui-states'],
    ['keyboard navigation is broken', 'accessibility-build'],
    ['match the figma frame', 'figma-pixel-perfect'],
    ['build the settings component', 'ui-quality-pass'],
  ];
  for (const [prompt, skill] of cases) assert.ok(skillsForPrompt(prompt).includes(skill), prompt);
});

test('skillsForPrompt returns each skill once and ignores harness events', () => {
  const skills = skillsForPrompt('match the figma design and make it responsive');
  assert.equal(new Set(skills).size, skills.length);
  assert.deepEqual(skillsForPrompt('<task-notification>form overflow</task-notification>'), []);
  assert.deepEqual(skillsForPrompt('<system-reminder>responsive</system-reminder>'), []);
});

test('isUiFile accepts UI sources and rejects tests and stories', () => {
  assert.ok(['a.tsx', 'a.jsx', 'a.vue', 'a.css', 'index.HTML', 'a.scss'].every(isUiFile));
  assert.ok(!['a.test.tsx', 'a.spec.jsx', 'a.stories.tsx', 'a.ts', 'a.mjs', ''].some(isUiFile));
});

test('isQuiet: env off, Gradle without package.json, otherwise loud', async () => {
  assert.equal(isQuiet('/nonexistent', { CLAUDE_SKILL_ROUTER: 'off' }), true);
  assert.equal(isQuiet(undefined, {}), false);
  const gradle = await mkdtemp(join(tmpdir(), 'router-gradle-'));
  await writeFile(join(gradle, 'build.gradle.kts'), '');
  assert.equal(isQuiet(gradle, {}), true);
  await writeFile(join(gradle, 'package.json'), '{}');
  assert.equal(isQuiet(gradle, {}), false);
});

test('hook contract: bad JSON is silent; a UI prompt emits additionalContext; a backend prompt is silent', () => {
  const run = (input) => spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8' });
  for (const input of ['not json', '']) {
    const r = run(input);
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, '');
  }
  const ui = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the form validation' }));
  assert.equal(ui.status, 0);
  assert.match(JSON.parse(ui.stdout).hookSpecificOutput.additionalContext, /forms-validation/);
  const backend = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'add a REST endpoint for orders' }));
  assert.equal(backend.status, 0);
  assert.equal(backend.stdout, '');
});

// Each call gets its own temp dir as TMPDIR/TEMP so session markers never leak between tests or into real state.
async function routerSession() {
  const tmp = await mkdtemp(join(tmpdir(), 'router-state-'));
  const env = { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
  const fire = (event) => {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(event), encoding: 'utf8', env });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    return r.stdout === '' ? '' : JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  };
  const prompt = (text, sessionId = 's1') => fire({ hook_event_name: 'UserPromptSubmit', prompt: text, session_id: sessionId });
  const compact = (sessionId = 's1') => fire({ hook_event_name: 'SessionStart', source: 'compact', session_id: sessionId });
  return { prompt, compact, fire };
}

const FULL = /this request involves UI/;
const SHORT = /^Skill router: UI request - invoke .+ \(skip any already loaded\); delegate to ui-implementer; ui-quality-pass before done\.$/;

test('first routed prompt gets the full text, a repeat gets the short form', async () => {
  const { prompt } = await routerSession();
  assert.match(prompt('make it responsive'), FULL);
  const again = prompt('make it responsive on mobile');
  assert.match(again, SHORT);
  assert.match(again, /responsive-ui/);
  assert.equal(prompt('add a REST endpoint for orders'), '');
});

test('a newly routed skill gets the full text again, then the short form', async () => {
  const { prompt } = await routerSession();
  assert.match(prompt('make it responsive'), FULL);
  const added = prompt('fix the form validation');
  assert.match(added, FULL);
  assert.match(added, /forms-validation/);
  assert.match(prompt('fix the form validation again'), SHORT);
  assert.match(prompt('make it responsive'), SHORT);
});

test('sessions are independent', async () => {
  const { prompt } = await routerSession();
  assert.match(prompt('make it responsive', 'a'), FULL);
  assert.match(prompt('make it responsive', 'b'), FULL);
  assert.match(prompt('make it responsive', 'a'), SHORT);
});

test('SessionStart(compact) resets only that session; other sources and sessions are untouched', async () => {
  const { prompt, compact, fire } = await routerSession();
  prompt('make it responsive', 'a');
  prompt('make it responsive', 'b');
  assert.equal(compact('a'), '');
  assert.equal(fire({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'b' }), '');
  assert.match(prompt('make it responsive', 'a'), FULL);
  assert.match(prompt('make it responsive', 'b'), SHORT);
  assert.equal(compact('no-such-session'), '');
});

test('bad or missing session id: full text every time, no throw, no state', async () => {
  const { prompt, compact, fire } = await routerSession();
  for (const sessionId of ['../evil', 'a b', '', 'x'.repeat(200), null, 42]) {
    assert.match(prompt('make it responsive', sessionId), FULL);
    assert.match(prompt('make it responsive', sessionId), FULL);
    assert.equal(compact(sessionId), '');
  }
  assert.match(fire({ hook_event_name: 'UserPromptSubmit', prompt: 'make it responsive' }), FULL);
});
