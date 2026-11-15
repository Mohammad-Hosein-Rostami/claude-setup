// Tests for the gate routes that name no UI skill and came after bug and done: repo-restructure, git-linear-history and
// the repeated report (home/hooks/lib/gate-routes.mjs, run through home/hooks/skill-router.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateLinesForPrompt } from '../home/hooks/skill-router.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/skill-router.mjs', import.meta.url));

// One hook process per call, each session in its own temp dir: returns what the hook injected for a prompt.
async function routerSession() {
  const tmp = await mkdtemp(join(tmpdir(), 'router-gates-'));
  const env = { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
  const fire = (event) => {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(event), encoding: 'utf8', env });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    return r.stdout === '' ? '' : JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  };
  const prompt = (text, sessionId = 's1') => fire({ hook_event_name: 'UserPromptSubmit', prompt: text, session_id: sessionId });
  const compact = (sessionId = 's1') => fire({ hook_event_name: 'SessionStart', source: 'compact', session_id: sessionId });
  return { prompt, compact };
}

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
  const { prompt, compact } = await routerSession();
  assert.equal(
    await prompt('restructure the repo', 'r1'),
    'Skill router: repository restructure - invoke repo-restructure (skip if already loaded) before moving or deleting anything.',
  );
  assert.equal(await prompt('now migrate off Nx', 'r1'), '');
  compact('r1');
  assert.match(await prompt('migrate off Nx', 'r1'), /repo-restructure/);
  assert.equal(await prompt('restructure this function', 'r2'), '');
  assert.equal(await prompt('<agent-message>restructure the repo</agent-message>', 'r3'), '');
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
  const { prompt, compact } = await routerSession();
  assert.equal(
    await prompt('clean up the git tree', 'l1'),
    'Skill router: git history or branches - invoke git-linear-history (skip if already loaded) before merging, rebasing or deleting branches.',
  );
  assert.equal(await prompt('now rebase my branch on main', 'l1'), '');
  compact('l1');
  assert.match(await prompt('rebase my branch on main', 'l1'), /git-linear-history/);
  assert.equal(await prompt('merge sort', 'l2'), '');
  assert.equal(await prompt('<agent-message>clean up the git tree</agent-message>', 'l3'), '');
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
  const { prompt, compact } = await routerSession();
  assert.equal(await prompt('the border colour is still wrong', 'q1'), REPEATED_REPORT_LINE);
  assert.equal(await prompt('it is still flashing', 'q1'), REPEATED_REPORT_LINE);
  assert.equal(await prompt('this is the third time', 'q1'), REPEATED_REPORT_LINE);
  compact('q1');
  assert.equal(await prompt('هنوز درست نشده', 'q1'), REPEATED_REPORT_LINE);
  assert.equal(await prompt('run the tests again', 'q2'), '');
  for (const event of ['<agent-message>the border colour is still wrong</agent-message>', '<task-notification>still not fixed</task-notification>', '[SYSTEM NOTIFICATION - NOT USER INPUT] i told you before']) {
    assert.equal(await prompt(event, 'q3'), '', event);
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
  const { prompt } = await routerSession();
  const first = await prompt('the crash is still not fixed', 'q4');
  assert.match(first, /root-cause-debug/);
  assert.ok(first.split('\n').includes(REPEATED_REPORT_LINE));
  assert.equal(await prompt('the crash is still not fixed', 'q4'), REPEATED_REPORT_LINE);
});
