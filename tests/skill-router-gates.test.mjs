// Tests for the gate routes that name no UI skill and came after bug and done: repo-restructure, git-linear-history and
// the repeated report (home/hooks/lib/gate-routes.mjs, run through home/hooks/skill-router.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateLinesForPrompt } from '../home/hooks/skill-router.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/skill-router.mjs', import.meta.url));

// One hook process per call, each session in its own temp dir: returns what the hook injected for a prompt.
async function routerSession() {
  const tmp = makeTempDir('router-gates-');
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
  for (const prompt of ['i want to restructure demo-web-ui, i want to remove nx from our project completely', 'restructure the project folders', 'restructure the repo',
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
  const tmp = makeTempDir('router-no-marker-');
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

// Review of the L22 stack: code prompts and file names that must not fire the restructure route.
const RESTRUCTURE_FALSE_FIRES = ['merge the projects list into a single array', 'merge the apps array into one object', 'merge everything into a single response',
  'merge everything into the default export', 'merge the libraries into a single map for the lookup', 'merge all packages into the lockfile',
  'clean up the project settings dialog', 'clean up the workspace switcher component', 'clean up the codebase naming in this module',
  'restructure the repository pattern in the data layer', 'restructure the project route table in the router',
  'delete lerna.json', 'remove nx.json from the exports', 'drop the nx dependency from this one package', 'replace the nx logo with our logo'];

test('gateLinesForPrompt: code, file and component talk does not fire repo-restructure (review findings)', () => {
  for (const prompt of RESTRUCTURE_FALSE_FIRES) assert.doesNotMatch(gateLinesForPrompt(prompt).join(), /repo-restructure/, prompt);
});

test('gateLinesForPrompt: repository-level wording still fires repo-restructure after the tightening', () => {
  for (const prompt of ['clean up the project', 'clean up the repo before the release', 'restructure the project folders', 'remove nx from our project completely',
    'remove nx.', 'delete lerna, we do not need it', 'merge the packages into a single package', 'merge all apps into one repo', 'replace nx with turborepo']) {
    assert.match(gateLinesForPrompt(prompt).join(), /repo-restructure/, prompt);
  }
});

test('gateLinesForPrompt: merging a base branch into a working branch fires git-linear-history', () => {
  for (const prompt of ['git merge main into my branch', 'merge main into the feature branch', 'merge develop into my branch']) {
    assert.match(gateLinesForPrompt(prompt).join(), /git-linear-history/, prompt);
  }
});

test('gateLinesForPrompt: rebase fires only as an action, and Persian branch talk needs a clean-up or merge word', () => {
  for (const prompt of ['rebase my branch on main', 'rebase onto develop', 'rebase this', 'please rebase', 'git rebase origin/main', 'برنچ‌های قدیمی را پاک کن', 'برنچ‌ها را ادغام کن']) {
    assert.match(gateLinesForPrompt(prompt).join(), /git-linear-history/, prompt);
  }
  for (const prompt of ['what does rebase do', 'explain rebase vs merge', 'explain what git rebase does', 'یک برنچ جدید بساز', 'برنچ را عوض کن']) {
    assert.doesNotMatch(gateLinesForPrompt(prompt).join(), /git-linear-history/, prompt);
  }
});

test('gateLinesForPrompt: the repeated-report misses fire', () => {
  for (const prompt of ['the bug is back again', 'it is back again', 'this still does not work', "still doesn't work", 'you did not fix it', "you didn't fix this",
    'for the third time, the border is wrong', 'as I said earlier, keep the mock data', 'as we said before, no snapshots']) {
    assert.ok(gateLinesForPrompt(prompt).includes(REPEATED_REPORT_LINE), prompt);
  }
});

test('gateLinesForPrompt: nothing was reported before in these prompts, so the repeated-report line stays quiet', () => {
  for (const prompt of ['the promise is not yet resolved when we render', 'it is not resolved by the cache', 'unit tests for the second time zone',
    'the second time the function is called it returns the cached value, why?', 'the third time is a charm, implement retry', 'as I said in the ticket, the endpoint is /orders',
    'as we agreed the API returns 404 for missing ids', 'does it still work in Safari?', 'come back again tomorrow', 'هنوز نشده بود که تمام کنم؟']) {
    assert.ok(!gateLinesForPrompt(prompt).includes(REPEATED_REPORT_LINE), prompt);
  }
});

// Remaining review findings: branch and tree words about code, and one more repeated-report miss.
test('gateLinesForPrompt: git graph, branches and trees in code or a UI do not fire git-linear-history', () => {
  for (const prompt of ['how does the git graph in the VS Code extension render?', 'prune the branches of the decision tree', 'remove branches from the AST that are dead code',
    'land the branches of the tree in the animation']) {
    assert.doesNotMatch(gateLinesForPrompt(prompt).join(), /git-linear-history/, prompt);
  }
});

test('gateLinesForPrompt: tidying the git graph and deleting repository branches still fire git-linear-history', () => {
  for (const prompt of ['clean up the git graph', 'tidy the git graph', 'delete the branches from the remote', 'prune the merged branches', 'land the branches on main']) {
    assert.match(gateLinesForPrompt(prompt).join(), /git-linear-history/, prompt);
  }
});

test('gateLinesForPrompt: asking the same thing repeatedly fires the repeated-report line', () => {
  for (const prompt of ['I asked you to fix this twice already', 'i already asked you before to keep the mock data']) {
    assert.ok(gateLinesForPrompt(prompt).includes(REPEATED_REPORT_LINE), prompt);
  }
  assert.ok(!gateLinesForPrompt('I asked you to run the tests again').includes(REPEATED_REPORT_LINE), 'a plain request to run again is not a repeated report');
});
