// Tests for home/tools/disk-free/lib/job-made.mjs, the job-made record the job-leftover sweep reads: round trip and modes, hostile
// keys kept as one JSON string, a torn line, two writers at once (two sessions and one session), an old reader meeting newer lines,
// a stale record, the shared byte cap (full said once, nothing cut), gone events, and a planted link at the store.
// Every test runs under its own temp HOME (P8); no line asserts elapsed time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  jobMadeFolder, MAX_RECORD_FILE_BYTES, readJobMade, recordJobMade, STALE_AFTER_MS, stillMade,
} from '../home/tools/disk-free/lib/job-made.mjs';
import { posix } from './disk-clean-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const SESSION = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';
const BY = 'git-tidy lane claim';
const LIB = new URL('../home/tools/disk-free/lib/job-made.mjs', import.meta.url).href;
const WRITES_PER_PROCESS = 200;

const homeEnv = () => {
  const home = makeTempDir('job-made-');
  return { home, env: { HOME: home } };
};
const recordPath = (env, session = SESSION) => join(jobMadeFolder(env), `${session}.jsonl`);
const lines = (env, session = SESSION) => readFileSync(recordPath(env, session), 'utf8').split('\n').filter(Boolean);
const sessionOf = (env, session) => readJobMade(env).sessions.find((one) => one.session === session);

/** Writes a record file by hand (folder 0700, file 0600), as an older or newer writer, or a crash, would have left it. */
function writeRecordFile(env, session, text) {
  mkdirSync(jobMadeFolder(env), { recursive: true, mode: 0o700 });
  writeFileSync(recordPath(env, session), text, { mode: 0o600 });
}

test('a record reads back as written; the folder is 0700, the file 0600, one line per event', posix, () => {
  const { env } = homeEnv();
  assert.equal(recordJobMade(env, SESSION, { kind: 'lane-folder', key: '/repo/.claude/worktrees/lane-1', by: BY }, { now: 1000 }), 'recorded');
  assert.equal(recordJobMade(env, SESSION, { kind: 'container', key: 'cs-test-db', by: 'probe' }, { now: 2000 }), 'recorded');
  assert.equal(lstatSync(jobMadeFolder(env)).mode & 0o777, 0o700);
  assert.equal(lstatSync(recordPath(env)).mode & 0o777, 0o600);
  assert.equal(lines(env).length, 2);
  const read = readJobMade(env, { now: 3000 });
  assert.equal(read.usable, true);
  assert.deepEqual(read.sessions[0], {
    session: SESSION, usable: true, skipped: 0, full: false, lastAt: 2000, stale: false,
    events: [
      { op: 'made', at: 1000, kind: 'lane-folder', key: '/repo/.claude/worktrees/lane-1', by: BY },
      { op: 'made', at: 2000, kind: 'container', key: 'cs-test-db', by: 'probe' },
    ],
  });
});

test('a missing store reads as usable and empty, and reading creates nothing', () => {
  const { env } = homeEnv();
  assert.deepEqual(readJobMade(env), { usable: true, sessions: [] });
  assert.throws(() => lstatSync(jobMadeFolder(env)), { code: 'ENOENT' });
});

test('hostile keys stay one JSON string each: a newline, ../ and spaces round-trip exactly (F2)', () => {
  const { env } = homeEnv();
  const keys = [
    ['download', '/tmp/cs-test-x/evil\nname.zip'],
    ['artefacts', '/tmp/cs-test-x/../../etc'],
    ['volume', 'cs-test vol; rm -rf ~'],
    ['image', 'cs-test/img:"quoted"\u0000tag'],
  ];
  for (const [kind, key] of keys) assert.equal(recordJobMade(env, SESSION, { kind, key, by: BY }), 'recorded');
  assert.equal(lines(env).length, keys.length, 'a newline in a key never starts a second line');
  assert.deepEqual(sessionOf(env, SESSION).events.map(({ kind, key }) => [kind, key]), keys);
});

test('bad entries and session ids are refused and write nothing', () => {
  const { env } = homeEnv();
  const refused = [
    [SESSION, { kind: 'log', key: 'relative/path.log', by: BY }],
    [SESSION, { kind: 'log', key: '../up.log', by: BY }],
    [SESSION, { kind: 'vm', key: 'x', by: BY }],
    [SESSION, { kind: 'container', key: '', by: BY }],
    [SESSION, { kind: 'container', key: 'x', by: '' }],
    [SESSION, { kind: 'container', key: 'x', by: BY, op: 'moved' }],
    [SESSION, { kind: 'container', key: 'x'.repeat(5000), by: BY }],
    [SESSION, null],
    ['../escape', { kind: 'container', key: 'x', by: BY }],
    ['', { kind: 'container', key: 'x', by: BY }],
  ];
  for (const [session, entry] of refused) assert.equal(recordJobMade(env, session, entry), 'refused', JSON.stringify(entry));
  assert.deepEqual(readJobMade(env), { usable: true, sessions: [] });
});

test('a torn last line (a writer killed mid-append) is skipped; the next record starts on its own line', () => {
  const { env } = homeEnv();
  const whole = JSON.stringify({ v: 1, op: 'made', at: 1000, kind: 'log', key: '/tmp/cs-test-a.log', by: BY });
  writeRecordFile(env, SESSION, `${whole}\n{"v":1,"op":"made","at":2000,"kind":"lo`);
  assert.equal(recordJobMade(env, SESSION, { kind: 'screenshot', key: '/tmp/cs-test-b.png', by: BY }, { now: 3000 }), 'recorded');
  const record = sessionOf(env, SESSION);
  assert.equal(record.skipped, 1);
  assert.deepEqual(record.events.map((event) => event.key), ['/tmp/cs-test-a.log', '/tmp/cs-test-b.png']);
  assert.equal(lines(env).at(-1), JSON.stringify({ v: 1, op: 'made', at: 3000, kind: 'screenshot', key: '/tmp/cs-test-b.png', by: BY }));
});

/** Runs one child process that records WRITES_PER_PROCESS containers for session and exits 0 only when every call said 'recorded'. */
function writerProcess(env, session, tag) {
  const script = `import { recordJobMade } from ${JSON.stringify(LIB)};
    let failed = 0;
    for (let i = 0; i < ${WRITES_PER_PROCESS}; i += 1) {
      if (recordJobMade(process.env, process.argv[1], { kind: 'container', key: process.argv[2] + i, by: 'writer' }) !== 'recorded') failed += 1;
    }
    process.exit(failed === 0 ? 0 : 1);`;
  return new Promise((done) => {
    spawn(process.execPath, ['--input-type=module', '-e', script, session, tag], { env: { ...process.env, ...env }, stdio: 'ignore' }).on('exit', done);
  });
}

test('two writers at once: two sessions write two files, two writers of one session take turns; no line lost or torn (F1)', async () => {
  const { env } = homeEnv();
  const exits = await Promise.all([writerProcess(env, SESSION, 'p'), writerProcess(env, SESSION, 'q'), writerProcess(env, OTHER, 'r')]);
  assert.deepEqual(exits, [0, 0, 0]);
  const one = sessionOf(env, SESSION);
  const other = sessionOf(env, OTHER);
  assert.equal(one.skipped, 0);
  assert.equal(one.events.length, 2 * WRITES_PER_PROCESS);
  assert.equal(new Set(one.events.map((event) => event.key)).size, 2 * WRITES_PER_PROCESS);
  assert.equal(other.skipped, 0);
  assert.equal(other.events.length, WRITES_PER_PROCESS);
});

test('an old reader skips and counts lines of a newer writer (version, kind, op) and drops extra fields', () => {
  const { env } = homeEnv();
  const known = { v: 1, op: 'made', at: 1000, kind: 'image', key: 'cs-test/img:1', by: BY, extra: 'ignored', run: { id: 7 } };
  const newer = [
    { v: 2, op: 'made', at: 1100, kind: 'image', key: 'cs-test/img:2', by: BY },
    { v: 1, op: 'made', at: 1200, kind: 'network', key: 'cs-test-net', by: BY },
    { v: 1, op: 'moved', at: 1300, kind: 'image', key: 'cs-test/img:1', by: BY },
    { v: 1, op: 'made', at: '1400', kind: 'image', key: 'cs-test/img:3', by: BY },
    ['not', 'an', 'object'],
  ];
  writeRecordFile(env, SESSION, [known, ...newer].map((line) => `${JSON.stringify(line)}\n`).join(''));
  const record = sessionOf(env, SESSION);
  assert.equal(record.skipped, newer.length);
  assert.deepEqual(record.events, [{ op: 'made', at: 1000, kind: 'image', key: 'cs-test/img:1', by: BY }]);
  assert.deepEqual(stillMade([record]).map((item) => item.key), ['cs-test/img:1']);
});

test('a stale record (newest line over 30 days old) reads as stale; the writer never trims or deletes it (F3)', () => {
  const { env } = homeEnv();
  const now = 100 * STALE_AFTER_MS;
  assert.equal(recordJobMade(env, OTHER, { kind: 'volume', key: 'cs-test-old', by: BY }, { now: now - STALE_AFTER_MS - 1 }), 'recorded');
  const before = readFileSync(recordPath(env, OTHER));
  assert.equal(recordJobMade(env, SESSION, { kind: 'volume', key: 'cs-test-new', by: BY }, { now }), 'recorded');
  const read = readJobMade(env, { now });
  assert.deepEqual(read.sessions.map(({ session, stale }) => [session, stale]), [[SESSION, false], [OTHER, true]]);
  assert.deepEqual(readFileSync(recordPath(env, OTHER)), before);
  assert.deepEqual(stillMade(read.sessions.filter((one) => !one.stale)).map((item) => item.key), ['cs-test-new']);
});

test('the byte cap is shared: the first record that does not fit writes the full line once; nothing is cut (P6)', () => {
  const { env } = homeEnv();
  const filler = JSON.stringify({ v: 1, op: 'made', at: 1, kind: 'log', key: `/tmp/${'a'.repeat(900)}`, by: BY });
  const count = Math.floor((MAX_RECORD_FILE_BYTES - 400) / (filler.length + 1));
  const text = `${filler}\n`.repeat(count);
  writeRecordFile(env, SESSION, text);
  const big = { kind: 'log', key: `/tmp/${'b'.repeat(1000)}`, by: BY };
  let results = [];
  for (let i = 0; i < 3; i += 1) results.push(recordJobMade(env, SESSION, big, { now: 5000 + i }));
  results = results.filter((result) => result !== 'recorded');
  assert.deepEqual(results.slice(0, 2), ['filled', 'full']);
  assert.ok(statSync(recordPath(env)).size <= MAX_RECORD_FILE_BYTES);
  assert.ok(readFileSync(recordPath(env), 'utf8').startsWith(text), 'earlier lines are never rewritten');
  assert.equal(lines(env).filter((line) => line.includes('"op":"full"')).length, 1);
  assert.equal(recordJobMade(env, SESSION, { kind: 'container', key: 'c', by: BY }), 'full', 'a small record after the full line is refused too');
  const record = sessionOf(env, SESSION);
  assert.equal(record.full, true);
  assert.equal(record.skipped, 0);
});

test('stillMade: the newest event per kind and key wins across sessions; a made and a gone at the same ms count as gone', () => {
  const { env } = homeEnv();
  const lane = { kind: 'lane-folder', key: '/repo/.claude/worktrees/lane-2', by: BY };
  recordJobMade(env, SESSION, lane, { now: 1000 });
  recordJobMade(env, OTHER, { ...lane, op: 'gone', by: 'git-tidy lane reclaim' }, { now: 2000 });
  recordJobMade(env, OTHER, { kind: 'container', key: 'cs-test-a', by: BY }, { now: 3000 });
  recordJobMade(env, SESSION, { kind: 'container', key: 'cs-test-a', by: BY, op: 'gone' }, { now: 3000 });
  recordJobMade(env, SESSION, { kind: 'volume', key: 'cs-test-v', by: BY }, { now: 4000 });
  recordJobMade(env, OTHER, { kind: 'artefacts', key: '/tmp/cs-test-ui', by: 'ui-check' }, { now: 5000 });
  assert.deepEqual(stillMade(readJobMade(env).sessions), [
    { kind: 'artefacts', key: '/tmp/cs-test-ui', by: 'ui-check', at: 5000, session: OTHER },
    { kind: 'volume', key: 'cs-test-v', by: BY, at: 4000, session: SESSION },
  ]);
});

test('a planted link at the folder or at a session file: nothing written through it, the reader trusts no record', posix, () => {
  const { home, env } = homeEnv();
  const elsewhere = makeTempDir('job-made-target-');
  mkdirSync(join(home, '.claude', 'state'), { recursive: true });
  symlinkSync(elsewhere, jobMadeFolder(env));
  assert.equal(recordJobMade(env, SESSION, { kind: 'container', key: 'x', by: BY }), 'unwritable');
  assert.equal(readJobMade(env).usable, false);

  const second = homeEnv();
  const target = join(elsewhere, 'target.txt');
  writeFileSync(target, 'keep');
  mkdirSync(jobMadeFolder(second.env), { recursive: true, mode: 0o700 });
  symlinkSync(target, recordPath(second.env));
  assert.equal(recordJobMade(second.env, SESSION, { kind: 'container', key: 'x', by: BY }), 'unwritable');
  assert.equal(readFileSync(target, 'utf8'), 'keep');
  assert.deepEqual(readJobMade(second.env).sessions.map(({ usable }) => usable), [false]);
});
