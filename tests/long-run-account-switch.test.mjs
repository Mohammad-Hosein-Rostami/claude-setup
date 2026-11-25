// Tests of `long-run resume <run> --account <name>` (plan long-run-account-switch, acceptance 1a-1k): a paused, held or limit-waiting run
// continues its own sessions on another account, the new account passes the start check first, a refusal changes nothing, and no
// token reaches output, the run folder or the state folder. The runs are real detached drivers (pause is the CLI's) over the fake claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileStore } from '../home/tools/account/lib/file-store.mjs';
import { readEventLines } from '../home/tools/long-run/lib/events.mjs';
import { isPidAlive, readJson, readJsonLines, runPaths, writeJournal } from '../home/tools/long-run/lib/run-store.mjs';
import { TOKEN_A, TOKEN_B, cli, createRun, driveRun, journalOf, killRunProcesses, makeSandbox, readCalls, waitFor } from './long-run-helpers.mjs';

const STEP_WAIT_MS = 30000;
const DAY_MS = 24 * 60 * 60 * 1000;
const hash = (token) => createHash('sha256').update(token).digest('hex');
const flagValue = (args, flag) => args[args.indexOf(flag) + 1];
const oneStep = (box, name) => ({ name, cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] });
const driverGone = (paths) => () => !isPidAlive(readJson(paths.driver)?.pid);

/**
 * Starts `job` detached through the CLI; returns the run's paths once `step` runs, or once `ready(paths)` is true when a step
 * that ends by itself is wanted (a driver left by a failed wait is killed).
 */
async function startRunning(box, job, step, ready = null) {
  const result = cli(box, ['start', box.writeJob(job)]);
  assert.equal(result.status, 0, result.stderr);
  const paths = runPaths(box.root, /^started (\S+)/m.exec(result.stdout)[1]);
  try {
    const running = () => readJson(paths.driver)?.live?.[step]?.state === 'running' && readCalls(box).some((call) => call.step === step);
    await waitFor(ready ? () => ready(paths) : running, STEP_WAIT_MS, `${step} ready`);
  } catch (error) {
    killRunProcesses(box, paths);
    throw error;
  }
  return paths;
}

/** `pause <run>`, then waits until the driver wrote `paused` and is gone. */
async function pause(box, paths) {
  assert.equal(cli(box, ['pause', paths.runId]).status, 0);
  await waitFor(() => readJson(paths.driver).status === 'paused' && driverGone(paths)(), STEP_WAIT_MS, 'paused');
}

/** Every file under the run folder, plus the global event log and its counter, as relative name -> base64 content. */
function snapshot(box, paths) {
  const bytes = {};
  const add = (dir, name) => {
    const path = join(dir, name);
    if (statSync(path).isFile()) bytes[path] = readFileSync(path).toString('base64');
  };
  for (const name of readdirSync(paths.dir, { recursive: true })) add(paths.dir, String(name));
  for (const name of ['events.log', 'events.seq']) if (existsSync(join(box.root, name))) add(box.root, name);
  return bytes;
}

const switchedEvents = (paths) => readJsonLines(paths.events).filter((entry) => entry.event === 'account-switched');
const switchedLines = (box, paths) => readEventLines(box.root, { run: paths.runId }).filter((line) => line.includes(' account-switched '));

function filesUnder(dir) {
  return readdirSync(dir, { recursive: true }).map((name) => join(dir, String(name))).filter((path) => statSync(path).isFile());
}

test('1a: a paused run resumed with --account acct-b records the switch once and continues the same session on acct-b with its token', async () => {
  const box = makeSandbox();
  box.script({ one: ['hang', 'done'] });
  const paths = await startRunning(box, oneStep(box, 'switch'), 'one');
  try {
    await pause(box, paths);
    const sessionId = journalOf(paths, 'one').sessionId;
    const resumed = cli(box, ['resume', paths.runId, '--account', 'acct-b', '--foreground']);
    assert.equal(resumed.status, 0, resumed.stderr);
    const run = readJson(paths.run);
    assert.equal(run.account, 'acct-b');
    assert.equal(run.switches.length, 1);
    assert.deepEqual({ from: run.switches[0].from, to: run.switches[0].to }, { from: 'acct-a', to: 'acct-b' });
    assert.ok(!Number.isNaN(Date.parse(run.switches[0].at)), 'the entry has a time');
    const events = switchedEvents(paths);
    assert.equal(events.length, 1);
    assert.deepEqual([events[0].detail, events[0].from, events[0].to], ['account acct-a -> acct-b', 'acct-a', 'acct-b']);
    const lines = switchedLines(box, paths);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].endsWith('account acct-a -> acct-b'), lines[0]);
    const calls = readCalls(box);
    assert.equal(calls.length, 2);
    assert.deepEqual([calls[0].account, calls[0].tokenHash], ['acct-a', hash(TOKEN_A)]);
    assert.deepEqual([calls[1].account, calls[1].tokenHash], ['acct-b', hash(TOKEN_B)]);
    assert.equal(flagValue(calls[1].args, '--resume'), sessionId);
    assert.equal(readJson(paths.driver).status, 'done');
  } finally {
    killRunProcesses(box, paths);
  }
});

test('1b: an account whose usage credits are not recorded off is refused with exit 1 and the fix; nothing changes and no boss starts', async () => {
  const box = makeSandbox({ creditsOff: { 'acct-a': true, 'acct-b': false } });
  box.script({ one: ['hang', 'done'] });
  const paths = await startRunning(box, oneStep(box, 'nocredits'), 'one');
  try {
    await pause(box, paths);
    const before = snapshot(box, paths);
    const refused = cli(box, ['resume', paths.runId, '--account', 'acct-b', '--foreground']);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /claude-account credits-off acct-b/);
    assert.deepEqual(snapshot(box, paths), before);
    assert.equal(readCalls(box).length, 1, 'no new boss');
    assert.equal(readJson(paths.driver).status, 'paused');
  } finally {
    killRunProcesses(box, paths);
  }
});

test('1c: an account that is not stored (ghost) and a stored one with no token in the store are refused with exit 1; nothing changes', async () => {
  const box = makeSandbox();
  box.script({ one: ['hang', 'done'] });
  const paths = await startRunning(box, oneStep(box, 'unusable'), 'one');
  try {
    await pause(box, paths);
    assert.equal(fileStore(box.folders.accounts).remove('acct-b'), true, 'precondition: the token of acct-b is gone, its registry entry stays');
    const before = snapshot(box, paths);
    const ghost = cli(box, ['resume', paths.runId, '--account', 'ghost', '--foreground']);
    assert.equal(ghost.status, 1);
    assert.match(ghost.stderr, /account ghost is gone from the store/);
    const tokenless = cli(box, ['resume', paths.runId, '--account', 'acct-b', '--foreground']);
    assert.equal(tokenless.status, 1);
    assert.match(tokenless.stderr, /account acct-b is gone from the store: add it again with claude-as acct-b/);
    assert.deepEqual(snapshot(box, paths), before);
    assert.equal(readCalls(box).length, 1, 'no new boss');
  } finally {
    killRunProcesses(box, paths);
  }
});

test('1d: --account - , --account Bad/Name and --account with no value exit 2; nothing changes and no boss starts', async () => {
  const box = makeSandbox();
  box.script({ one: ['hang', 'done'] });
  const paths = await startRunning(box, oneStep(box, 'badname'), 'one');
  try {
    await pause(box, paths);
    const before = snapshot(box, paths);
    const cases = [
      [['--account', '-'], /--account takes an account name/],
      [['--account', 'Bad/Name'], /--account takes an account name/],
      [['--account'], /--account needs a value/],
    ];
    for (const [args, message] of cases) {
      const refused = cli(box, ['resume', paths.runId, ...args]); // --account last: a flag after it would be taken as its value
      assert.equal(refused.status, 2, args.join(' '));
      assert.match(refused.stderr, message);
    }
    assert.deepEqual(snapshot(box, paths), before);
    assert.equal(readCalls(box).length, 1, 'no new boss');
  } finally {
    killRunProcesses(box, paths);
  }
});

test('1e: a run whose driver is alive refuses --account with exit 4 naming long-run pause; run.json is unchanged', async () => {
  const box = makeSandbox();
  box.script({ one: ['hang'] });
  const paths = await startRunning(box, oneStep(box, 'busy'), 'one');
  try {
    const before = readFileSync(paths.run, 'utf8');
    const busy = cli(box, ['resume', paths.runId, '--account', 'acct-b']);
    assert.equal(busy.status, 4);
    assert.match(busy.stderr, new RegExp(`long-run pause ${paths.runId}, then resume --account acct-b`));
    assert.equal(readFileSync(paths.run, 'utf8'), before);
    assert.equal(readCalls(box).length, 1, 'no second boss');
    assert.deepEqual(switchedEvents(paths), []);
  } finally {
    killRunProcesses(box, paths);
  }
});

test('1f: a step paused in a limit wait of acct-a starts at once on acct-b: its journal drops the wait and says so', async () => {
  const box = makeSandbox();
  box.script({ one: ['limit', 'done'] });
  const paths = await startRunning(box, oneStep(box, 'limitwait'), 'one', (run) => journalOf(run, 'one')?.waitUntil);
  try {
    await pause(box, paths);
    // a reset a day away: a start inside the test's timeout can only come from the switch dropping the wait
    const waiting = journalOf(paths, 'one');
    assert.equal(waiting.account, 'acct-a');
    writeJournal(paths, 'one', { ...waiting, waitUntil: new Date(Date.now() + DAY_MS).toISOString() });
    const resumed = cli(box, ['resume', paths.runId, '--account', 'acct-b']);
    assert.equal(resumed.status, 0, resumed.stderr);
    await waitFor(() => readCalls(box).length === 2, STEP_WAIT_MS, 'the step starts again');
    await waitFor(() => readJson(paths.driver).status === 'done', STEP_WAIT_MS, 'run done');
    const journal = journalOf(paths, 'one');
    assert.equal(journal.waitUntil, null);
    assert.equal(journal.account, 'acct-b');
    assert.ok(journal.notes.includes('account acct-a -> acct-b: limit wait dropped'), JSON.stringify(journal.notes));
    assert.deepEqual([readCalls(box)[1].account, readCalls(box)[1].tokenHash], ['acct-b', hash(TOKEN_B)]);
  } finally {
    killRunProcesses(box, paths);
  }
});

test('1g: in a group with one item done, the done item keeps acct-a in its journal and the other item starts on acct-b', async () => {
  const box = makeSandbox();
  box.script({ g1: ['done'], g2: ['hang', 'done'] });
  const job = { name: 'groupswitch', cwd: box.work('repo'), steps: [{ id: 'pages', parallel: ['g1', 'g2'].map((id) => ({ id, prompt: `Page ${id}.`, cwd: box.work(id) })) }] };
  const paths = await startRunning(box, job, 'g2');
  try {
    await waitFor(() => journalOf(paths, 'g1')?.final?.status === 'done', STEP_WAIT_MS, 'g1 done');
    await pause(box, paths);
    const sessionId = journalOf(paths, 'g2').sessionId;
    const resumed = cli(box, ['resume', paths.runId, '--account', 'acct-b', '--foreground']);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(journalOf(paths, 'g1').account, 'acct-a');
    assert.equal(journalOf(paths, 'g2').account, 'acct-b');
    const calls = readCalls(box);
    // the two items start in parallel, so their first starts come in either order; the third call is g2 after the switch
    assert.deepEqual(calls.slice(0, 2).map((call) => [call.step, call.account, call.tokenHash]).sort(), [['g1', 'acct-a', hash(TOKEN_A)], ['g2', 'acct-a', hash(TOKEN_A)]]);
    assert.deepEqual([calls[2].step, calls[2].account, calls[2].tokenHash], ['g2', 'acct-b', hash(TOKEN_B)]);
    assert.equal(flagValue(calls[2].args, '--resume'), sessionId);
  } finally {
    killRunProcesses(box, paths);
  }
});

test('1h: --account naming the run\'s own account prints "already on acct-a", records no switch or event, and resumes the run', async () => {
  const box = makeSandbox();
  box.script({ one: ['hang', 'done'] });
  const paths = await startRunning(box, oneStep(box, 'same'), 'one');
  try {
    await pause(box, paths);
    const resumed = cli(box, ['resume', paths.runId, '--account', 'acct-a', '--foreground']);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout, /^already on acct-a$/m);
    assert.ok(!('switches' in readJson(paths.run)), 'run.json has no switches key');
    assert.deepEqual(switchedEvents(paths), []);
    assert.deepEqual(switchedLines(box, paths), []);
    const calls = readCalls(box);
    assert.equal(calls.length, 2, 'the run resumed');
    assert.deepEqual([calls[1].account, calls[1].tokenHash], ['acct-a', hash(TOKEN_A)]);
  } finally {
    killRunProcesses(box, paths);
  }
});

test('1i: a held step resumed with --account acct-b --retry switches and retries on acct-b with its token', async () => {
  const box = makeSandbox();
  box.script({ one: ['blocked', 'done'] });
  const paths = createRun(box, oneStep(box, 'heldswitch'));
  assert.equal(await driveRun(box, paths), 'held');
  const resumed = cli(box, ['resume', paths.runId, '--account', 'acct-b', '--retry', '--foreground']);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(readJson(paths.run).account, 'acct-b');
  assert.equal(switchedEvents(paths).length, 1);
  const calls = readCalls(box);
  assert.equal(calls.length, 2);
  assert.deepEqual([calls[0].account, calls[0].tokenHash], ['acct-a', hash(TOKEN_A)]);
  assert.deepEqual([calls[1].account, calls[1].tokenHash], ['acct-b', hash(TOKEN_B)]);
  assert.equal(journalOf(paths, 'one').final.status, 'done');
  assert.equal(readJson(paths.driver).status, 'done');
});

test('1j: after a switch neither token is in any output, in any file of the run or state folders, or in any argv (a boss that prints its token is redacted)', async () => {
  const box = makeSandbox();
  box.script({ one: ['hang', 'leak'] });
  const outputs = [];
  const run = (args) => {
    const result = cli(box, args);
    outputs.push(result.stdout, result.stderr);
    return result;
  };
  const paths = await startRunning(box, oneStep(box, 'secrets'), 'one');
  try {
    assert.equal(run(['pause', paths.runId]).status, 0);
    await waitFor(() => readJson(paths.driver).status === 'paused' && driverGone(paths)(), STEP_WAIT_MS, 'paused');
    const resumed = run(['resume', paths.runId, '--account', 'acct-b', '--foreground']);
    assert.equal(resumed.status, 0, resumed.stderr);
    for (const args of [['status', paths.runId], ['summary', paths.runId], ['log', paths.runId, 'one'], ['events', '--run', paths.runId]]) assert.equal(run(args).status, 0, args.join(' '));
    const calls = readCalls(box);
    assert.equal(calls[1].tokenHash, hash(TOKEN_B), 'precondition: the second boss ran on the token of acct-b');
    for (const token of [TOKEN_A, TOKEN_B]) {
      assert.deepEqual(outputs.filter((text) => text.includes(token)), [], 'no output');
      for (const call of calls) assert.ok(!call.args.join(' ').includes(token), 'no argv');
      for (const dir of [box.root, box.folders['account-state']]) {
        assert.deepEqual(filesUnder(dir).filter((path) => readFileSync(path).includes(token)), [], `no file of ${dir}`);
      }
    }
    assert.ok(filesUnder(paths.dir).length > 0 && filesUnder(paths.dir).some((path) => path.endsWith('.jsonl')), 'the run folder was scanned');
  } finally {
    killRunProcesses(box, paths);
  }
});

test('1k: after a switch summary.md says "Account: acct-b (was acct-a until"', async () => {
  const box = makeSandbox();
  box.script({ one: ['hang', 'done'] });
  const paths = await startRunning(box, oneStep(box, 'summary'), 'one');
  try {
    await pause(box, paths);
    const resumed = cli(box, ['resume', paths.runId, '--account', 'acct-b', '--foreground']);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(readFileSync(paths.summary, 'utf8'), /Account: acct-b \(was acct-a until /);
  } finally {
    killRunProcesses(box, paths);
  }
});
