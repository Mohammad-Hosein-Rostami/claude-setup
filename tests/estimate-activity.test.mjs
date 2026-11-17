// Tests for home/tools/estimate/lib/activity.mjs: which transcript files belong to a session, the byte scan for `"timestamp":"`,
// and the per-session index (only appended bytes are read; minutes outlive the transcripts). All transcripts are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { activeRuns, sessionTranscripts } from '../home/tools/estimate/lib/activity.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const ACTIVITY_URL = new URL('../home/tools/estimate/lib/activity.mjs', import.meta.url).href;
const HANG_LIMIT_MS = 10_000; // a scan of these small fixtures takes milliseconds; a loop that never ends is killed here
const SESSION = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-2222-3333-4444-555555555555';
const minuteOf = (iso) => Date.parse(iso) / 60_000;
const line = (iso, text = 'hi') => `${JSON.stringify({ type: 'assistant', message: { content: text }, timestamp: iso })}\n`;

function fixture() {
  const root = makeTempDir('est-activity-');
  const projects = join(root, 'projects');
  const folder = join(projects, '-Users-me-project');
  mkdirSync(join(folder, SESSION, 'subagents'), { recursive: true });
  mkdirSync(join(folder, SESSION, 'workflows', 'w1', 'deep'), { recursive: true });
  return { root, projects, folder, state: join(root, 'state') };
}

test('sessionTranscripts finds the main file and every .jsonl nested under the session folder, nothing else', (t) => {
  const { root, projects, folder } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(folder, `${SESSION}.jsonl`), line('2026-11-16T10:00:00.000Z'));
  writeFileSync(join(folder, SESSION, 'subagents', 'agent-a.jsonl'), line('2026-11-16T10:05:00.000Z'));
  writeFileSync(join(folder, SESSION, 'subagents', 'agent-a.meta.json'), '{}');
  writeFileSync(join(folder, SESSION, 'workflows', 'w1', 'deep', 'run.jsonl'), line('2026-11-16T10:06:00.000Z'));
  writeFileSync(join(folder, `${OTHER}.jsonl`), line('2026-11-16T12:00:00.000Z'));
  const found = sessionTranscripts(projects, SESSION).map((path) => path.slice(folder.length + 1));
  assert.deepEqual(found, [`${SESSION}.jsonl`, join(SESSION, 'subagents', 'agent-a.jsonl'), join(SESSION, 'workflows', 'w1', 'deep', 'run.jsonl')]);
});

test('sessionTranscripts returns nothing for a missing projects folder or an unsafe session id', (t) => {
  const { root, projects } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(sessionTranscripts(join(root, 'nowhere'), SESSION), []);
  assert.deepEqual(sessionTranscripts(projects, '../etc'), []);
});

test('activeRuns turns the minutes of the main and nested files into merged runs', (t) => {
  const { root, projects, folder, state } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(folder, `${SESSION}.jsonl`), line('2026-11-16T10:00:12.000Z') + line('2026-11-16T10:01:59.000Z') + line('2026-11-16T10:30:00.000Z'));
  writeFileSync(join(folder, SESSION, 'subagents', 'agent-a.jsonl'), line('2026-11-16T10:02:00.000Z'));
  const runs = activeRuns([SESSION], { projectsDir: projects, stateDir: state });
  assert.deepEqual(runs, [[minuteOf('2026-11-16T10:00Z'), minuteOf('2026-11-16T10:03Z')], [minuteOf('2026-11-16T10:30Z'), minuteOf('2026-11-16T10:31Z')]]);
});

test('activeRuns does not count a timestamp quoted (escaped) inside text', (t) => {
  const { root, projects, folder, state } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const quoted = JSON.stringify({ timestamp: '2026-11-16T11:00:00.000Z' });
  writeFileSync(join(folder, `${SESSION}.jsonl`), line('2026-11-16T10:00:00.000Z', quoted));
  assert.deepEqual(activeRuns([SESSION], { projectsDir: projects, stateDir: state }), [[minuteOf('2026-11-16T10:00Z'), minuteOf('2026-11-16T10:01Z')]]);
});

test('activeRuns reads appended bytes on the next run and sees a match the previous read cut in half', (t) => {
  const { root, projects, folder, state } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(folder, `${SESSION}.jsonl`);
  const second = line('2026-11-16T10:20:00.000Z');
  const cut = second.indexOf('T10:2') + 2; // the first read ends inside the second line's stamp
  writeFileSync(file, line('2026-11-16T10:00:00.000Z') + second.slice(0, cut));
  assert.deepEqual(activeRuns([SESSION], { projectsDir: projects, stateDir: state }), [[minuteOf('2026-11-16T10:00Z'), minuteOf('2026-11-16T10:01Z')]]);
  appendFileSync(file, second.slice(cut) + line('2026-11-16T10:21:00.000Z'));
  const runs = activeRuns([SESSION], { projectsDir: projects, stateDir: state });
  assert.deepEqual(runs, [[minuteOf('2026-11-16T10:00Z'), minuteOf('2026-11-16T10:01Z')], [minuteOf('2026-11-16T10:20Z'), minuteOf('2026-11-16T10:22Z')]]);
});

test('activeRuns finds a match that straddles two read chunks of one scan', (t) => {
  const { root, projects, folder, state } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const chunkBytes = 1 << 20;
  const stamp = line('2026-11-16T10:40:00.000Z');
  const padding = `${'x'.repeat(chunkBytes - stamp.indexOf('"timestamp"') - 20)}\n`; // the match starts 19 bytes before the chunk end
  writeFileSync(join(folder, `${SESSION}.jsonl`), padding + stamp);
  assert.deepEqual(activeRuns([SESSION], { projectsDir: projects, stateDir: state }), [[minuteOf('2026-11-16T10:40Z'), minuteOf('2026-11-16T10:41Z')]]);
});

test('activeRuns keeps the minutes of a transcript that was deleted, and rereads a file that shrank from the start', (t) => {
  const { root, projects, folder, state } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nested = join(folder, SESSION, 'subagents', 'agent-a.jsonl');
  const main = join(folder, `${SESSION}.jsonl`);
  writeFileSync(nested, line('2026-11-16T09:00:00.000Z'));
  writeFileSync(main, line('2026-11-16T10:00:00.000Z') + line('2026-11-16T10:01:00.000Z') + line('2026-11-16T10:02:00.000Z'));
  activeRuns([SESSION], { projectsDir: projects, stateDir: state });
  rmSync(nested);
  writeFileSync(main, line('2026-11-16T12:00:00.000Z'));
  const runs = activeRuns([SESSION], { projectsDir: projects, stateDir: state });
  assert.deepEqual(runs, [
    [minuteOf('2026-11-16T09:00Z'), minuteOf('2026-11-16T09:01Z')],
    [minuteOf('2026-11-16T10:00Z'), minuteOf('2026-11-16T10:03Z')],
    [minuteOf('2026-11-16T12:00Z'), minuteOf('2026-11-16T12:01Z')],
  ]);
});

test('activeRuns merges several sessions and, without a state folder, scans without storing', (t) => {
  const { root, projects, folder, state } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(folder, `${SESSION}.jsonl`), line('2026-11-16T10:00:00.000Z'));
  writeFileSync(join(folder, `${OTHER}.jsonl`), line('2026-11-16T10:01:00.000Z'));
  assert.deepEqual(activeRuns([SESSION, OTHER], { projectsDir: projects, stateDir: null }), [[minuteOf('2026-11-16T10:00Z'), minuteOf('2026-11-16T10:02Z')]]);
  assert.deepEqual(activeRuns([SESSION, OTHER], { projectsDir: projects, stateDir: state }), [[minuteOf('2026-11-16T10:00Z'), minuteOf('2026-11-16T10:02Z')]]);
});

/** Runs an ES module script in a child node killed after HANG_LIMIT_MS, so a scan that never ends fails the test instead of hanging it. */
const runChild = (script) => spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: HANG_LIMIT_MS });

test('activeRuns stops when a transcript shrinks during the scan (a short read) and keeps the minutes it read', (t) => {
  const { root, projects, folder } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(folder, `${SESSION}.jsonl`);
  const chunk = 1 << 20; // the scan's read size: shrinking to just past it makes every later read short
  writeFileSync(main, line('2026-11-16T10:00:00.000Z') + 'x'.repeat(3 * chunk) + '\n');
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const readSync = fs.readSync;
    let shrunk = false; // module loading reads files too: shrink after the scan's first full chunk, nothing earlier
    fs.readSync = (...args) => {
      const length = readSync(...args);
      if (!shrunk && args[3] === ${chunk}) { shrunk = true; fs.truncateSync(${JSON.stringify(main)}, ${chunk + 20}); }
      return length;
    };
    syncBuiltinESMExports();
    const { activeRuns } = await import(${JSON.stringify(ACTIVITY_URL)});
    process.stdout.write(JSON.stringify(activeRuns([${JSON.stringify(SESSION)}], { projectsDir: ${JSON.stringify(projects)} })));`;
  const child = runChild(script);
  assert.equal(child.signal, null, 'the scan must end, not loop on the shrunk file');
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), [[minuteOf('2026-11-16T10:00Z'), minuteOf('2026-11-16T10:01Z')]]);
});

test('sessionTranscripts never follows a folder link: a link out is not read and self-links do not loop', (t) => {
  const { root, projects, folder } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessionFolder = join(folder, SESSION);
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, 'planted.jsonl'), line('2026-11-16T05:00:00.000Z'));
  writeFileSync(join(sessionFolder, 'subagents', 'agent-a.jsonl'), line('2026-11-16T10:05:00.000Z'));
  // 'junction' lets Windows make a folder link without admin rights; other systems ignore the type. Targets are absolute for it.
  symlinkSync(elsewhere, join(sessionFolder, 'subagents', 'linked'), 'junction');
  symlinkSync(sessionFolder, join(sessionFolder, 'a'), 'junction');
  symlinkSync(sessionFolder, join(sessionFolder, 'b'), 'junction');
  const script = `
    import { sessionTranscripts } from ${JSON.stringify(ACTIVITY_URL)};
    process.stdout.write(JSON.stringify(sessionTranscripts(${JSON.stringify(projects)}, ${JSON.stringify(SESSION)})));`;
  const child = runChild(script);
  assert.equal(child.signal, null, 'the walk must end');
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), [join(sessionFolder, 'subagents', 'agent-a.jsonl')]);
});

const INDEX_CAP_BYTES = 16 * (1 << 20); // the index's size cap
const indexFile = (state) => join(state, 'activity', `${SESSION}.json`);

test('an activity index over the cap is kept as it is, named once on stderr, and this run still counts the transcripts', (t) => {
  const { root, projects, folder, state } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(folder, `${SESSION}.jsonl`), line('2026-11-16T10:00:00.000Z'));
  activeRuns([SESSION], { projectsDir: projects, stateDir: state }); // makes the private folder
  const oversized = `${JSON.stringify({ v: 2, files: {}, runs: [[1, 2]] })}${' '.repeat(INDEX_CAP_BYTES)}`;
  writeFileSync(indexFile(state), oversized);
  const stderr = t.mock.method(process.stderr, 'write', () => true);
  assert.deepEqual(activeRuns([SESSION], { projectsDir: projects, stateDir: state }), [[minuteOf('2026-11-16T10:00Z'), minuteOf('2026-11-16T10:01Z')]]);
  assert.ok(readFileSync(indexFile(state), 'utf8') === oversized, 'its stored minutes are not dropped');
  assert.equal(stderr.mock.callCount(), 1);
  assert.match(stderr.mock.calls[0].arguments[0], /^estimate: .*\.json is over 16 MiB; it is kept as it is and not used\n$/);
});

test('an index under the old 1 MiB cap\'s size is still read, and one that would grow over the cap is not written', (t) => {
  const { root, projects, folder, state } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(folder, `${SESSION}.jsonl`);
  writeFileSync(main, line('2026-11-16T10:00:00.000Z'));
  activeRuns([SESSION], { projectsDir: projects, stateDir: state });
  const runText = (k) => `[${31_000_000 + 2 * k},${31_000_001 + 2 * k}]`; // 20 bytes with its comma, after the test minutes (2026)
  const head = '{"v":2,"files":{},"runs":[';
  const count = Math.floor((INDEX_CAP_BYTES - head.length - 2) / (runText(0).length + 1));
  const nearCap = `${head}${Array.from({ length: count }, (_, k) => runText(k)).join(',')}]}`;
  writeFileSync(indexFile(state), nearCap);
  const stderr = t.mock.method(process.stderr, 'write', () => true);
  const runs = activeRuns([SESSION], { projectsDir: projects, stateDir: state });
  assert.equal(runs.length, count + 1, 'the stored runs were read and this run\'s minute added');
  assert.ok(readFileSync(indexFile(state), 'utf8') === nearCap, 'a file the reader would refuse is never written');
  assert.equal(stderr.mock.callCount(), 1);
  assert.match(stderr.mock.calls[0].arguments[0], /would grow over 16 MiB/);
});
