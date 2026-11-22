// Tests for home/hooks/token-audit.mjs: the two start totals with the start hooks' text counted, the --budget form doctor.sh reads,
// and that measuring the hook text writes nothing and prints none of it.
// How: the CLI runs as a child with HOME (and USERPROFILE) set to a cs-test- temp folder holding a lead.md, a lead-rules.md, a
// MEMORY.md (each with a marker that must never reach the output) and a 20-day-old state file that session-notes' prune would
// delete; every file under that HOME is compared before and after, and the audit's temp folder must be empty after it.
// hookTextParts is also run on fake hook scripts (missing, a throw, too slow, 6,000 characters, silent), startLines on a missing
// part, and FIFOs stand at lead.md, CLAUDE.md and a rule file (a plain read of one waits forever).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookTextParts, startLines } from '../home/hooks/token-audit.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
// The audit runs these hooks as child processes, which done-check's import graph cannot see; these imports make it select this test
// when a start hook or what it imports (lib/state-files.mjs, lib/plain-file.mjs) changes. Importing runs no hook: each runs only as a script.
import '../home/hooks/lead-text.mjs';
import '../home/hooks/session-notes.mjs';
import '../home/hooks/recall-digest.mjs';

const AUDIT = fileURLToPath(new URL('../home/hooks/token-audit.mjs', import.meta.url));
const MARKER = 'cs-test-private-hook-text';
const STALE_AGE_MS = 20 * 24 * 60 * 60 * 1000; // older than session-notes' 14-day retention
const HUGE_CHARS = 6000;
const TEST_TIMEOUT_MS = 500; // a fake hook needs about 50 ms to start node
const SLOW_PART_MS = 2000;
const HANG_LIMIT_MS = 20_000; // a run past this hangs: the hook timeout is 5 s
const LEAD_TEXT = fileURLToPath(new URL('../home/hooks/lead-text.mjs', import.meta.url));

/** A temp HOME with the start hooks' files; `withLead` false leaves out lead.md and lead-rules.md. */
function makeHome(withLead = true) {
  const home = makeTempDir('token-audit-home-');
  const claude = join(home, '.claude');
  mkdirSync(join(claude, 'state', 'modes'), { recursive: true });
  mkdirSync(join(claude, 'projects', 'p', 'memory'), { recursive: true });
  if (withLead) {
    writeFileSync(join(claude, 'lead.md'), `# Lead\n<!-- editor note -->\n${MARKER} lead text\n`);
    writeFileSync(join(claude, 'lead-rules.md'), `${MARKER} lead rules\n`);
  }
  writeFileSync(join(claude, 'projects', 'p', 'memory', 'MEMORY.md'), `${MARKER} memory\n`);
  const stale = join(claude, 'state', 'modes', 'old-session.count');
  writeFileSync(stale, '3\n');
  const old = new Date(Date.now() - STALE_AGE_MS);
  utimesSync(stale, old, old);
  return home;
}

/** Every file and folder under `dir` with its size and modification time. */
function snapshot(dir, out = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const { size, mtimeMs } = statSync(path);
    out[path] = `${size}:${mtimeMs}`;
    if (entry.isDirectory()) snapshot(path, out);
  }
  return out;
}

/** Runs the audit with `home` as HOME and `tmp` (a fresh folder unless given) as its temp folder. */
function runAudit(home, args = [], timeout = undefined, tmp = makeTempDir('token-audit-tmp-')) {
  const cwd = makeTempDir('token-audit-cwd-');
  writeFileSync(join(cwd, 'CLAUDE.md'), '# project rules\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  return spawnSync(process.execPath, [AUDIT, ...args], { cwd, env, encoding: 'utf8', timeout, killSignal: 'SIGKILL' });
}

test('the report gives both start totals, counts the hook text, prints none of it and changes no file under HOME', () => {
  const home = makeHome();
  const before = snapshot(home);
  const tmp = makeTempDir('token-audit-tmp-');
  const run = runAudit(home, [], undefined, tmp);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(snapshot(home), before, 'the audit must not create, change or delete a file under HOME');
  assert.deepEqual(readdirSync(tmp), [], 'the throwaway HOME is removed after the run');
  const lines = run.stdout.split('\n');
  assert.match(lines.find((l) => l.startsWith('main session start: about')) ?? '', /tok$/);
  assert.match(lines.find((l) => l.startsWith('agent start: about')) ?? '', /tok$/);
  assert.match(run.stdout, /lead text \(lead-text\.mjs\) [1-9]/);
  assert.match(run.stdout, /lead rules \(session-notes\.mjs\) [1-9]/);
  assert.match(run.stdout, /checkpoint digest \(recall-digest\.mjs, only after a compaction\) 0/);
  assert.match(run.stdout, /compaction note \(session-notes\.mjs, only after a compaction\) 0/);
  assert.equal(`${run.stdout}${run.stderr}`.includes(MARKER), false, 'hook and memory text is measured, never printed');
});

test('--budget prints only ok, warn or fail lines', () => {
  const run = runAudit(makeHome(), ['--budget']);
  assert.equal(run.status, 0, run.stderr);
  const levels = run.stdout.trim().split('\n').map((line) => line.split('\t')[0]);
  assert.ok(levels.length > 0);
  assert.deepEqual(levels.filter((level) => !['ok', 'warn', 'fail'].includes(level)), []);
});

test('no lead.md and no lead-rules.md: counted as nothing, no throw', () => {
  const home = makeHome(false);
  const report = runAudit(home);
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /lead text \(lead-text\.mjs\) 0/);
  const budget = runAudit(home, ['--budget']);
  assert.match(budget.stdout, /^warn\tlead text missing or empty/m);
});

test('a missing, failing or late hook is not counted and says why; a huge text is counted as is', async () => {
  const dir = makeTempDir('token-audit-parts-');
  const script = (name, body) => {
    const path = join(dir, `${name}.mjs`);
    writeFileSync(path, body);
    return { part: name, when: name === 'late' || name === 'empty' ? 'agent' : 'main', script: path, input: () => ({}) };
  };
  const parts = await hookTextParts(
    [
      { part: 'gone', when: 'main', script: join(dir, 'no-such-hook.mjs'), input: () => ({}) },
      script('throws', "throw new Error('boom');\n"),
      script('late', `setTimeout(() => console.log('x'), ${SLOW_PART_MS});\n`),
      script('huge', `console.log('a'.repeat(${HUGE_CHARS}));\n`),
      script('empty', ''),
    ],
    TEST_TIMEOUT_MS,
  );
  assert.deepEqual(parts, [
    { part: 'gone', when: 'main', chars: null, why: 'missing' },
    { part: 'throws', when: 'main', chars: null, why: 'exit 1' },
    { part: 'late', when: 'agent', chars: null, why: `ran past ${TEST_TIMEOUT_MS / 1000} s` },
    { part: 'huge', when: 'main', chars: HUGE_CHARS + 1 },
    { part: 'empty', when: 'agent', chars: 0 },
  ]);
});

test('a total with a part not counted says "at least" and names the part with its reason', () => {
  const lines = startLines(() => 400, [
    { part: 'lead text (lead-text.mjs)', when: 'main', chars: null, why: 'missing' },
    { part: 'agent start note (session-notes.mjs)', when: 'agent', chars: 40 },
  ]);
  assert.match(lines[0], /^main session start: about \d+ tok at least \(1 hook part not counted\)$/);
  assert.match(lines[2], /lead text \(lead-text\.mjs\): not counted \(missing\)/);
  assert.match(lines[3], /^agent start: about \d+ tok$/);
  assert.match(lines[4], /agent start note \(session-notes\.mjs\) 10/);
});

/** Makes a FIFO nobody writes to: a plain read of it waits forever. */
function makeFifo(path) {
  assert.equal(spawnSync('mkfifo', [path]).status, 0, `mkfifo ${path}`);
}

test('FIFOs at lead.md, CLAUDE.md and a rule file: the audit and --budget end, listing nothing of them', () => {
  const home = makeHome(false);
  const claude = join(home, '.claude');
  mkdirSync(join(claude, 'rules'));
  for (const path of [join(claude, 'lead.md'), join(claude, 'CLAUDE.md'), join(claude, 'rules', 'fifo.md')]) makeFifo(path);
  const budget = runAudit(home, ['--budget'], HANG_LIMIT_MS);
  assert.equal(budget.status, 0, `--budget must end: ${budget.error?.message ?? budget.stderr}`);
  assert.match(budget.stdout, /^warn\tlead text missing or empty/m);
  const report = runAudit(home, [], HANG_LIMIT_MS);
  assert.equal(report.status, 0, `the report must end: ${report.error?.message ?? report.stderr}`);
  assert.match(report.stdout, /lead text \(lead-text\.mjs\) 0/);
});

test('lead-text.mjs: a FIFO at lead.md prints nothing and ends', () => {
  const home = makeTempDir('token-audit-lead-fifo-');
  mkdirSync(join(home, '.claude'));
  makeFifo(join(home, '.claude', 'lead.md'));
  const run = spawnSync(process.execPath, [LEAD_TEXT], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 's' }),
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
    timeout: HANG_LIMIT_MS,
    killSignal: 'SIGKILL',
  });
  assert.equal(run.status, 0, `lead-text must end: ${run.error?.message ?? run.stderr}`);
  assert.equal(run.stdout, '');
});
