// Size tests for the standing-rules digest (home/tools/status/status-digest.mjs rulesText) and its doctor lines
// (home/tools/status/rules-size.mjs rulesDigestBudget, printed by `token-audit.mjs --budget`): the rules string stays within
// RULES_CAP on every path (also when the always and project rules alone pass it), no rule is ever cut mid-text, job rules are shown
// newest first and the rules left out are named in a true closing line with the file, the replaced rules are one count line, the
// rules part prints at a fresh start too, and the doctor fails when always or project rules are left out and warns when only job
// rules are.
// How: STATUS.md texts are built here; the link store is a temp folder filled with noteTable, passed as the state dir, so no
// test reads the owner's state; the CLI runs with HOME set to a cs-test- temp folder whose store this process filled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { noteTable } from '../home/tools/estimate/lib/table-store.mjs';
import { rulesDigestBudget } from '../home/tools/status/rules-size.mjs';
import { RULES_CAP, STRING_CAP, rulesDigest, rulesText, statusDigestPart } from '../home/tools/status/status-digest.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const AUDIT = fileURLToPath(new URL('../home/hooks/token-audit.mjs', import.meta.url));
const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';
const SESSION_C = '33333333-3333-4333-8333-333333333333';
const WORDS_CHARS = 200; // 60 rules of this length pass RULES_CAP; 20 of them do not
const NOW_MS = Date.parse('2026-11-22T10:00Z');
const PATH = '/work/job/STATUS.md';

/** Rule words of WORDS_CHARS chars that name the rule, so a test can find it whole. */
const words = (name) => `${name} keep this rule `.padEnd(WORDS_CHARS, 'x');
const dayOf = (n) => new Date(Date.UTC(2026, 9, n)).toISOString().slice(0, 10);
const statusWith = (bullets) => `# STATUS\n\n## Standing rules\n${bullets.join('\n')}\n\n## Work items\n`;

/**
 * 20 always rules (R1-R20) and 40 job rules (R21-R60) of WORDS_CHARS each, alternating in the file. A job rule is named by its day
 * (`job-d<n>`, 2026-10-01 plus n-1 days) and the days are shuffled against the file order, so `job-d40` is the newest and `job-d1`
 * the oldest wherever they stand.
 */
function sixtyRules() {
  const bullets = [];
  for (let n = 1; n <= 40; n += 1) {
    if (n <= 20) bullets.push(`- ${words(`always-${n}`)} {R${n} 2026-09-01 always}`);
    const dayNumber = ((n * 17) % 40) + 1; // 17 and 40 share no factor: each day 1-40 is used once
    bullets.push(`- ${words(`job-d${dayNumber}`)} {R${20 + n} ${dayOf(dayNumber)} job}`);
  }
  return statusWith(bullets);
}

test('60 rules over the bound: within RULES_CAP, always rules whole in file order, newest job rule first, last line names the rest', () => {
  const text = sixtyRules();
  const out = rulesText(text, PATH);
  assert.ok(out.length <= RULES_CAP, `the rules string is ${out.length} chars, bound ${RULES_CAP}`);
  const lines = out.split('\n');
  const alwaysLines = lines.filter((line) => line.includes('always-'));
  assert.deepEqual(alwaysLines.map((line) => line.match(/always-(\d+) /)[1]), Array.from({ length: 20 }, (_, i) => String(i + 1)));
  for (let n = 1; n <= 20; n += 1) assert.ok(out.includes(words(`always-${n}`)), `always rule ${n} is whole`);
  const jobLines = lines.filter((line) => line.includes('job-'));
  assert.match(jobLines[0], /^- R\d+ \(job, 2026-11-09\) job-d40 /, 'the newest job rule comes first among the job rules');
  assert.match(jobLines[1], / job-d39 /);
  const hidden = 40 - jobLines.length;
  assert.ok(hidden > 0, 'some job rules are left out');
  assert.equal(lines.at(-1), `${hidden} job rules not shown: read ${PATH}`);
  assert.ok(!out.includes('job-d1 '), 'the oldest job rule is left out');
});

test('no rules give an empty string; rules that fit are all shown, with no closing line', () => {
  assert.equal(rulesText('# STATUS\n\n## Work items\n', PATH), '');
  assert.equal(rulesText(statusWith([]), PATH), '');
  const out = rulesText(statusWith([`- first {R1 2026-11-01 job}`, `- second {R2 2026-11-02 job}`, `- third {R3 2026-11-03 always}`]), PATH);
  assert.deepEqual(out.split('\n').slice(1), ['- R3 (always, 2026-11-03) third', '- R2 (job, 2026-11-02) second', '- R1 (job, 2026-11-01) first']);
});

test('old readers: an untagged bullet reads as always, replaced rules are one count line', () => {
  const bullets = [
    '- written before ids',
    `- ${words('job-old')} {R1 2026-11-01 job; superseded by R3}`,
    `- ${words('project-old')} {R2 2026-11-02 project; superseded by R4}`,
    `- newer job {R3 2026-11-03 job; supersedes R1}`,
    `- newer project {R4 2026-11-04 project; supersedes R2}`,
  ];
  const lines = rulesText(statusWith(bullets), PATH).split('\n');
  assert.deepEqual(lines.slice(1), [
    '- written before ids',
    '- R4 (project, 2026-11-04, replaces R2) newer project',
    '- R3 (job, 2026-11-03, replaces R1) newer job',
    'Replaced rules: 2 (kept in the file, not active)',
  ]);
});

/** The always rule numbers a rules string shows, each checked whole (its words exactly as written). */
function wholeAlwaysShown(out) {
  const shown = out.split('\n').filter((line) => line.includes('always-')).map((line) => Number(line.match(/always-(\d+) /)[1]));
  for (const n of shown) assert.ok(out.includes(words(`always-${n}`)), `always rule ${n} is whole`);
  return shown;
}

test('always and project rules alone over the bound: within RULES_CAP, the first ones whole in file order, the rest counted', () => {
  const bullets = Array.from({ length: 50 }, (_, i) => `- ${words(`always-${i + 1}`)} {R${i + 1} 2026-11-01 ${i % 2 ? 'always' : 'project'}}`);
  bullets.push(`- ${words('job-1')} {R51 2026-11-02 job}`);
  const digest = rulesDigest(statusWith(bullets), PATH);
  assert.ok(digest.text.length <= RULES_CAP, `the rules string is ${digest.text.length} chars, bound ${RULES_CAP}`);
  const shown = wholeAlwaysShown(digest.text);
  assert.deepEqual(shown, Array.from({ length: shown.length }, (_, i) => i + 1), 'the first always rules, in file order');
  assert.ok(!digest.text.includes('job-1 '));
  assert.deepEqual([digest.hiddenAlways, digest.hiddenJob], [50 - shown.length, 1]);
  assert.equal(digest.text.split('\n').at(-1), `${50 - shown.length} always or project rules and 1 job rule not shown (the rules pass the ${RULES_CAP}-char bound): read the full list in ${PATH}`);
});

test('always rules of 9,950 chars in all: the framed SessionStart string stays under the hook cap, no rule cut', () => {
  const bullets = Array.from({ length: 45 }, (_, i) => `- ${words(`always-${i + 1}`)} {R${i + 1} 2026-11-01 always}`);
  const text = statusWith(bullets);
  assert.ok(text.length > 9950, `the fixture is ${text.length} chars`);
  const out = rulesText(text, PATH);
  assert.ok(`<status-digest part="rules">\n${out}\n</status-digest>`.length <= STRING_CAP);
  assert.ok(out.length <= RULES_CAP, `${out.length} chars`);
  const shown = wholeAlwaysShown(out);
  assert.match(out.split('\n').at(-1), new RegExp(`^${45 - shown.length} always or project rules and 0 job rules not shown`));
});

test('always rules that fit but leave no room for the job closing line: the closing line is true, the total within the bound', () => {
  const bullets = [];
  while (rulesText(statusWith(bullets), PATH).length < RULES_CAP - 2 * WORDS_CHARS) bullets.push(`- ${words(`always-${bullets.length + 1}`)} {R${bullets.length + 1} 2026-11-01 always}`);
  const room = RULES_CAP - rulesText(statusWith(bullets), PATH).length - 1;
  bullets.push(`- ${`always-${bullets.length + 1} `.padEnd(room - 30, 'q')} {R${bullets.length + 1} 2026-11-01 always}`);
  const alwaysOnly = rulesText(statusWith(bullets), PATH);
  assert.ok(alwaysOnly.length <= RULES_CAP && alwaysOnly.length > RULES_CAP - 30, `the always rules alone take ${alwaysOnly.length} chars`);
  bullets.push(`- ${words('job-1')} {R${bullets.length + 1} 2026-11-02 job}`);
  const digest = rulesDigest(statusWith(bullets), PATH);
  assert.ok(digest.text.length <= RULES_CAP, `${digest.text.length} chars`);
  const shownAlways = digest.text.split('\n').filter((line) => line.includes('always-')).length;
  assert.equal(shownAlways + digest.hiddenAlways, bullets.length - 1, 'every always rule is either shown or counted');
  assert.equal(digest.hiddenJob, 1);
  assert.doesNotMatch(digest.text, /alone pass/, 'the always rules alone do fit: the line must not say they pass');
  assert.equal(digest.text.split('\n').at(-1), `${digest.hiddenAlways} always or project rule${digest.hiddenAlways === 1 ? '' : 's'} and 1 job rule not shown (the rules pass the ${RULES_CAP}-char bound): read the full list in ${PATH}`);
});

test('500 job rules in a 180 KB STATUS.md stay within the bound; the file text is framed as data with angle brackets removed', () => {
  const bullets = Array.from({ length: 500 }, (_, i) => `- <b>${words(`job-${i + 1}`).repeat(2)}</b> {R${i + 1} 2026-11-01 job}`);
  const text = `${statusWith(bullets)}${'filler line\n'.repeat(3000)}`;
  assert.ok(text.length > 180_000, `the fixture is ${text.length} chars`);
  const out = rulesText(text, '/work/<job>/STATUS.md');
  assert.ok(out.length <= RULES_CAP, `${out.length} chars`);
  assert.ok(!/[<>]/.test(out), 'no angle bracket reaches the digest');
  assert.match(out.split('\n')[1], /^- R500 \(job, 2026-11-01\)/, 'the same date: the higher id is the newer rule');
});

test('the SessionStart rules part keeps its frame and stays under the hook string cap', () => {
  const stateDir = makeTempDir('digest-size-state-');
  const cwd = makeTempDir('digest-size-job-');
  const path = join(cwd, 'STATUS.md');
  writeFileSync(path, sixtyRules());
  assert.equal(noteTable(stateDir, path, { sessionId: SESSION_A, ids: [], nowMs: NOW_MS }), true);
  const out = statusDigestPart('rules', { hook_event_name: 'SessionStart', source: 'compact', session_id: SESSION_A, cwd }, { stateDir });
  assert.match(out, /^<status-digest part="rules">\nStanding rules of /);
  assert.match(out, /\n<\/status-digest>$/);
  assert.ok(out.length < STRING_CAP, `${out.length} chars`);
});

test('the rules part prints at a fresh start too; the state part waits for a resume or a compaction', () => {
  const cwd = makeTempDir('digest-size-start-');
  writeFileSync(join(cwd, 'STATUS.md'), statusWith(['- keep it short {R1 2026-11-01 always}']));
  const start = { hook_event_name: 'SessionStart', source: 'startup', session_id: SESSION_A, cwd };
  const deps = { stateDir: makeTempDir('digest-size-start-state-') };
  assert.match(statusDigestPart('rules', start, deps), /^<status-digest part="rules">\nStanding rules of .*\n- R1 \(always, 2026-11-01\) keep it short\n<\/status-digest>$/);
  assert.equal(statusDigestPart('state', start, deps), '');
  assert.equal(statusDigestPart('rules', { ...start, agent_id: 'a1' }, deps), '', 'never inside an agent');
});

test('rulesDigestBudget: one line per linked STATUS.md, fail for lost always rules, warn for lost job rules, gone or foreign skipped', () => {
  const stateDir = makeTempDir('digest-size-store-');
  assert.deepEqual(rulesDigestBudget(stateDir), ['ok\trules digest: no linked STATUS.md']);
  const small = join(makeTempDir('digest-size-small-'), 'STATUS.md');
  const short = join(makeTempDir('digest-size-short-'), 'STATUS.md');
  const huge = join(makeTempDir('digest-size-huge-'), 'STATUS.md');
  const gone = join(makeTempDir('digest-size-gone-'), 'STATUS.md');
  writeFileSync(small, sixtyRules());
  writeFileSync(huge, statusWith(Array.from({ length: 50 }, (_, i) => `- ${words(`always-${i}`)} {R${i + 1} 2026-11-01 always}`)));
  writeFileSync(gone, sixtyRules());
  writeFileSync(short, statusWith(['- one rule {R1 2026-11-01 always}']));
  for (const [path, sessionId] of [[small, SESSION_A], [huge, SESSION_B], [small, SESSION_B], [gone, SESSION_A], [short, SESSION_C]]) {
    assert.equal(noteTable(stateDir, path, { sessionId, ids: [], nowMs: NOW_MS }), true);
  }
  rmSync(gone);
  mkdirSync(join(stateDir, 'table'), { recursive: true });
  writeFileSync(join(stateDir, 'table', `${'a'.repeat(32)}.json`), JSON.stringify({ v: 2, path: 'C:\\Users\\me\\job\\STATUS.md', sessions: [], added: {}, rows: [], jobs: [], commit: null, log: [] }));
  const lines = rulesDigestBudget(stateDir).sort();
  assert.equal(lines.length, 3, lines.join('\n'));
  assert.match(lines[0], new RegExp(`^fail\\trules digest \\d+ chars \\(bound ${RULES_CAP}\\): \\d+ always or project rules and 0 job rules not shown .*digest-size-huge-`));
  assert.match(lines[1], new RegExp(`^ok\\trules digest \\d+ chars \\(bound ${RULES_CAP}\\): .*digest-size-short-`));
  assert.match(lines[2], new RegExp(`^warn\\trules digest \\d+ chars \\(bound ${RULES_CAP}\\), \\d+ job rules not shown \\(the oldest\\): .*digest-size-small-`));
});

test('token-audit --budget with no linked STATUS.md says so in one ok line', () => {
  const home = makeTempDir('digest-size-home-');
  const tmp = makeTempDir('digest-size-tmp-');
  const env = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  const run = spawnSync(process.execPath, [AUDIT, '--budget'], { cwd: home, env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.split('\n').filter((line) => line.includes('rules digest')), ['ok\trules digest: no linked STATUS.md']);
});

test('token-audit --budget measures a linked STATUS.md in a temp HOME: warn over the bound, ok under it, fail for lost always rules', () => {
  const home = makeTempDir('digest-size-home-');
  const tmp = makeTempDir('digest-size-tmp-');
  const store = join(home, '.claude', 'state', 'estimate'); // the CLI's own store; this process's HOME is another, so noteTable links
  const files = [['over', sixtyRules(), SESSION_A], ['under', statusWith(['- one rule {R1 2026-11-01 always}']), SESSION_B],
    ['lost', statusWith(Array.from({ length: 50 }, (_, i) => `- ${words(`always-${i}`)} {R${i + 1} 2026-11-01 always}`)), SESSION_C]];
  for (const [name, text, sessionId] of files) {
    const path = join(makeTempDir(`digest-size-${name}-`), 'STATUS.md');
    writeFileSync(path, text);
    assert.equal(noteTable(store, path, { sessionId, ids: [], nowMs: NOW_MS }), true);
  }
  const env = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  const run = spawnSync(process.execPath, [AUDIT, '--budget'], { cwd: home, env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.split('\n').filter((line) => line.includes('rules digest')).sort();
  assert.equal(lines.length, 3, lines.join('\n'));
  assert.match(lines[0], /^fail\trules digest .*digest-size-lost-/);
  assert.match(lines[1], /^ok\trules digest .*digest-size-under-/);
  assert.match(lines[2], /^warn\trules digest .*digest-size-over-/);
});
