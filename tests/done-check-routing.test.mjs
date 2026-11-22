// The model and effort on done-check ledger rows (R16 step 1, lane `routing-ledger`): the ledger stores them as one short token or null,
// old rows without them still read and group as `unknown`, `statsByModel` groups runs by them, `done-check stats` prints the groups,
// and lib/transcript.mjs `lastReplyRouting` reads the model of the stopping agent's newest reply. The hook side (a Stop input to a
// ledger row) is in done-check-hook.test.mjs.
// Invariants: HOME and USERPROFILE are pinned to a temp folder before any lib loads, so the real ~/.claude ledger is never read or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';

const PINNED_HOME = makeTempDir('done-check-routing-home-');
process.env.HOME = PINNED_HOME;
process.env.USERPROFILE = PINNED_HOME;

const CLI = fileURLToPath(new URL('../home/tools/done-check/done-check.mjs', import.meta.url));
const TRANSCRIPT_LIB = new URL('../home/hooks/lib/transcript.mjs', import.meta.url).href;
const KILL_AFTER_MS = 10000; // only so a read that waits on a FIFO ends the test; the assertion reads the answer, never the time
const noFifo = process.platform === 'win32' ? 'Windows has no FIFO and no O_NOFOLLOW' : false;
const { appendRun, readLedger, statsByModel, UNKNOWN } = await import('../home/tools/done-check/lib/ledger.mjs');
const { lastReplyRouting } = await import('../home/hooks/lib/transcript.mjs');
const LEDGER_FILE = join(PINNED_HOME, '.claude', 'state', 'done-check', 'ledger.jsonl');
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';

/** A whole run row of the design; the model and effort fields are added only when an override gives them. */
const runRow = (overrides = {}) => ({
  v: 1, id: 'run-0', at: new Date().toISOString(), where: 'stop', session: 's1', agent: 'a1', repo: 'repo-1', base: 'a'.repeat(40),
  key: 'k'.repeat(64), files: 1, checks: { types: { result: 'ok', new: 0, old: 0, ms: 100 } }, verdict: 'ok', risk: [], ms: 100, ...overrides,
});
const resetLedger = (t) => {
  const clear = () => rmSync(join(PINNED_HOME, '.claude'), { recursive: true, force: true });
  clear();
  t.after(clear);
};

test('a run row with a model and an effort is stored and read back with them; null stays null', (t) => {
  resetLedger(t);
  const known = runRow({ id: 'known', model: OPUS, effort: 'high' });
  const unknown = runRow({ id: 'unknown', model: null, effort: null });
  assert.equal(appendRun(known), true);
  assert.equal(appendRun(unknown), true);
  assert.deepEqual(readLedger({}).runs, [known, unknown]);
});

test('a model or effort that is not one short token is a caller bug (TypeError) and nothing is written', (t) => {
  resetLedger(t);
  assert.throws(() => appendRun(runRow({ model: 'fix the login page please' })), TypeError);
  assert.throws(() => appendRun(runRow({ model: 7 })), TypeError);
  assert.throws(() => appendRun(runRow({ effort: 'HIGH effort' })), TypeError);
  assert.deepEqual(readLedger({}).runs, []);
});

test('an old row without model and effort still reads, and groups as unknown', (t) => {
  resetLedger(t);
  mkdirSync(dirname(LEDGER_FILE), { recursive: true });
  writeFileSync(LEDGER_FILE, `${JSON.stringify(runRow({ id: 'old' }))}\n`);
  const { runs } = readLedger({});
  assert.equal(runs.length, 1);
  assert.deepEqual(statsByModel(runs).map(({ model, effort, runs: count }) => [model, effort, count]), [[UNKNOWN, UNKNOWN, 1]]);
});

test('statsByModel: one group per model and effort, most runs first, with blocks, left-open stops and the median run time', () => {
  const runs = [
    runRow({ id: '1', model: OPUS, effort: 'high', verdict: 'block', ms: 100 }),
    runRow({ id: '2', model: OPUS, effort: 'high', verdict: 'left-open', ms: 300 }),
    runRow({ id: '3', model: OPUS, effort: 'high', verdict: 'ok', ms: 200 }),
    runRow({ id: '4', model: OPUS, effort: 'xhigh', verdict: 'ok', ms: 50 }),
    runRow({ id: '5', model: SONNET, effort: null, verdict: 'block', ms: 10 }),
    runRow({ id: '6', model: '<not a token>', verdict: 'ok', ms: 10 }),
  ];
  assert.deepEqual(statsByModel(runs), [
    { model: OPUS, effort: 'high', runs: 3, blocks: 1, leftOpen: 1, medianMs: 200 },
    { model: OPUS, effort: 'xhigh', runs: 1, blocks: 0, leftOpen: 0, medianMs: 50 },
    { model: SONNET, effort: UNKNOWN, runs: 1, blocks: 1, leftOpen: 0, medianMs: 10 },
    { model: UNKNOWN, effort: UNKNOWN, runs: 1, blocks: 0, leftOpen: 0, medianMs: 10 },
  ]);
  assert.deepEqual(statsByModel([]), []);
});

test('`done-check stats` prints the model and effort groups after the check kinds, and --json gives them as byModel', (t) => {
  resetLedger(t);
  mkdirSync(dirname(LEDGER_FILE), { recursive: true });
  appendFileSync(LEDGER_FILE, `${JSON.stringify(runRow({ id: 'old' }))}\n`);
  appendRun(runRow({ id: 'new', model: OPUS, effort: 'high', verdict: 'block' }));
  const env = { ...process.env, HOME: PINNED_HOME, USERPROFILE: PINNED_HOME };
  const text = spawnSync(process.execPath, [CLI, 'stats', '--days', '1'], { encoding: 'utf8', env });
  assert.equal(text.status, 0, text.stderr);
  const lines = text.stdout.split('\n');
  const header = lines.indexOf('by model and effort:');
  assert.ok(header > lines.findIndex((line) => line.startsWith('types:')), text.stdout);
  assert.match(lines[header + 1], /^claude-opus-5-5 high: 1 runs, 1 blocks, 0 left open, median /);
  assert.match(lines[header + 2], /^unknown unknown: 1 runs, 0 blocks/);
  const json = spawnSync(process.execPath, [CLI, 'stats', '--days', '1', '--json'], { encoding: 'utf8', env });
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).byModel.map(({ model, effort }) => `${model} ${effort}`), ['claude-opus-5-5 high', 'unknown unknown']);
});

/** A transcript file of the given entries, one JSON line each, in a fresh temp folder. */
function transcriptOf(t, entries) {
  const dir = makeTempDir('done-check-routing-transcript-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'transcript.jsonl');
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n'));
  return file;
}
const reply = (model, { sidechain = false, effort } = {}) => ({ type: 'assistant', isSidechain: sidechain, ...(effort ? { effort } : {}), message: { model, role: 'assistant', content: [] } });

test('lastReplyRouting: the newest reply of the asked thread gives the model and effort; a <synthetic> reply is passed over', async (t) => {
  const file = transcriptOf(t, [
    { cwd: '/somewhere' },
    reply(SONNET, { effort: 'medium' }),
    reply(OPUS, { sidechain: true, effort: 'high' }),
    reply('<synthetic>', { sidechain: true }),
    { type: 'user', isSidechain: true, message: { role: 'user', content: 'model "x"' } },
  ]);
  assert.deepEqual(await lastReplyRouting(file, { sidechain: true }), { model: OPUS, effort: 'high' });
  assert.deepEqual(await lastReplyRouting(file, { sidechain: false }), { model: SONNET, effort: 'medium' });
});

test('lastReplyRouting: no reply, a missing file or no path gives {} and never throws', async (t) => {
  assert.deepEqual(await lastReplyRouting(transcriptOf(t, [{ cwd: '/somewhere' }]), { sidechain: false }), {});
  assert.deepEqual(await lastReplyRouting(join(PINNED_HOME, 'no-such.jsonl'), { sidechain: false }), {});
  assert.deepEqual(await lastReplyRouting(undefined, { sidechain: true }), {});
});

test('every transcript read answers at once for a FIFO or a link at the path: {} or undefined, no wait (a Stop hook must not hang)', { skip: noFifo }, (t) => {
  const dir = makeTempDir('done-check-routing-odd-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fifo = join(dir, 'fifo.jsonl');
  execFileSync('mkfifo', [fifo]);
  const link = join(dir, 'link.jsonl');
  symlinkSync(transcriptOf(t, [reply(OPUS)]), link);
  const script = `
    import { contextTokens, findStatusPath, lastReplyRouting } from ${JSON.stringify(TRANSCRIPT_LIB)};
    const answers = [];
    for (const path of process.argv.slice(1)) {
      answers.push([await lastReplyRouting(path, { sidechain: false }), await contextTokens(path) ?? null, await findStatusPath(path) ?? null]);
    }
    process.stdout.write(JSON.stringify(answers));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script, fifo, link], { encoding: 'utf8', timeout: KILL_AFTER_MS });
  assert.equal(run.signal, null, 'a transcript read waited on the FIFO');
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), [[{}, null, null], [{}, null, null]]);
  assert.equal(run.stderr, '');
});
