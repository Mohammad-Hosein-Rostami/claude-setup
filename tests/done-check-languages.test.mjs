// Tests of the done-check's honesty about languages it has no checks for, and of its weakened-test scan for Go (road polish, step 5,
// lane lang-honest; questions P3, F1, F2, F3).
// Covers: a change of only `.py` (or other UNSUPPORTED_CODE) files is never `no code change`: the line says `not run (no python support:
//   n files)`, one ledger row with every kind `not-run` (`no-support`), exit 0 at a manual run and a land; a stop (ownChange) gets a
//   Scope for it; beside a checked TypeScript change the line gains `python not run`; only markdown stays `no code change`; old
//   ledger rows still read and the new reason is in the contract enum. Go: a renamed `_test.go` (git mv or plain mv) passes, a deleted
//   one alone, an added t.Skip, an added testing.Short() guard, a dropped Test function or t.Fatal call are weakened; a `_test.go`
//   deleted with its code is not; `err.Error()` is no assertion. A renamed JS test file passes as well (same rename rule).
// Invariants: every project is a fixture project in a temp folder (`cs-test-` prefix via temp-dir-helpers) with its own HOME; the test
//   process's HOME is pinned to a temp folder too, so nothing under the real ~/.claude is read or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDoneCheckRepo } from './done-check-fixture.mjs';
import { git } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { saveBaseline } from '../home/hooks/lib/dirty-baseline.mjs';
import { NOT_RUN_WHY } from '../home/tools/done-check/lib/contract.mjs';
import { readLedger } from '../home/tools/done-check/lib/ledger.mjs';
import { ownChange, rangeChange, UNSUPPORTED_CODE, unsupportedLanguages } from '../home/tools/done-check/lib/scope.mjs';
import { weakenedTests } from '../home/tools/done-check/lib/test-diff.mjs';
import { lineOf } from '../home/tools/done-check/lib/verdict-text.mjs';

const PINNED_HOME = makeTempDir('done-check-languages-home-');
process.env.HOME = PINNED_HOME;
process.env.USERPROFILE = PINNED_HOME;

const CLI = fileURLToPath(new URL('../home/tools/done-check/done-check.mjs', import.meta.url));
const TYPECHECK_PACKAGE = { name: 'p', private: true, scripts: { typecheck: 'tsc --noEmit' } };
const TS_SOURCES = { 'src/lib.ts': 'export const n: number = 1;\n', 'tsconfig.json': '{"compilerOptions":{"strict":true}}\n' };
const PY_FILES = ['tool.py', 'pkg/a.py', 'pkg/b.PY'];

const newRepo = (t, options) => {
  const repo = makeDoneCheckRepo(options);
  t.after(repo.cleanup);
  return repo;
};
const ledgerPath = (repo) => join(repo.home, '.claude', 'state', 'done-check', 'ledger.jsonl');

/** `done-check run --json` of the change in `repo` against its base; returns {status, verdict}. */
function check(repo, where = 'manual') {
  const result = repo.run(CLI, ['run', '--worktree', repo.dir, '--base', repo.baseSha, '--where', where, '--json']);
  assert.ok(result.stdout.startsWith('{'), `done-check run printed no JSON (exit ${result.status}): ${(result.stderr || result.stdout).split('\n')[0]}`);
  return { status: result.status, verdict: JSON.parse(result.stdout) };
}

test('P3: only python files changed: `not run (no python support: 3 files)`, never `no code change`, one no-support row, exit 0', (t) => {
  const repo = newRepo(t);
  for (const file of PY_FILES) repo.write(file, 'print(1)\n');
  const { status, verdict } = check(repo);
  assert.equal(status, 0);
  assert.equal(verdict.verdict, 'skipped');
  assert.equal(verdict.line, 'checks: not run (no python support: 3 files)');
  assert.equal(verdict.row.files, 3);
  for (const kind of ['types', 'lint', 'tests']) assert.deepEqual(verdict.row.checks[kind], { result: 'not-run', new: 0, old: 0, ms: 0, why: 'no-support' });
  const runs = readLedger({ env: repo.env }).runs;
  assert.equal(runs.length, 1, 'one ledger row');
  assert.equal(lineOf(runs[0]), 'checks: not run (no support: 3 files)', 'the row alone (done-check last) still says not run');
});

test('P3: two unsupported languages are both named, with a singular file count', (t) => {
  const repo = newRepo(t);
  repo.write('a.py', 'x = 1\n');
  repo.write('b.py', 'x = 2\n');
  repo.write('src/main.rs', 'fn main() {}\n');
  const { verdict } = check(repo);
  assert.equal(verdict.line, 'checks: not run (no python support: 2 files; no rust support: 1 file)');
});

test('P3: a land of only unsupported code passes (exit 0) and says not run', (t) => {
  const repo = newRepo(t);
  repo.write('lib/Main.java', 'class Main {}\n');
  repo.commit('java');
  const { status, verdict } = check(repo, 'land');
  assert.equal(status, 0);
  assert.equal(verdict.line, 'checks: not run (no java support: 1 file)');
});

test('F1: only markdown changed stays `no code change` with no ledger row', (t) => {
  const repo = newRepo(t);
  repo.write('docs/notes.md', 'hello\n');
  const { status, verdict } = check(repo);
  assert.equal(status, 0);
  assert.equal(verdict.line, 'checks: no code change');
  assert.throws(() => readFileSync(ledgerPath(repo)), /ENOENT/);
});

test('F1: a .py beside a .ts change: the TypeScript checks run and the line adds `python not run`', (t) => {
  const repo = newRepo(t, { packageJson: TYPECHECK_PACKAGE, files: TS_SOURCES, tools: ['tsc'], replay: { tsc: { exit: 0 } } });
  repo.write('src/lib.ts', 'export const n: number = 2;\n');
  repo.write('scripts/gen.py', 'print(2)\n');
  const { status, verdict } = check(repo);
  assert.equal(status, 0);
  assert.equal(verdict.verdict, 'ok');
  assert.match(verdict.line, /^checks: types ok · .*python not run · /);
  assert.equal(repo.calls('tsc').length, 1, 'tsc ran');
  assert.equal(verdict.row.files, 1, 'the row counts the checked files');
});

test('P3: at a stop, an agent change of only unsupported code gives a Scope that lists it (not [])', async (t) => {
  const repo = newRepo(t);
  const transcript = join(dirname(repo.dir), 'agent-transcript.jsonl');
  appendFileSync(transcript, `${JSON.stringify({ cwd: repo.dir })}\n`);
  assert.equal(saveBaseline(repo.env, 'session-1', 'agent-1', repo.dir, [], repo.head()), true);
  repo.write('app/views.py', 'x = 1\n');
  repo.write('README.md', 'docs\n');
  const input = { session_id: 'session-1', agent_id: 'agent-1', agent_type: 'general-purpose', agent_transcript_path: transcript };
  const scopes = await ownChange(input, { ...repo.env, CLAUDE_PROJECT_DIR: repo.dir });
  assert.equal(scopes.length, 1);
  assert.deepEqual(scopes[0].files, []);
  assert.deepEqual(scopes[0].unsupported, ['app/views.py']);
});

test('P3: the unsupported files stay out of the change key, so an edit to them alone keeps a green run reusable', async (t) => {
  const repo = newRepo(t, { files: { 'src/a.ts': 'export const a = 1;\n' } });
  repo.write('src/a.ts', 'export const a = 2;\n');
  const before = await rangeChange(repo.dir, repo.baseSha);
  repo.write('gen.py', 'x = 1\n');
  const after = await rangeChange(repo.dir, repo.baseSha);
  assert.deepEqual(after.unsupported, ['gen.py']);
  assert.equal(after.key, before.key);
});

test('F3: the no-support reason is in the contract enum; every UNSUPPORTED_CODE language is named; an old ledger row still reads', (t) => {
  assert.ok(NOT_RUN_WHY.includes('no-support'));
  assert.ok(Object.isFrozen(UNSUPPORTED_CODE));
  for (const [extension, language] of Object.entries(UNSUPPORTED_CODE)) {
    assert.deepEqual(unsupportedLanguages([`x/y.${extension}`]), [{ language, files: 1 }], extension);
  }
  assert.deepEqual(unsupportedLanguages(['node_modules/x/a.py', 'a.md', 'a.ts']), []);
  const repo = newRepo(t);
  const old = { v: 1, id: 'aaaaaaaaaaaa', at: '2026-11-20T10:00:00.000Z', where: 'stop', session: 's', agent: '', repo: 'r', base: null, key: 'k', files: 2,
    checks: { types: { result: 'ok', new: 0, old: 0, ms: 5 } }, verdict: 'ok', risk: [], ms: 9 };
  mkdirSync(dirname(ledgerPath(repo)), { recursive: true });
  appendFileSync(ledgerPath(repo), `${JSON.stringify(old)}\n`);
  repo.write('x.py', 'x = 1\n');
  check(repo);
  const runs = readLedger({ env: repo.env }).runs;
  assert.equal(runs.length, 2);
  assert.equal(lineOf(runs[0]), 'checks: types ok · base: none · 0.0 s');
  assert.equal(runs[1].checks.tests.why, 'no-support');
});

/** A Go package with a source file and a test file at the base; `change(repo)` edits it, and the scan of base..worktree is returned. */
async function goWeakened(t, { tests = GO_TEST, extra = {} } = {}, change) {
  const repo = newRepo(t, { files: { 'go.mod': 'module example.com/m\n\ngo 1.22\n', 'calc/calc.go': GO_CODE, 'calc/calc_test.go': tests, ...extra } });
  change(repo);
  return weakenedTests(await rangeChange(repo.dir, repo.baseSha));
}

const GO_CODE = 'package calc\n\nfunc Add(a, b int) int { return a + b }\n';
const GO_TEST = [
  'package calc', '', 'import "testing"', '',
  'func TestAdd(t *testing.T) {', '\tif Add(1, 2) != 3 {', '\t\tt.Fatalf("bad")', '\t}', '}', '',
  'func TestSub(t *testing.T) {', '\tt.Run("zero", func(t *testing.T) {', '\t\tif err := check(); err != nil {', '\t\t\tt.Error(err.Error())', '\t\t}', '\t})', '}', '',
].join('\n');
const reasons = (found) => found.map((failure) => failure.id).sort();

test('F2: a _test.go renamed with git mv, or moved by a plain mv, is not weakened', async (t) => {
  assert.deepEqual(await goWeakened(t, {}, (repo) => git(repo.dir, 'mv', 'calc/calc_test.go', 'calc/add_test.go')), []);
  assert.deepEqual(await goWeakened(t, {}, (repo) => {
    repo.write('calc/moved_test.go', GO_TEST);
    repo.remove('calc/calc_test.go');
  }), []);
});

test('F2: a _test.go renamed while a Test function is dropped is weakened at its new path', async (t) => {
  const tests = `${GO_TEST}func TestTiny(t *testing.T) {}\n`;
  const found = await goWeakened(t, { tests }, (repo) => {
    git(repo.dir, 'mv', 'calc/calc_test.go', 'calc/add_test.go');
    repo.write('calc/add_test.go', GO_TEST);
  });
  assert.ok(reasons(found).includes('calc/add_test.go|fewer-cases'), reasons(found).join(', '));
});

test('F2: a _test.go deleted alone is weakened; deleted with its code (its .go, or the whole package) it is not', async (t) => {
  assert.deepEqual(reasons(await goWeakened(t, {}, (repo) => repo.remove('calc/calc_test.go'))), ['calc/calc_test.go|deleted']);
  assert.deepEqual(await goWeakened(t, {}, (repo) => {
    repo.remove('calc/calc_test.go');
    repo.remove('calc/calc.go');
  }), []);
  const extra = { 'calc/more.go': 'package calc\n\nfunc Sub(a, b int) int { return a - b }\n', 'calc/pkg_test.go': 'package calc\n\nimport "testing"\n\nfunc TestPkg(t *testing.T) {}\n' };
  assert.deepEqual(await goWeakened(t, { extra }, (repo) => {
    for (const file of ['calc/calc.go', 'calc/more.go', 'calc/calc_test.go', 'calc/pkg_test.go']) repo.remove(file);
  }), [], 'the whole package went');
  assert.deepEqual(reasons(await goWeakened(t, { extra }, (repo) => {
    repo.remove('calc/more.go');
    repo.remove('calc/pkg_test.go');
  })), ['calc/pkg_test.go|deleted'], 'the package still has calc.go');
});

test('F2: an added t.Skip and an added testing.Short() guard are weakened skips, named with their line', async (t) => {
  const skip = await goWeakened(t, {}, (repo) => repo.write('calc/calc_test.go', GO_TEST.replace('func TestAdd(t *testing.T) {\n', 'func TestAdd(t *testing.T) {\n\tt.Skip("later")\n')));
  assert.deepEqual(reasons(skip), ['calc/calc_test.go|added-skip']);
  assert.match(skip[0].text, /^calc\/calc_test\.go:6: t\.Skip added/);
  const short = await goWeakened(t, {}, (repo) => repo.write('calc/calc_test.go', GO_TEST.replace('func TestAdd(t *testing.T) {\n', 'func TestAdd(t *testing.T) {\n\tif testing.Short() {\n\t\treturn\n\t}\n')));
  assert.deepEqual(reasons(short), ['calc/calc_test.go|added-skip']);
  assert.match(short[0].text, /testing\.Short\(\) added/);
  const tag = await goWeakened(t, {}, (repo) => repo.write('calc/calc_test.go', `//go:build integration\n\n${GO_TEST}`));
  assert.deepEqual(reasons(tag), ['calc/calc_test.go|added-skip'], 'a build constraint takes the file out of go test');
});

test('F2: a dropped Test function, subtest or t.Fatal call is weakened; err.Error() is no assertion; a kept file is not', async (t) => {
  const dropped = await goWeakened(t, {}, (repo) => repo.write('calc/calc_test.go', GO_TEST.replace('\t\tt.Fatalf("bad")\n', '')));
  assert.deepEqual(reasons(dropped), ['calc/calc_test.go|fewer-assertions']);
  const noSub = await goWeakened(t, {}, (repo) => repo.write('calc/calc_test.go', GO_TEST.replace('t.Run("zero", func(t *testing.T) {', 'func() {').replace('\t})\n}', '\t}()\n}')));
  assert.deepEqual(reasons(noSub), ['calc/calc_test.go|fewer-cases']);
  const errorCall = await goWeakened(t, {}, (repo) => repo.write('calc/calc_test.go', GO_TEST.replace('t.Error(err.Error())', 't.Error(err)')));
  assert.deepEqual(errorCall, [], 'one t.Error before and after: err.Error() never counted');
  const added = await goWeakened(t, {}, (repo) => repo.write('calc/calc_test.go', `${GO_TEST}\nfunc TestMore(t *testing.T) { t.Fatal("x") }\n`));
  assert.deepEqual(added, []);
});

test('F2: a JS test file renamed with git mv is not weakened (the same rename rule), deleted alone it still is', async (t) => {
  const source = "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('a', () => assert.equal(1, 1));\n";
  const renamed = newRepo(t, { files: { 'tests/a.test.mjs': source } });
  git(renamed.dir, 'mv', 'tests/a.test.mjs', 'tests/b.test.mjs');
  assert.deepEqual(weakenedTests(await rangeChange(renamed.dir, renamed.baseSha)), []);
  const deleted = newRepo(t, { files: { 'tests/a.test.mjs': source } });
  deleted.remove('tests/a.test.mjs');
  assert.deepEqual(reasons(weakenedTests(await rangeChange(deleted.dir, deleted.baseSha))), ['tests/a.test.mjs|deleted']);
});
