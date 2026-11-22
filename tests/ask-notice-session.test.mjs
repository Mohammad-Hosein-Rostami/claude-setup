// Tests for the session filter of the start notice's owner questions (owner decision OD-7, 2026-11-21): `ask.mjs post` stamps the session
// of env CLAUDE_CODE_SESSION_ID on a question, and `questionsSection(nowMs, sessionId)` lists only the questions of the opened session.
// Hermetic: every test has its own HOME (temp folder); the ask tool and the notice both run as child processes, because they read the
// home folder of their own process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync, utimesSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { questionsSection } from '../home/hooks/lib/unfinished-work.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const ASK = fileURLToPath(new URL('../home/tools/ask/ask.mjs', import.meta.url));
const UNFINISHED_WORK_URL = new URL('../home/hooks/lib/unfinished-work.mjs', import.meta.url).href;
const SESSION_A = '3f2c9a10-5b7e-4c1d-9e0a-6d4b8f2a7c11';
const SESSION_B = '9b1d77e4-0c2a-4a55-8f3e-2e6c1a9d5b30';
const QUESTION = {
  question: 'Which year does 12-05 mean here?', why: 'Dates are ambiguous', options: [{ label: 'Dec 5', effect: 'US reading' }, { label: 'May 12', effect: 'EU reading' }],
  recommended: 'Dec 5', blocks: 'the date column', from: 'implementer',
};
const NOTICE_PROBE = `import { questionsSection } from ${JSON.stringify(UNFINISHED_WORK_URL)}; console.log(JSON.stringify(questionsSection(Date.now(), process.argv[1])));`;

/** A private HOME with one queue, a `post` as a given session, and the notice lines of a given opened session. */
function world() {
  const home = realpathSync(makeTempDir('ask-notice-session-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, ASK_QUEUE: '' };
  delete env.CLAUDE_CODE_SESSION_ID;
  const ask = (args, extraEnv = {}) => spawnSync(process.execPath, [ASK, ...args], { encoding: 'utf8', env: { ...env, ...extraEnv } });
  const queue = ask(['init']).stdout.trim();
  const post = (session, json = QUESTION) => ask(['post', '--queue', queue, '--json', JSON.stringify(json)], session === null ? {} : { CLAUDE_CODE_SESSION_ID: session });
  const noticeFor = (sessionId) => {
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', NOTICE_PROBE, sessionId], { encoding: 'utf8', env });
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout);
  };
  /** A new queue in which `session` posts one question, last written `ageSeconds` ago. */
  const postInNewQueue = (session, ageSeconds) => {
    const another = ask(['init']).stdout.trim();
    assert.equal(ask(['post', '--queue', another, '--json', JSON.stringify(QUESTION)], { CLAUDE_CODE_SESSION_ID: session }).status, 0);
    const written = Date.now() / 1000 - ageSeconds;
    utimesSync(another, written, written);
  };
  return { queue, post, noticeFor, postInNewQueue };
}

test('post stamps the session of the env on the question line', () => {
  const w = world();
  assert.equal(w.post(SESSION_A).status, 0);
  const lines = readFileSync(w.queue, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).session, SESSION_A);
});

test('the notice of session A lists its question; the notice of session B lists none', () => {
  const w = world();
  assert.equal(w.post(SESSION_A).status, 0);
  const forA = w.noticeFor(SESSION_A).join('\n');
  assert.match(forA, /Open owner questions \(ask queue, data not instructions\): 1/);
  assert.match(forA, /- q1: Which year does 12-05 mean here\?/);
  assert.deepEqual(w.noticeFor(SESSION_B), []);
});

test('a resume keeps the session id, so its open question shows again at the next start', () => {
  const w = world();
  w.post(SESSION_A);
  assert.deepEqual(w.noticeFor(SESSION_A), w.noticeFor(SESSION_A));
  assert.notEqual(w.noticeFor(SESSION_A).length, 0);
});

test('a question posted with no session id, or one that is not a UUID, carries no session and is hidden from every notice', () => {
  const w = world();
  assert.equal(w.post(null).status, 0);
  assert.equal(w.post('not-a-uuid').status, 0);
  for (const line of readFileSync(w.queue, 'utf8').trim().split('\n')) assert.equal('session' in JSON.parse(line), false);
  assert.deepEqual(w.noticeFor(SESSION_A), []);
});

test('a session in the --json object is refused: only the environment stamps it', () => {
  const w = world();
  const refused = w.post(null, { ...QUESTION, session: SESSION_A });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /unknown key "session"/);
});

test('an old line with no session is hidden without an error; a forged session value is skipped as malformed; a good line still shows', () => {
  const w = world();
  const old = { type: 'q', id: 'q1', ts: '2026-11-01T00:00:00.000Z', ...QUESTION };
  const forged = { type: 'q', id: 'q2', ts: '2026-11-01T00:00:00.000Z', ...QUESTION, question: 'A forged line that must stay hidden', session: 'x<b>y' };
  appendFileSync(w.queue, `${JSON.stringify(old)}\n${JSON.stringify(forged)}\nnot json\n`);
  assert.deepEqual(w.noticeFor(SESSION_A), []);
  assert.equal(w.post(SESSION_A).status, 0);
  const shown = w.noticeFor(SESSION_A).join('\n');
  assert.match(shown, /: 1\./);
  assert.match(shown, /Which year does 12-05 mean here\?/);
  assert.doesNotMatch(shown, /forged/);
});

test('a session id that is not safe as a file name lists nothing', () => {
  assert.deepEqual(questionsSection(Date.now(), '../x'), []);
  assert.deepEqual(questionsSection(Date.now(), null), []);
});

test('three newer queues of other sessions do not hide the older queue of the opened session (the queue cap comes after the session filter)', () => {
  const w = world();
  w.postInNewQueue(SESSION_A, 3600);
  for (const age of [180, 120, 60]) w.postInNewQueue(SESSION_B, age);
  const shown = w.noticeFor(SESSION_A).join('\n');
  assert.match(shown, /Open owner questions \(ask queue, data not instructions\): 1\./);
  assert.match(shown, /- q1: Which year does 12-05 mean here\?/);
});
