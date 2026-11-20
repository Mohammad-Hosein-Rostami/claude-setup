// Tests for the review-tier CLI on throw-away git repos (range, delta, lane classes, add-class, exit codes, log) and for the
// reviewer and security-auditor texts that carry the PLAN and verified contracts. Class and set cases: review-tier.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, git } from './git-tidy-helpers.mjs';
import { CLI, lane, laneNamesOf, priorFile } from './review-tier-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

test('CLI: a branch diff is classified; the report names paths and lines, the log holds no path and no line text', () => {
  const key = 'sk-test-PLANTEDFAKEKEY0123456789';
  const { dir, log, tier, json, write } = lane();
  write('src/run.mjs', `const apiKey = "${key}";\nspawnSync(cmd);\n`);
  const result = json();
  assert.equal(result.tier, 2);
  assert.deepEqual(result.hits.filter((hit) => hit.class === 'security').map((hit) => hit.line), [1, 2]);
  const range = `${git(dir, 'rev-parse', 'refs/heads/main')}...HEAD`;
  assert.equal(result.range, range, 'the default range names the base branch by its sha');
  const text = tier();
  assert.equal(text.status, 0);
  assert.equal(text.stdout.split('\n')[0], `review-tier: tier 2 (security, logic), 1 files, 2 changed lines, ${range}`);
  assert.match(text.stdout, /\nwhy:\n {2}security src\/run\.mjs:1\n/);
  assert.match(text.stdout, /\nrun together:\n- reviewer sonnet high, lens correctness: /);
  assert.equal(text.stdout.trimEnd().split('\n').at(-1), `fix round: node ~/.claude/tools/review-tier/review-tier.mjs --delta ${git(dir, 'rev-parse', 'HEAD')} --base ${git(dir, 'rev-parse', 'refs/heads/main')} --prior <findings-file> --prior-sha256 <its-sha256> --lane-classes security,logic`, 'the line carries the commit that was read, the lane start and the classes (review R3-2)');
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

test('security N9: a class name is looked up in the table itself: `constructor` and `toString` are unknown, for --add-class and in --lane-classes', () => {
  const { write, tier } = lane();
  const reviewed = write('src/a.mjs', 'const a = 1;\n');
  write('src/a.mjs', 'const a = 2;\n');
  for (const name of ['constructor', 'toString', '__proto__']) {
    for (const [flag, value] of [['--add-class', name], ['--lane-classes', name], ['--lane-classes', `logic,${name}`]]) {
      const result = tier('--delta', reviewed, '--prior', priorFile(), flag, value);
      assert.equal(result.status, 2, `${flag} ${value}`);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, flag === '--add-class' ? /unknown class/ : /--lane-classes takes the class names .*unknown name/);
    }
  }
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

test('CLI: a delta keeps the classes a file has in the lane, whatever names --lane-classes holds, and the race plan', () => {
  const { write, json } = lane();
  const reviewed = write('src/store.mjs', 'renameSync(tmp, dest);\nconst a = 1;\n');
  const names = laneNamesOf(json());
  assert.equal(names, 'concurrency,data,logic,lock-free', 'what the round before printed for the next one: its classes, then the kind of its concurrency lines');
  write('src/store.mjs', 'renameSync(tmp, dest);\nconst a = 2;\n');
  const plain = json('--delta', reviewed, '--prior', priorFile(), '--lane-classes', 'docs');
  assert.ok(plain.classes.includes('concurrency'), 'the tool reads the lane range itself: a trivial change to concurrency code is not just logic');
  assert.deepEqual(plain.reviews.find((r) => r.model === 'opus' && r.effort === 'max').plan.race, { runs: 200 });
  const kept = json('--delta', reviewed, '--prior', priorFile(), '--lane-classes', names);
  assert.ok(kept.classes.includes('concurrency'));
  const lens = kept.reviews.find((r) => r.model === 'opus' && r.effort === 'max');
  assert.deepEqual(lens.plan.race, { runs: 200 });
  assert.equal(kept.deltaOf, reviewed);
  assert.equal(kept.range, `${reviewed}..HEAD`);
  assert.equal(kept.changedLines, 2);
  assert.ok(kept.fileClasses['src/store.mjs'].includes('concurrency'));
  assert.equal(laneNamesOf(kept), names, 'the round hands the same names on');
});

test('security B6 (probe p3 a): --lane-classes takes names, never a file: a path, an unknown name and an empty list are exit 2, and the file is not read', () => {
  const { dir, write, tier, json } = lane();
  const reviewed = write('src/a.mjs', 'const a = 1;\n');
  write('src/a.mjs', 'const a = 2;\n');
  const forged = join(dir, '..', 'round.json');
  writeFileSync(forged, JSON.stringify({ fileClasses: {}, classes: ['docs'], laneClasses: ['docs'] })); // what a round's --json looked like
  const fixRound = ['--delta', reviewed, '--prior', priorFile()];
  for (const value of [forged, 'round.json', 'nope', 'Logic', 'logic docs', ',', '']) {
    const result = tier(...fixRound, '--lane-classes', value);
    assert.equal(result.status, 2, value);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /--lane-classes takes the class names of the round before, comma-separated .*no file is read\): (unknown name|no name given)/, value);
  }
  const raised = json(...fixRound, '--lane-classes', 'security,logic');
  assert.deepEqual([raised.tier, raised.classes], [2, ['security', 'logic']], 'a name raises the set');
});

test('CLI: a delta with a rebased (non-ancestor) sha reads the whole lane, not what landed on the base', () => {
  const { dir, write, json } = lane();
  write('src/one.mjs', 'const one = 1;\n');
  const reviewed = write('src/two.mjs', 'const two = 2;\n');
  git(dir, 'checkout', '-q', 'main');
  write('other.txt', 'main moved\n');
  git(dir, 'checkout', '-q', 'lane');
  git(dir, 'rebase', '-q', 'main');
  write('src/three.mjs', 'const three = 3;\n');
  assert.notEqual(git(dir, 'rev-parse', 'HEAD~1'), reviewed);
  const result = json('--delta', reviewed, '--prior', priorFile());
  assert.equal(result.range, `${git(dir, 'rev-parse', 'main')}..HEAD (rewritten lane: the reviewed commit ${reviewed} is no ancestor of HEAD, so the whole lane is read)`);
  assert.deepEqual([result.files, result.changedLines], [3, 3], 'every commit of the lane, as one tree diff');
  assert.deepEqual(Object.keys(result.fileClasses).sort(), ['src/one.mjs', 'src/three.mjs', 'src/two.mjs']);
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
  const result = json('--delta', reviewed, '--prior', priorFile(), '--landing');
  assert.ok(result.tier >= 1, `tier ${result.tier}`);
  assert.ok(Object.keys(result.fileClasses).includes('tsconfig.json'));
});

test('CLI: a delta lists callers of the changed functions as required reading (file:line only, at most 20)', () => {
  const { write, json } = lane();
  write('src/use.mjs', 'const out = computeTotal(1);\n');
  const reviewed = write('src/total.mjs', 'export function computeTotal(a) { return a; }\n');
  write('src/total.mjs', 'export function computeTotal(a) { return a + 1; }\n');
  const result = json('--delta', reviewed, '--prior', priorFile());
  assert.deepEqual(result.reviews[0].requiredReading, ['src/use.mjs:1']);
  assert.match(result.reviews[0].brief, /Read first \(callers, callees and users of names the fix removed, renamed or redefined; the changed files when none is found\): src\/use\.mjs:1\./);
});

test('CLI: a fix inside a function body lists its callers (from the hunk header) and the definitions it calls', () => {
  const { write, json } = lane();
  write('src/caller.mjs', 'const out = loadRows(1);\n');
  write('src/helper.mjs', 'export function parseRow(row) {\n  return row;\n}\n');
  const reviewed = write('src/rows.mjs', 'export function loadRows(a) {\n  const x = 1;\n  return a + x;\n}\n');
  write('src/rows.mjs', 'export function loadRows(a) {\n  const x = 1;\n  return parseRow(a) + x;\n}\n');
  const reading = json('--delta', reviewed, '--prior', priorFile()).reviews[0].requiredReading;
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
  const delta = json('--delta', reviewed, '--prior', priorFile());
  assert.equal(delta.files, 1);
  assert.deepEqual(Object.keys(delta.fileClasses).sort(), ['src/other.mjs', 'src/worker.mjs'], 'no path is cut: the fix and the lane file it keeps');
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
