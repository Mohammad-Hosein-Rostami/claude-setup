// Tests for the event classes of `--exit-on-event` in follow mode on the real CLI: every default class wakes once with one line,
// the opt-in classes only when asked for, and the false alarms the review found (agent text, failed-tool words, sidechain API
// errors, guard bounces) do not wake. Synthetic transcripts only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { actionFor } from '../home/tools/watch/lib/actions.mjs';
import { createClassifier } from '../home/tools/watch/lib/classify.mjs';
import { DEFAULT_EXIT_CLASSES, EVENT_CLASS, EXIT_CLASS_NAMES, internalClasses } from '../home/tools/watch/lib/events.mjs';
import { CLI, SESSION, STAMP, entry, startWatcher } from './watch-follow-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const WAKE_WAIT_MS = 20_000;
const QUIET_MS = 4_000;
const owner = (text) => entry({ type: 'user', message: { content: text } });
const failedTool = (body) => entry({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: body }] } });
const apiError = (extra = {}) => entry({ type: 'assistant', isApiErrorMessage: true, error: 'server_error', message: { content: [] }, ...extra });
const limitError = entry({ type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', message: { content: [] } });
const agentCall = (description) => entry({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { description } }] } });
const reply = entry({ type: 'assistant', message: { model: 'm', content: [{ type: 'text', text: 'ok' }] } });
const guardLine = (outcome, session = SESSION) => `${JSON.stringify({ hook: 'pre-bash-guard', outcome, reason: 'DESTRUCTIVE: rm', command: 'rm x', session })}\n`;
const oneLine = (text) => text.endsWith('\n') && text.indexOf('\n') === text.length - 1;

async function registerProcess(home, pid) {
  await mkdir(join(home, '.claude', 'sessions'), { recursive: true });
  await writeFile(join(home, '.claude', 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: SESSION }));
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => child.on('close', resolve));
  return child.pid;
}

test('class table: names, defaults, opt-ins and the internal tags each name wakes on', () => {
  assert.deepEqual(DEFAULT_EXIT_CLASSES, ['owner', 'error', 'limit', 'api-error', 'guard', 'stall', 'watch-error', 'session-end']);
  assert.deepEqual(EXIT_CLASS_NAMES.slice(DEFAULT_EXIT_CLASSES.length), ['compact', 'stop-hook', 'model-mismatch', 'limit-reset', 'idle']);
  const expected = {
    owner: 'OWNER', error: 'ERROR', limit: 'LIMIT', 'api-error': 'API_ERROR', guard: 'GUARD', stall: 'STALL', 'watch-error': 'WATCH_ERROR',
    'session-end': 'SESSION_END', compact: 'COMPACT', 'stop-hook': 'STOP_HOOK', 'model-mismatch': 'MODEL_MISMATCH', 'limit-reset': 'LIMIT_RESET', idle: 'IDLE',
  };
  for (const [name, tag] of Object.entries(expected)) assert.deepEqual([...internalClasses([name])], [tag], name);
  assert.equal(EVENT_CLASS.RESUMED, 'RESUMED');
  assert.ok(![...internalClasses(EXIT_CLASS_NAMES)].includes(EVENT_CLASS.RESUMED), 'RESUMED is not a class');
});

test('every default class wakes exactly once with exactly one line and exit 0', async (t) => {
  const pid = await deadPid();
  const cases = [
    { name: 'owner', args: ['--exit-on-event', 'owner'], repeat: owner('please look'), line: 'OWNER please look' },
    { name: 'error', args: ['--exit-on-event', 'error'], repeat: failedTool('ERROR: build failed'), line: `${STAMP} ERR ERROR: build failed` },
    { name: 'limit', args: ['--exit-on-event', 'limit'], repeat: limitError, line: `${STAMP} LIMIT rate_limit` },
    { name: 'api-error', args: ['--exit-on-event', 'api-error'], repeat: apiError(), line: `${STAMP} API_ERROR server_error` },
    { name: 'guard', args: ['--exit-on-event', 'guard'], guard: guardLine('deny'), line: 'GUARD deny pre-bash-guard: DESTRUCTIVE: rm | rm x' },
    { name: 'stall', args: ['--exit-on-event', 'stall', '--stall-min', '0.03'], transcript: reply, line: 'STALL no transcript or subagent writes for 0 min' },
    { name: 'session-end', args: ['--exit-on-event', 'session-end', '--stall-min', '100'], transcript: reply, pid, line: `SESSION_END pid=${pid}` },
  ];
  await Promise.all(cases.map(async (item) => {
    const prepare = item.pid ? ({ home }) => registerProcess(home, item.pid) : undefined;
    const watcher = await startWatcher(t, { transcript: item.transcript ?? '', args: item.args, settle: item.guard !== undefined, prepare });
    const code = item.guard ? await watcher.appendUntilExit(item.guard, WAKE_WAIT_MS, watcher.guardLog)
      : item.repeat ? await watcher.appendUntilExit(item.repeat, WAKE_WAIT_MS) : await watcher.waitForExit(WAKE_WAIT_MS);
    assert.equal(code, 0, `${item.name}: exit code (stderr: ${watcher.errors()})`);
    assert.equal(watcher.output(), `eeeeeeee: ${item.line}\n`, item.name);
  }));
});

test('session-end: a watched session whose process is gone wakes within a few polls, with no stall involved', async (t) => {
  const pid = await deadPid();
  const watcher = await startWatcher(t, {
    transcript: reply, args: ['--exit-on-event', '--stall-min', '1000'],
    prepare: ({ home }) => registerProcess(home, pid),
  });
  assert.equal(await watcher.waitForExit(8_000), 0, watcher.errors());
  assert.equal(watcher.output(), `eeeeeeee: SESSION_END pid=${pid}\n`);
});

test('guard: a deny wakes, a bounce or an allow does not, and another session never does', async (t) => {
  const watcher = await startWatcher(t, { args: ['--exit-on-event', 'guard'], settle: true });
  assert.equal(await watcher.appendUntilExit(guardLine('bounce') + guardLine('allow') + guardLine('deny', 'ffffffff-0000'), QUIET_MS, watcher.guardLog), undefined);
  assert.equal(watcher.output(), '');
  assert.equal(await watcher.appendUntilExit(guardLine('deny'), WAKE_WAIT_MS, watcher.guardLog), 0);
  assert.ok(oneLine(watcher.output()));
});

test('opt-in classes: stop-hook feedback wakes only when asked for', async (t) => {
  const hook = entry({ type: 'user', isMeta: true, message: { content: 'Stop hook feedback: keep going' } });
  const quiet = await startWatcher(t, { args: ['--exit-on-event'] });
  assert.equal(await quiet.appendUntilExit(hook, QUIET_MS), undefined);
  const asked = await startWatcher(t, { args: ['--exit-on-event', 'stop-hook'] });
  assert.equal(await asked.appendUntilExit(hook, WAKE_WAIT_MS), 0);
  assert.match(asked.output(), /^eeeeeeee: .*Stop hook feedback/);
});

test('opt-in classes: a subagent that ran on another model wakes only for model-mismatch', async (t) => {
  const agent = async ({ path }) => {
    const folder = join(path.replace(/\.jsonl$/, ''), 'subagents');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'reviewer', model: 'sonnet' }));
    await writeFile(join(folder, 'agent-a1.jsonl'), `${JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-5-5' } })}\n`);
  };
  const asked = await startWatcher(t, { args: ['--once', '--exit-on-event', 'model-mismatch'], prepare: agent });
  assert.equal(await asked.waitForExit(WAKE_WAIT_MS), 0);
  assert.equal(asked.output(), 'eeeeeeee: MODEL MISMATCH type=reviewer asked=sonnet ran=claude-haiku-5-5\n');
  const defaults = await startWatcher(t, { args: ['--once', '--exit-on-event'], prepare: agent });
  assert.equal(await defaults.waitForExit(WAKE_WAIT_MS), 0);
  assert.equal(defaults.output(), '');
});

test('error class: alert words in an agent description or a successful tool result never wake; a failed tool result with them does', async (t) => {
  assert.notEqual(actionFor({ kind: 'AGENT', line: `${STAMP} AGENT type=x desc=map the RATE handling` }).cls, EVENT_CLASS.ERROR);
  assert.equal(actionFor({ kind: 'ERR', line: `${STAMP} ERR ERROR: build failed` }).cls, EVENT_CLASS.ERROR);
  const watcher = await startWatcher(t, { args: ['--exit-on-event', 'error'] });
  const successfulResult = entry({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ERROR in the log is fine' }] } });
  assert.equal(await watcher.appendUntilExit(agentCall('map the RATE and ERROR handling in billing') + successfulResult, QUIET_MS), undefined);
  assert.equal(watcher.output(), '');
  assert.equal(await watcher.appendUntilExit(failedTool('ERROR: build failed'), WAKE_WAIT_MS), 0);
});

test('plain mode still prints an alert-word line of an agent description, as before', async (t) => {
  const dir = makeTempDir('watch-plain-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, `${SESSION}.jsonl`);
  await writeFile(file, agentCall('map the RATE handling'));
  const run = spawnSync(process.execPath, [CLI, file, '--once', '--guard-log', join(dir, 'none')], { encoding: 'utf8' });
  assert.match(run.stdout, /AGENT type=general-purpose.*desc=map the RATE handling/);
});

test('sidechain entries: an API error from a subagent turn does not wake and a sidechain reply does not end a limit window', async (t) => {
  const watcher = await startWatcher(t, { args: ['--exit-on-event', 'api-error'] });
  assert.equal(await watcher.appendUntilExit(apiError({ isSidechain: true }), QUIET_MS), undefined);
  const classifier = createClassifier();
  classifier.feed(limitError.trim());
  assert.deepEqual(classifier.feed(entry({ type: 'assistant', isSidechain: true, message: { content: [] } }).trim()), []);
  assert.equal(classifier.feed(reply.trim())[0].kind, 'LIMIT_RESET');
});

test('with --log the event line is in the log file before the process exits', async (t) => {
  const logDir = makeTempDir('watch-log-');
  t.after(() => rm(logDir, { recursive: true, force: true }));
  const watcher = await startWatcher(t, { args: ['--exit-on-event', 'owner', '--log', logDir] });
  assert.equal(await watcher.appendUntilExit(owner('log me'), WAKE_WAIT_MS), 0);
  assert.match(await readFile(join(logDir, 'eeeeeeee.events.log'), 'utf8'), /PROMPT log me/);
});

test('a folder-clash WATCH_NOTE goes to stderr in exit mode, so stdout is the one event line', async (t) => {
  const home = makeTempDir('watch-note-');
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const project of ['-proj-a', '-proj-b']) {
    await mkdir(join(home, '.claude', 'projects', project), { recursive: true });
    await writeFile(join(home, '.claude', 'projects', project, `${SESSION}.jsonl`), owner('hello'));
  }
  await utimes(join(home, '.claude', 'projects', '-proj-a', `${SESSION}.jsonl`), 1, 1);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const run = spawnSync(process.execPath, [CLI, SESSION, '--once', '--exit-on-event', '--guard-log', join(home, 'none')], { encoding: 'utf8', env });
  assert.equal(run.stdout, 'eeeeeeee: OWNER hello\n');
  assert.match(run.stderr, /WATCH_NOTE eeeeeeee/);
});

test('an unknown class exits 2 and the message lists every valid name', () => {
  const run = spawnSync(process.execPath, [CLI, SESSION, '--exit-on-event', 'bogus'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  for (const name of EXIT_CLASS_NAMES) assert.ok(run.stderr.includes(name), name);
});
