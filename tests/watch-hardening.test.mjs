// Tests for the watcher's failure handling and edge cases: alerts by entry type, a throwing line, secret masking, unreadable
// or replaced files, array-content prompts, duplicate session ids, and the subagent scan cost. Synthetic data only; the token
// shapes are assembled at run time so no literal secret sits in the repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, chmod, mkdir, rename, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionFor } from '../home/tools/watch/lib/actions.mjs';
import { createClassifier } from '../home/tools/watch/lib/classify.mjs';
import { maskText } from '../home/tools/watch/lib/mask.mjs';
import { resolveTarget } from '../home/tools/watch/lib/resolve.mjs';
import { createSubagentWatcher } from '../home/tools/watch/lib/subagents.mjs';
import { createTail } from '../home/tools/watch/lib/tail.mjs';
import { createSessionWatcher } from '../home/tools/watch/lib/watcher.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const CLI = fileURLToPath(new URL('../home/tools/watch/watch.mjs', import.meta.url));
const SESSION = 'abababab-1111-2222-3333-444444444444';
const STAMP = '2026-11-14T10:00:00.000Z';
const MIN = 60_000;
const json = (value) => `${JSON.stringify({ timestamp: STAMP, ...value })}\n`;
const feed = (entry) => createClassifier().feed(JSON.stringify({ timestamp: STAMP, ...entry }));
const canRead000 = process.platform !== 'win32' && process.getuid?.() !== 0;

async function scratch(t) {
  const dir = makeTempDir('watch-hard-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function sessionHarness(t, extra = {}) {
  const dir = await scratch(t);
  const path = join(dir, `${SESSION}.jsonl`);
  await writeFile(path, '');
  const out = { emitted: [], records: [], clock: { now: Date.parse(STAMP) } };
  out.watcher = createSessionWatcher({
    path, label: 'abababab', sessionId: SESSION, once: false, stallMs: 99 * MIN, sessionsDir: join(dir, 'sessions'),
    now: () => out.clock.now, emit: (text) => out.emitted.push(text), record: (label, text) => out.records.push(`${label} ${text}`), ...extra,
  });
  return { dir, path, ...out };
}

// 1. alerts are decided by the entry type first
test('a compaction-summary, meta or sidechain entry is never an alert, whatever words its text has', () => {
  for (const flag of ['isCompactSummary', 'isMeta', 'isSidechain']) {
    const [event] = feed({ type: 'user', [flag]: true, message: { content: 'earlier we saw an ERROR and a RATE limit and the usage limit' } });
    assert.equal(actionFor(event), undefined, flag);
  }
});

test('an owner prompt that quotes an error word is an OWNER line; a meta Stop hook feedback is STOP_HOOK', () => {
  const [prompt] = feed({ type: 'user', message: { content: 'why does the ERROR page show' } });
  assert.deepEqual(actionFor(prompt), { cls: 'OWNER', text: 'OWNER why does the ERROR page show' });
  const [hook] = feed({ type: 'user', isMeta: true, message: { content: 'Stop hook feedback: keep going' } });
  assert.equal(actionFor(hook).cls, 'STOP_HOOK');
});

// 2. a malformed line or poll never kills the watcher
test('a classifier that throws on one line yields one WATCH_ERROR, rate-limited, and later lines still print', async (t) => {
  const real = createClassifier();
  const classifier = { feed: (text) => { if (text.includes('BOOM')) throw new Error('bad field'); return real.feed(text); } };
  const { path, emitted, clock, watcher } = await sessionHarness(t, { classifier });
  await watcher.poll();
  await appendFile(path, 'BOOM\nBOOM\n');
  await watcher.poll();
  assert.deepEqual(emitted, ['WATCH_ERROR abababab bad field']);
  await appendFile(path, 'BOOM\n');
  clock.now += 2 * MIN;
  await watcher.poll();
  assert.equal(emitted.length, 2, 'the same reason prints again after a minute');
  await appendFile(path, json({ type: 'user', message: { content: 'still alive' } }));
  await watcher.poll();
  assert.equal(emitted.at(-1), 'abababab: OWNER still alive');
});

test('an old transcript\'s Workflow tool_use, odd input included, is a plain TOOL event', () => {
  for (const input of [{ script: 5 }, { script: 'agent(a)', scriptPath: 'w.js' }, null, undefined]) {
    const events = feed({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Workflow', input }] } });
    assert.deepEqual(events.map((event) => event.line), [`${STAMP} TOOL Workflow`], JSON.stringify(input));
  }
});

test('a fatal error prints WATCH_ERROR on stdout and exits non-zero', async (t) => {
  const dir = await scratch(t);
  const blocker = join(dir, 'file-not-dir');
  await writeFile(blocker, '');
  const transcript = join(dir, `${SESSION}.jsonl`);
  await writeFile(transcript, '');
  const run = spawnSync(process.execPath, [CLI, transcript, '--once', '--log', join(blocker, 'sub')], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /^WATCH_ERROR - fatal: /m);
});

// 3. nothing secret-shaped leaves, on stdout or in the log
const SECRETS = () => [`ghp_${'aB3dE6gH9j'.repeat(4)}`, `sk-ant-${'x9Y8z7W6v5'.repeat(4)}`, 'a1b2c3d4'.repeat(6), `token=${'q'.repeat(20)}`];

test('maskText hides tokens, long hex, base64-like runs and key=value secrets but keeps paths', () => {
  for (const secret of SECRETS()) assert.ok(!maskText(`value ${secret} end`).includes(secret.replace('token=', '')), secret);
  const mixed = 'Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE1O';
  assert.ok(!maskText(`blob ${mixed}`).includes(mixed));
  const path = '/Users/someone/Desktop/claude-setup-wt/l3/home/tools/watch/lib/mask.mjs';
  assert.equal(maskText(path), path);
});

test('secrets in a tool error, a prompt and an agent description are masked on stdout and in the log', async (t) => {
  const { path, emitted, records, watcher } = await sessionHarness(t);
  await watcher.poll();
  const [bearer, anthropic, hex] = SECRETS();
  await appendFile(path,
    json({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: `ERROR auth failed Bearer ${bearer} and ${anthropic}` }] } })
    + json({ type: 'user', message: { content: `please use ${hex} now` } })
    + json({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { description: `deploy with ${bearer}` } }] } }));
  await watcher.poll();
  const everything = [...emitted, ...records].join('\n');
  for (const secret of [bearer, anthropic, hex]) assert.ok(!everything.includes(secret), 'a secret leaked');
  assert.match(everything, /\[masked\]/);
  assert.equal(emitted.length, 2);
});

// 4. unreadable or vanished files
test('a missing transcript in --once prints one WATCH_ERROR and exits 1', async (t) => {
  const dir = await scratch(t);
  const run = spawnSync(process.execPath, [CLI, join(dir, `${SESSION}.jsonl`), '--once', '--guard-log', join(dir, 'none')], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.deepEqual(run.stdout.trim().split('\n'), [`WATCH_ERROR abababab cannot read ${SESSION}.jsonl (ENOENT)`]);
});

test('an unreadable transcript is reported once per failure and reading resumes when it is fixed', { skip: !canRead000 }, async (t) => {
  const { path, emitted, watcher } = await sessionHarness(t);
  await watcher.poll();
  await chmod(path, 0o000);
  await watcher.poll();
  await watcher.poll();
  assert.deepEqual(emitted, [`WATCH_ERROR abababab cannot read ${SESSION}.jsonl (EACCES)`]);
  assert.equal(watcher.failed, true);
  await chmod(path, 0o600);
  await appendFile(path, json({ type: 'user', message: { content: 'back again' } }));
  await watcher.poll();
  assert.equal(emitted.at(-1), 'abababab: OWNER back again');
});

test('a transcript that vanishes in follow mode is reported once', async (t) => {
  const { path, emitted, watcher } = await sessionHarness(t);
  await watcher.poll();
  await unlink(path);
  await watcher.poll();
  await watcher.poll();
  assert.deepEqual(emitted, [`WATCH_ERROR abababab cannot read ${SESSION}.jsonl (ENOENT)`]);
});

// 5. array-content prompts
test('a prompt with text and an image is an owner prompt with an image note; tool results are not prompts', () => {
  const [event] = feed({ type: 'user', message: { content: [{ type: 'text', text: '<ide_opened_file>x</ide_opened_file>' }, { type: 'text', text: 'look at this' }, { type: 'image', source: {} }] } });
  assert.equal(event.promptText, 'look at this [+1 images]');
  assert.deepEqual(actionFor(event), { cls: 'OWNER', text: 'OWNER look at this [+1 images]' });
  const [imageOnly] = feed({ type: 'user', message: { content: [{ type: 'image' }, { type: 'image' }] } });
  assert.equal(imageOnly.promptText, '[+2 images]');
  const mixed = feed({ type: 'user', message: { content: [{ type: 'text', text: 'looks like a prompt' }, { type: 'tool_result', content: 'ok' }] } });
  assert.deepEqual(mixed, []);
  assert.deepEqual(feed({ type: 'user', message: { content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }] } }), []);
});

// 6. one session id in two project folders
test('an id found in two project folders resolves to the most recently written, with a WATCH_NOTE naming both', async (t) => {
  const dir = await scratch(t);
  for (const project of ['-proj-a', '-proj-b']) {
    await mkdir(join(dir, project));
    await writeFile(join(dir, project, `${SESSION}.jsonl`), '');
  }
  const stamp = (project, seconds) => utimes(join(dir, project, `${SESSION}.jsonl`), seconds, seconds);
  await stamp('-proj-a', 1000);
  await stamp('-proj-b', 2000);
  const target = await resolveTarget(SESSION, dir);
  assert.equal(target.path, join(dir, '-proj-b', `${SESSION}.jsonl`));
  assert.match(target.note, /^WATCH_NOTE abababab .*-proj-a.*-proj-b|WATCH_NOTE abababab .*-proj-b.*-proj-a/);
  await stamp('-proj-a', 3000);
  assert.equal((await resolveTarget(SESSION, dir)).path, join(dir, '-proj-a', `${SESSION}.jsonl`));
  const single = await resolveTarget(SESSION, join(dir, 'nowhere')).catch((error) => error);
  assert.match(single.message, new RegExp(SESSION));
});

// 7. the subagent scan stays cheap
test('dormant subagent files are not stat-ed on every poll', async (t) => {
  const dir = await scratch(t);
  const files = 30;
  const polls = 200;
  for (let n = 0; n < files; n += 1) await writeFile(join(dir, `agent-${n}.jsonl`), `${JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5-5' } })}\n`);
  let stats = 0;
  const { stat } = await import('node:fs/promises');
  const watcher = createSubagentWatcher(dir, { judgeExisting: true, io: { stat: (path) => { stats += 1; return stat(path); } } });
  for (let n = 0; n < polls; n += 1) await watcher.poll();
  assert.ok(stats < files * polls * 0.4, `${stats} stat calls for ${files} files over ${polls} polls`);
});

test('a subagent whose first answer arrives later is judged once; one with no model in its head is cached as unknown', async (t) => {
  const dir = await scratch(t);
  let opens = 0;
  const { open } = await import('node:fs/promises');
  const watcher = createSubagentWatcher(dir, { judgeExisting: true, io: { open: (...args) => { opens += 1; return open(...args); } } });
  await watcher.poll();
  await writeFile(join(dir, 'agent-late.jsonl'), '');
  await writeFile(join(dir, 'agent-late.meta.json'), JSON.stringify({ agentType: 'scout', model: 'sonnet' }));
  assert.deepEqual((await watcher.poll()).agents, []);
  await appendFile(join(dir, 'agent-late.jsonl'), `${JSON.stringify({ message: { model: 'claude-haiku-5-5' } })}\n`);
  const judged = (await watcher.poll()).agents;
  assert.equal(judged.length, 1);
  assert.equal(judged[0].mismatch, true);
  assert.deepEqual((await watcher.poll()).agents, []);
  const filler = `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(300 * 1024) } })}\n`;
  await writeFile(join(dir, 'agent-big.jsonl'), filler);
  assert.deepEqual((await watcher.poll()).agents, []);
  await appendFile(join(dir, 'agent-big.jsonl'), `${JSON.stringify({ message: { model: 'claude-opus-5-5' } })}\n`);
  assert.deepEqual((await watcher.poll()).agents, [], 'the decision for a file with no model in its head is final');
  const opensBefore = opens;
  for (let n = 0; n < 5; n += 1) {
    await appendFile(join(dir, 'agent-big.jsonl'), `${JSON.stringify({ type: 'user', message: { content: `more ${n}` } })}\n`);
    await watcher.poll();
  }
  assert.equal(opens, opensBefore, 'a file decided as unknown is never re-read when it grows');
});

// 8. a replacement file that is larger than the old one
test('a file replaced by a larger one is re-read from its first byte', async (t) => {
  const dir = await scratch(t);
  const file = join(dir, 't.jsonl');
  await writeFile(file, 'old-1\n');
  const tail = createTail(file, { fromStart: false });
  await tail.poll();
  const replacement = join(dir, 'replacement.jsonl');
  await writeFile(replacement, 'rot-1\nrot-2\nrot-3\n');
  await rename(replacement, file);
  assert.deepEqual((await tail.poll()).lines, ['rot-1', 'rot-2', 'rot-3']);
});

test('unreadable file: the tail reports the code and no mtime', { skip: !canRead000 }, async (t) => {
  const dir = await scratch(t);
  const file = join(dir, 'locked.jsonl');
  await writeFile(file, 'x\n');
  await chmod(file, 0o000);
  const result = await createTail(file, { fromStart: true }).poll();
  assert.equal(result.error, 'EACCES');
  assert.equal(result.mtimeMs, undefined);
});
