// Tests for home/hooks/skill-router.mjs: prompt routing, full vs short text per session, compact reset, UI file detection, quiet mode, hook contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateLinesForPrompt, isQuiet, isUiFile, skillsForPrompt, weakUiPrompt } from '../home/hooks/skill-router.mjs';

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

test('i18n, RTL, locale, email-template and all-screens words route to ui-coverage; backend locale talk does not', () => {
  for (const prompt of [
    'the phone field is broken in RTL',
    'add i18n to the signup flow',
    'check every supported locale',
    'the email templates never got looked at',
    'apply this to all screens',
    'fix every form in the app',
    'ltr numbers inside right-to-left text',
    'صفحه را راست به چپ کن',
    'قالب ایمیل را بررسی کن',
  ]) {
    assert.ok(skillsForPrompt(prompt).includes('ui-coverage'), prompt);
  }
  for (const prompt of ['set the locale of the date formatter in the API', 'run the app on localhost', 'add a REST endpoint for orders', 'send the mail from the worker queue', 'show the locality of the store']) {
    assert.ok(!skillsForPrompt(prompt).includes('ui-coverage'), prompt);
  }
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

const GATE_LINE = /^Skill router: (bug or failure|done or ship|repository restructure) /;

// Each call gets its own temp dir as TMPDIR/TEMP so session markers never leak between tests or into real state.
async function routerSession() {
  const tmp = await mkdtemp(join(tmpdir(), 'router-state-'));
  const env = { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
  const fire = (event, { keepGates = false } = {}) => {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(event), encoding: 'utf8', env });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    const context = r.stdout === '' ? '' : JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    // The UI tests use prompts with "fix"; their assertions are about the UI text, so drop the gate lines unless asked.
    return keepGates ? context : context.split('\n').filter((line) => !GATE_LINE.test(line)).join('\n');
  };
  const prompt = (text, sessionId = 's1', options) => fire({ hook_event_name: 'UserPromptSubmit', prompt: text, session_id: sessionId }, options);
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

const FOLLOW_UP = /^Skill router: UI follow-up - invoke accessibility-build, responsive-ui/;

test('weakUiPrompt: UI follow-up words yes, HTTP header and DB table no', () => {
  assert.ok(weakUiPrompt('now style the settings page header'));
  assert.ok(!weakUiPrompt('add a header to the HTTP request'));
  assert.ok(!weakUiPrompt('fix the DB table index'));
  assert.ok(!weakUiPrompt('<system-reminder>style</system-reminder>'));
});

test('sticky UI: weak prompt follows up only in a UI session', async () => {
  const { prompt, fire } = await routerSession();
  assert.equal(prompt('now style the settings page header', 'cold'), '');
  prompt('make it responsive');
  assert.match(prompt('now style the settings page header'), FOLLOW_UP);
  assert.equal(prompt('add a header to the HTTP request'), '');
  assert.equal(prompt('fix the DB table index'), '');
  fire({ hook_event_name: 'SessionStart', source: 'compact', session_id: 's1' });
  assert.match(prompt('change the colors'), FULL);
});

test('UI file edit sets the marker even after the reminder was sent; ui-implementer gets no reminder', async () => {
  const { prompt, fire } = await routerSession();
  const edit = (extra, sessionId) =>
    fire({ hook_event_name: 'PostToolUse', session_id: sessionId, tool_input: { file_path: 'a.tsx' }, ...extra });
  assert.match(edit({}, 'e1'), /editing UI code/);
  assert.equal(edit({}, 'e1'), '');
  assert.match(prompt('tweak the padding', 'e1'), FULL);
  assert.equal(edit({ agent_type: 'ui-implementer', agent_id: 'x1' }, 'e2'), '');
  assert.match(prompt('tweak the padding', 'e2'), FULL);
});

test('skillsForPrompt and gateLinesForPrompt ignore every harness event form', () => {
  for (const event of ['<agent-message from="w1">make it responsive, fix the bug, done</agent-message>', '[SYSTEM NOTIFICATION - NOT USER INPUT] fix the responsive bug, we are done', '  <task-notification>fix bug</task-notification>']) {
    assert.deepEqual(skillsForPrompt(event), [], event);
    assert.deepEqual(gateLinesForPrompt(event), [], event);
    assert.equal(weakUiPrompt(event), false, event);
  }
});

test('gateLinesForPrompt: bug and done intents fire', () => {
  for (const prompt of ['fix the failing login test', 'please fix this', 'the parser crashes on empty input', 'there is a bug in checkout', 'the build is failing',
    'login does not work', 'باگ را رفع کن', 'debug the flaky test']) {
    assert.match(gateLinesForPrompt(prompt).join(), /root-cause-debug/, prompt);
  }
  for (const prompt of ['looks good, ship it', 'is it done? ready for review', 'we are done here', 'can we merge', 'ready to merge', 'wrap it up', 'کار تمام شد']) {
    assert.match(gateLinesForPrompt(prompt).join(), /verify-done/, prompt);
  }
  assert.equal(gateLinesForPrompt('fix it and ship it').length, 2);
});

test('gateLinesForPrompt: incidental words do not fire', () => {
  for (const prompt of ['add a REST endpoint for orders', 'write the README section', 'prefix the keys', 'the fix version is 2.1', 'I fixed it already',
    'when you are done, run the tests', 'resolve the merge conflicts in a.txt', 'a fixed width table', 'the done flag in the schema', 'rename the debugger config']) {
    assert.deepEqual(gateLinesForPrompt(prompt), [], prompt);
  }
});

test('gateLinesForPrompt: repository-level restructure intents fire repo-restructure', () => {
  for (const prompt of ['i want to restructure ice-web-app, i want to remove nx from our project completely', 'restructure the project folders', 'restructure the repo',
    'migrate off Nx', 'migrate away from turborepo', 'get rid of module federation', 'module federation is no longer needed, remove it',
    'merge the apps and libraries into one project', 'merge everything into a simple project called portal', 'convert the monorepo to a single app',
    'clean up the root of the repo and old configs', 'تغییر ساختار پروژه']) {
    assert.match(gateLinesForPrompt(prompt).join(), /repo-restructure/, prompt);
  }
});

test('gateLinesForPrompt: code-level or incidental restructure words do not fire repo-restructure', () => {
  for (const prompt of ['restructure this function', 'restructure the reducer into smaller hooks', 'remove the nx-cache folder from .gitignore', 'why is nx build slow', 'remove nx from the gitignore',
    'add a module federation remote', 'merge conflicts in package.json', 'merge this branch', 'clean up this component', 'move the button to the left']) {
    assert.doesNotMatch(gateLinesForPrompt(prompt).join(), /repo-restructure/, prompt);
  }
});

test('hook: repo-restructure line reaches additionalContext once per session, again after a compact', async () => {
  const KEEP = { keepGates: true };
  const { prompt, compact } = await routerSession();
  assert.equal(
    await prompt('restructure the repo', 'r1', KEEP),
    'Skill router: repository restructure - invoke repo-restructure (skip if already loaded) before moving or deleting anything.',
  );
  assert.equal(await prompt('now migrate off Nx', 'r1', KEEP), '');
  compact('r1');
  assert.match(await prompt('migrate off Nx', 'r1', KEEP), /repo-restructure/);
  assert.equal(await prompt('restructure this function', 'r2', KEEP), '');
  assert.equal(await prompt('<agent-message>restructure the repo</agent-message>', 'r3', KEEP), '');
});

test('gateLinesForPrompt: git history and branch intents fire git-linear-history', () => {
  for (const prompt of ['clean up the git tree', 'merge everything to master', 'merge the branches into main', 'remove old branches that were merged',
    'delete the merged branches', 'rebase my branch on main', 'the git history is messy, fix it', 'land the lanes on main', 'fix up the git tree to be clean',
    'squash these commits', 'تاریخچه گیت را مرتب کن']) {
    assert.match(gateLinesForPrompt(prompt).join(), /git-linear-history/, prompt);
  }
});

test('gateLinesForPrompt: incidental branch, merge and tree words do not fire git-linear-history', () => {
  for (const prompt of ['merge conflicts in package.json', 'this function has two branches', 'branch coverage is low', 'merge these two objects', 'merge sort',
    'create a branch for the login work', 'what does git stash do', 'the tree view component', 'clean up this component', 'merge everything into main.ts',
    'merge everything into a simple project called portal']) {
    assert.doesNotMatch(gateLinesForPrompt(prompt).join(), /git-linear-history/, prompt);
  }
});

test('hook: git-linear-history line reaches additionalContext once per session, again after a compact', async () => {
  const KEEP = { keepGates: true };
  const { prompt, compact } = await routerSession();
  assert.equal(
    await prompt('clean up the git tree', 'l1', KEEP),
    'Skill router: git history or branches - invoke git-linear-history (skip if already loaded) before merging, rebasing or deleting branches.',
  );
  assert.equal(await prompt('now rebase my branch on main', 'l1', KEEP), '');
  compact('l1');
  assert.match(await prompt('rebase my branch on main', 'l1', KEEP), /git-linear-history/);
  assert.equal(await prompt('merge sort', 'l2', KEEP), '');
  assert.equal(await prompt('<agent-message>clean up the git tree</agent-message>', 'l3', KEEP), '');
});

const REPEATED_REPORT_LINE = 'Skill router: repeated report - the last fix did not hold: reproduce the exact symptom first, change approach (C22), and check that symptom itself before replying.';
const REPEATED_REPORT_FIRES = ['the border colour is still wrong', 'it is still flashing', 'still not fixed', 'this is not fixed', 'same problem again', 'again the same issue',
  'i told you before', 'as i said before, keep testing with mock data', 'as we talked before keep testing with mock data', 'how about the other issues i told you',
  'this is the third time', 'هنوز درست نشده', 'دوباره همان مشکل'];
const REPEATED_REPORT_QUIET = ['is the server still running?', 'a still image for the hero', 'run the tests again', 'try again later', 'tell me again how the cache works',
  'still, I prefer option B', 'keep the tests as they are', 'add the same problem statement to the README', 'fixed-width font'];

test('gateLinesForPrompt: a repeated report fires the repeated-report line', () => {
  for (const prompt of REPEATED_REPORT_FIRES) assert.ok(gateLinesForPrompt(prompt).includes(REPEATED_REPORT_LINE), prompt);
});

test('gateLinesForPrompt: still, again and same used in other ways do not fire the repeated-report line', () => {
  for (const prompt of REPEATED_REPORT_QUIET) assert.ok(!gateLinesForPrompt(prompt).includes(REPEATED_REPORT_LINE), prompt);
});

test('hook: the repeated-report line fires on every matching prompt, not once per session, and never on harness events', async () => {
  const KEEP = { keepGates: true };
  const { prompt, compact } = await routerSession();
  assert.equal(await prompt('the border colour is still wrong', 'q1', KEEP), REPEATED_REPORT_LINE);
  assert.equal(await prompt('it is still flashing', 'q1', KEEP), REPEATED_REPORT_LINE);
  assert.equal(await prompt('this is the third time', 'q1', KEEP), REPEATED_REPORT_LINE);
  compact('q1');
  assert.equal(await prompt('هنوز درست نشده', 'q1', KEEP), REPEATED_REPORT_LINE);
  assert.equal(await prompt('run the tests again', 'q2', KEEP), '');
  for (const event of ['<agent-message>the border colour is still wrong</agent-message>', '<task-notification>still not fixed</task-notification>', '[SYSTEM NOTIFICATION - NOT USER INPUT] i told you before']) {
    assert.equal(await prompt(event, 'q3', KEEP), '', event);
  }
});

test('hook: the repeated-report line leaves no once-per-session marker behind', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'router-no-marker-'));
  const env = { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
  const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'still not fixed', session_id: 'nm1' });
  const r = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', env });
  assert.match(r.stdout, /repeated report/);
  assert.equal(existsSync(join(tmp, 'claude-skill-router', 'prompt', 'nm1')), false);
});

test('hook: a repeated report that also names a bug gets both lines, and the bug line still shows once', async () => {
  const KEEP = { keepGates: true };
  const { prompt } = await routerSession();
  const first = await prompt('the crash is still not fixed', 'q4', KEEP);
  assert.match(first, /root-cause-debug/);
  assert.ok(first.split('\n').includes(REPEATED_REPORT_LINE));
  assert.equal(await prompt('the crash is still not fixed', 'q4', KEEP), REPEATED_REPORT_LINE);
});

test('hook: gate lines reach additionalContext, also in a Gradle project and next to a UI route', async () => {
  const KEEP = { keepGates: true };
  const { prompt, fire } = await routerSession();
  assert.match(await prompt('fix the crash in the order service', 's1', KEEP), /^Skill router: bug or failure - invoke root-cause-debug/);
  assert.match(await prompt('we are done, ship it', 's2', KEEP), /verify-done/);
  const both = await prompt('fix the form validation bug', 's3', KEEP);
  assert.match(both, /forms-validation/);
  assert.match(both, /root-cause-debug/);
  const gradle = await mkdtemp(join(tmpdir(), 'router-gradle-gate-'));
  await writeFile(join(gradle, 'build.gradle.kts'), '');
  const ctx = fire({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the responsive layout bug', session_id: 's4', cwd: gradle }, KEEP);
  assert.match(ctx, /root-cause-debug/);
  assert.doesNotMatch(ctx, /involves UI/);
  assert.equal(await prompt('<agent-message>fix the bug</agent-message>', 's5', KEEP), '');
  assert.equal(await prompt('the fix version is 2.1', 's6', KEEP), '');
});

test('hook: each gate line shows once per session, again after a compact, and per session', async () => {
  const KEEP = { keepGates: true };
  const { prompt, compact } = await routerSession();
  assert.match(await prompt('fix the crash', 'g1', KEEP), /root-cause-debug/);
  assert.equal(await prompt('fix the other crash', 'g1', KEEP), '');
  assert.match(await prompt('ship it', 'g1', KEEP), /verify-done/); // a different gate is still new
  assert.equal(await prompt('ship it again', 'g1', KEEP), '');
  assert.match(await prompt('fix the crash', 'g2', KEEP), /root-cause-debug/); // another session
  compact('g1');
  assert.match(await prompt('fix the crash', 'g1', KEEP), /root-cause-debug/);
});

test('hook: CLAUDE_SKILL_ROUTER=off silences the gate lines too', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'router-off-'));
  const env = { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp, CLAUDE_SKILL_ROUTER: 'off' };
  const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the crash, then ship it', session_id: 'off1' });
  const r = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', env });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});
