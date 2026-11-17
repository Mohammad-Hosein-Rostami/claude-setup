// Tests for the review-tier CLI on throw-away git repos (range, delta, lane classes, add-class, exit codes, log) and for the
// reviewer and security-auditor texts that carry the PLAN and verified contracts. Class and set cases: review-tier.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, git, makeRepo } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const CLI = fileURLToPath(new URL('../home/tools/review-tier/review-tier.mjs', import.meta.url));

/** A repo plus a log file in its own temp folder; `tier(args)` runs the CLI there. */
function lane() {
  const dir = makeRepo();
  const log = join(dir, '..', 'review-tier.jsonl');
  const tier = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: { ...CLEAN_ENV, REVIEW_TIER_LOG: log } });
  const json = (...args) => JSON.parse(tier(...args, '--json').stdout);
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
    git(dir, 'add', '--', path);
    git(dir, 'commit', '-q', '-m', `edit ${path}`);
    return git(dir, 'rev-parse', 'HEAD');
  };
  git(dir, 'checkout', '-q', '-b', 'lane');
  return { dir, log, tier, json, write };
}

test('CLI: a branch diff is classified; the report names paths and lines, the log holds no path and no line text', () => {
  const key = 'sk-test-PLANTEDFAKEKEY0123456789';
  const { log, tier, json, write } = lane();
  write('src/run.mjs', `const apiKey = "${key}";\nspawnSync(cmd);\n`);
  const result = json();
  assert.equal(result.tier, 2);
  assert.deepEqual(result.hits.filter((hit) => hit.class === 'security').map((hit) => hit.line), [1, 2]);
  assert.equal(result.range, 'main...HEAD');
  const text = tier();
  assert.equal(text.status, 0);
  assert.match(text.stdout.split('\n')[0], /^review-tier: tier 2 \(security, logic\), 1 files, 2 changed lines, main\.\.\.HEAD$/);
  assert.match(text.stdout, /\nwhy:\n {2}security src\/run\.mjs:1\n/);
  assert.match(text.stdout, /\nrun together:\n- reviewer sonnet high, lens correctness: /);
  assert.match(text.stdout.trimEnd().split('\n').at(-1), /^fix round: node ~\/\.claude\/tools\/review-tier\/review-tier\.mjs --delta <reviewed-sha> --lane-classes <previous-round-json> --landing$/);
  assert.ok(!(text.stdout + JSON.stringify(result) + readFileSync(log, 'utf8')).includes(key));
  const logged = JSON.parse(readFileSync(log, 'utf8').split('\n')[0]);
  assert.deepEqual(Object.keys(logged), ['ts', 'repo', 'range', 'tier', 'classes', 'files', 'changedLines', 'landing', 'added']);
  if (process.platform !== 'win32') assert.equal(statSync(log).mode & 0o777, 0o600);
});

test('CLI: a bad range, an unknown sha or class, a missing flag value exit 2; a folder that is no repository exits 1', () => {
  const { tier } = lane();
  for (const args of [['not-a-range'], ['nope..HEAD'], ['--delta', 'deadbeef'], ['--add-class', 'nonsense'], ['--delta'], ['--bogus'], ['-x..HEAD'], ['a..b', '--delta', 'HEAD']]) {
    assert.equal(tier(...args).status, 2, args.join(' '));
  }
  const outside = realpathSync(makeTempDir('review-tier-none-'));
  assert.equal(spawnSync(process.execPath, [CLI], { cwd: outside, encoding: 'utf8', env: CLEAN_ENV }).status, 1);
});

test('CLI: a range of two commits (the 8bb8d1d shape) is read as given', () => {
  const { write, json, dir } = lane();
  const first = write('src/session-lock.mjs', 'const a = 1;\n');
  const second = write('src/session-lock.mjs', 'const a = 1;\nrenameSync(tmp, dest);\n');
  const result = json(`${first}..${second}`);
  assert.equal(result.tier, 3);
  assert.ok(git(dir, 'rev-parse', 'HEAD') === second);
});

test('CLI: --add-class money on a README-only diff gives the money set; --add-class never lowers', () => {
  const { write, json } = lane();
  write('README.md', '# x\n');
  const raised = json('--add-class', 'money');
  assert.equal(raised.tier, 2);
  assert.deepEqual(raised.added, ['money']);
  assert.ok(raised.reviews.some((r) => r.agent === 'security-auditor' && r.effort === 'max'));
  write('src/a.mjs', 'const a = 1;\n');
  const same = json('--add-class', 'docs', '--add-class', 'logic');
  assert.equal(same.tier, 1);
  assert.deepEqual(same.added, [], 'both classes are in the diff already');
});

test('CLI: a delta keeps the classes a file had earlier in the lane (--lane-classes), and the race plan', () => {
  const { dir, write, json } = lane();
  const reviewed = write('src/store.mjs', 'renameSync(tmp, dest);\nconst a = 1;\n');
  const round1 = join(dir, '..', 'round1.json');
  writeFileSync(round1, JSON.stringify(json()));
  write('src/store.mjs', 'renameSync(tmp, dest);\nconst a = 2;\n');
  const plain = json('--delta', reviewed);
  assert.ok(!plain.classes.includes('concurrency'), 'without the lane file a trivial change is just logic');
  const kept = json('--delta', reviewed, '--lane-classes', round1);
  assert.ok(kept.classes.includes('concurrency'));
  const lens = kept.reviews.find((r) => r.model === 'opus' && r.effort === 'max');
  assert.deepEqual(lens.plan.race, { runs: 200 });
  assert.equal(kept.deltaOf, reviewed);
  assert.equal(kept.range, `${reviewed}..HEAD`);
  assert.equal(kept.changedLines, 2);
  assert.ok(kept.fileClasses['src/store.mjs'].includes('concurrency'));
});

test('CLI: --lane-classes with a missing file or no fileClasses exits 2', () => {
  const { dir, write, tier } = lane();
  const reviewed = write('src/a.mjs', 'const a = 1;\n');
  write('src/a.mjs', 'const a = 2;\n');
  writeFileSync(join(dir, '..', 'bad.json'), '{"tier": 1}');
  assert.equal(tier('--delta', reviewed, '--lane-classes', join(dir, '..', 'nope.json')).status, 2);
  assert.equal(tier('--delta', reviewed, '--lane-classes', join(dir, '..', 'bad.json')).status, 2);
});

test('CLI: a delta with a rebased (non-ancestor) sha lists only the new patches', () => {
  const { dir, write, json } = lane();
  write('src/one.mjs', 'const one = 1;\n');
  const reviewed = write('src/two.mjs', 'const two = 2;\n');
  git(dir, 'checkout', '-q', 'main');
  write('other.txt', 'main moved\n');
  git(dir, 'checkout', '-q', 'lane');
  git(dir, 'rebase', '-q', 'main');
  write('src/three.mjs', 'const three = 3;\n');
  assert.notEqual(git(dir, 'rev-parse', 'HEAD~1'), reviewed);
  const result = json('--delta', reviewed);
  assert.deepEqual(Object.keys(result.fileClasses), ['src/three.mjs']);
  assert.match(result.range, /^patches [0-9a-f]{8} of main\.\.HEAD$/);
});

test('CLI: a delta on a rebased lane still sees a gate file renamed away (a rename has no hunk)', () => {
  const { dir, write, json } = lane();
  const reviewed = write('tsconfig.json', '{}\n');
  git(dir, 'checkout', '-q', 'main');
  write('other.txt', 'main moved\n');
  git(dir, 'checkout', '-q', 'lane');
  git(dir, 'rebase', '-q', 'main');
  git(dir, 'mv', 'tsconfig.json', 'tsconfig.json.off');
  git(dir, 'commit', '-q', '-m', 'rename tsconfig away');
  assert.notEqual(git(dir, 'rev-parse', 'HEAD~1'), reviewed);
  const result = json('--delta', reviewed, '--landing');
  assert.ok(result.tier >= 1, `tier ${result.tier}`);
  assert.ok(Object.keys(result.fileClasses).includes('tsconfig.json'));
});

test('CLI: a delta lists callers of the changed functions as required reading (file:line only, at most 20)', () => {
  const { write, json } = lane();
  write('src/use.mjs', 'const out = computeTotal(1);\n');
  const reviewed = write('src/total.mjs', 'export function computeTotal(a) { return a; }\n');
  write('src/total.mjs', 'export function computeTotal(a) { return a + 1; }\n');
  const result = json('--delta', reviewed);
  assert.deepEqual(result.reviews[0].requiredReading, ['src/use.mjs:1']);
  assert.match(result.reviews[0].brief, /Read first \(callers and callees\): src\/use\.mjs:1\./);
});

test('CLI: a fix inside a function body lists its callers (from the hunk header) and the definitions it calls', () => {
  const { write, json } = lane();
  write('src/caller.mjs', 'const out = loadRows(1);\n');
  write('src/helper.mjs', 'export function parseRow(row) {\n  return row;\n}\n');
  const reviewed = write('src/rows.mjs', 'export function loadRows(a) {\n  const x = 1;\n  return a + x;\n}\n');
  write('src/rows.mjs', 'export function loadRows(a) {\n  const x = 1;\n  return parseRow(a) + x;\n}\n');
  const reading = json('--delta', reviewed).reviews[0].requiredReading;
  assert.ok(reading.includes('src/caller.mjs:1'), `callers: ${reading}`);
  assert.ok(reading.includes('src/helper.mjs:1'), `callees: ${reading}`);
});

test('CLI: diff.noprefix and diff.mnemonicPrefix do not cut the paths or lose the file-level plan', () => {
  const { dir, write, json } = lane();
  git(dir, 'config', 'diff.noprefix', 'true');
  write('src/worker.mjs', "import { writeFileSync } from 'node:fs';\nwriteFileSync(a, b);\nsetTimeout(tick, 5);\n");
  const result = json();
  assert.deepEqual(Object.keys(result.fileClasses), ['src/worker.mjs']);
  assert.ok(result.classes.includes('concurrency-lite'));
  git(dir, 'config', '--unset', 'diff.noprefix');
  git(dir, 'config', 'diff.mnemonicPrefix', 'true');
  const reviewed = write('src/other.mjs', 'const a = 1;\n');
  write('src/other.mjs', 'const a = 2;\n');
  assert.deepEqual(Object.keys(json('--delta', reviewed).fileClasses), ['src/other.mjs']);
});

// ---- reviewer and auditor contracts ----

const agentText = (name) => readFileSync(fileURLToPath(new URL(`../home/agents/${name}.md`, import.meta.url)), 'utf8');

test('reviewer.md: no full-suite re-run, every PLAN item, own judgement kept, memory first, the verified line', () => {
  const text = agentText('reviewer');
  assert.match(text, /CHECKS:[^\n]*Do not re-run the full suite/);
  assert.match(text, /Run every `PLAN:` item/);
  assert.match(text, /you keep your own judgement: repeat loops, extra stress or mutants/);
  assert.match(text, /Read `MEMORY\.md` first, then the notes about this diff's area/);
  assert.match(text, /verified: CHECKS at HEAD: yes\|no; plan: <items run>; own: <extra checks run>; stress: .*mutants: <killed>\/<n>/);
  assert.match(text, /over 0 runs is not a result/);
});

test('security-auditor.md: same range, PLAN, own judgement and memory text; a PoC test decides exploitable; unknown names file:line', () => {
  const text = agentText('security-auditor');
  assert.match(text, /Read the range the brief names/);
  assert.match(text, /`PLAN:` line[^\n]*Your own judgement stays as today/);
  assert.match(text, /Read `MEMORY\.md` first/);
  assert.match(text, /proof-of-concept test when it decides `exploitable: yes`/);
  assert.match(text, /`unknown` names file:line/);
  assert.match(text, /Final line: `exploitable: yes\|no\|unknown; plan:/);
});
