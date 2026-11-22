// Tests for home/hooks/token-audit.mjs: the two start totals with the start hooks' text counted, the --budget form doctor.sh reads,
// and that measuring the hook text writes nothing and prints none of it.
// How: the CLI runs as a child with HOME (and USERPROFILE) set to a cs-test- temp folder holding a lead.md, a lead-rules.md, a
// MEMORY.md (each with a marker that must never reach the output) and a 20-day-old state file that session-notes' prune would
// delete; every file under that HOME is compared before and after. hookTextParts and startLines are also called with fake parts
// for a missing hook file, a throw, a late part and a 6,000-character text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookTextParts, startLines } from '../home/hooks/token-audit.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const AUDIT = fileURLToPath(new URL('../home/hooks/token-audit.mjs', import.meta.url));
const MARKER = 'cs-test-private-hook-text';
const STALE_AGE_MS = 20 * 24 * 60 * 60 * 1000; // older than session-notes' 14-day retention
const HUGE_CHARS = 6000;
const SHORT_TIMEOUT_MS = 50;
const SLOW_PART_MS = 2000;

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

function runAudit(home, args = []) {
  const cwd = makeTempDir('token-audit-cwd-');
  writeFileSync(join(cwd, 'CLAUDE.md'), '# project rules\n');
  return spawnSync(process.execPath, [AUDIT, ...args], { cwd, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
}

test('the report gives both start totals, counts the hook text, prints none of it and changes no file under HOME', () => {
  const home = makeHome();
  const before = snapshot(home);
  const run = runAudit(home);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(snapshot(home), before, 'the audit must not create, change or delete a file under HOME');
  const lines = run.stdout.split('\n');
  assert.match(lines.find((l) => l.startsWith('main session start: about')) ?? '', /tok$/);
  assert.match(lines.find((l) => l.startsWith('agent start: about')) ?? '', /tok$/);
  assert.match(run.stdout, /lead text \(lead-text\.mjs\) [1-9]/);
  assert.match(run.stdout, /lead rules and notes \(session-notes\.mjs\) [1-9]/);
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

test('a missing, throwing or late hook part is not counted and says why; a huge text is counted as is', async () => {
  const parts = await hookTextParts(
    [
      { part: 'gone', when: 'main', file: 'no-such-hook.mjs', measure: () => 'x' },
      { part: 'throws', when: 'main', file: 'lead-text.mjs', measure: () => { throw new Error('boom'); } },
      { part: 'late', when: 'agent', file: 'lead-text.mjs', measure: () => new Promise((resolve) => setTimeout(resolve, SLOW_PART_MS, 'x')) },
      { part: 'huge', when: 'main', file: 'lead-text.mjs', measure: () => 'a'.repeat(HUGE_CHARS) },
      { part: 'empty', when: 'agent', file: 'lead-text.mjs', measure: () => '' },
    ],
    SHORT_TIMEOUT_MS,
  );
  assert.deepEqual(parts, [
    { part: 'gone', when: 'main', chars: null, why: 'missing' },
    { part: 'throws', when: 'main', chars: null, why: 'boom' },
    { part: 'late', when: 'agent', chars: null, why: `ran past ${SHORT_TIMEOUT_MS / 1000} s` },
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
