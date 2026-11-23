// Tests of the done-check's Go support (fixes spec, lane go-checks): the readers in lib/go-parse.mjs against output captured from go
// 1.27.4 (tests/fixtures/done-check/go/), the plan of lib/go-plan.mjs through detect.mjs `planChecks`, and whole runs of the
// done-check CLI on throw-away Go modules: gofmt drift, vet type errors and analyzer findings, failing tests and build failures block;
// the same failures at the base are old and do not block; no go on PATH is named not run; a Go repo with no Go change runs nothing.
// Invariants: every module lives in a temp folder with a temp HOME; Go gets its own GOCACHE, GOMODCACHE and GOPATH under a cs-test temp
// folder (never the user's caches), GOTOOLCHAIN=local, GOPROXY=off and empty GOFLAGS, so nothing is downloaded and no user setting
// leaks in. Cases that run go are skipped (with the reason) only on a machine where go is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planChecks } from '../home/tools/done-check/lib/detect.mjs';
import { checkChange } from '../home/tools/done-check/lib/check-change.mjs';
import { goBinary, planGoChecks } from '../home/tools/done-check/lib/go-plan.mjs';
import { excludedPackageDirs, parseGofmtDiff, parseGoTestJson, parseGoVet } from '../home/tools/done-check/lib/go-parse.mjs';
import { rangeChange } from '../home/tools/done-check/lib/scope.mjs';
import { makeDoneCheckRepo } from './done-check-fixture.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const SAMPLES = fileURLToPath(new URL('./fixtures/done-check/go/', import.meta.url));
const CLI = fileURLToPath(new URL('../home/tools/done-check/done-check.mjs', import.meta.url));
const sample = (name) => readFileSync(join(SAMPLES, name), 'utf8');
const ARGV_LIMIT_CHARS = 28_000; // detect.mjs: below the 32 767 characters of a Windows command line
const GO = goBinary(process.env);
const needsGo = { skip: !GO && 'go is not installed' };
const goHome = makeTempDir('go-cache-'); // one cache for the whole file: the first case compiles the standard library, the rest reuse it
const GO_ENV = { GOCACHE: join(goHome, 'build'), GOMODCACHE: join(goHome, 'mod'), GOPATH: join(goHome, 'path'), GOTOOLCHAIN: 'local', GOFLAGS: '', GOPROXY: 'off', GOTELEMETRY: 'off', GOWORK: 'off' };
const GO_MOD = 'module example.com/m\n\ngo 1.22\n';
const PASSING_TEST = 'package a\n\nimport "testing"\n\nfunc TestA(t *testing.T) {\n\tif A() != 1 {\n\t\tt.Fatal("A is not 1")\n\t}\n}\n';
const A_ONE = 'package a\n\nfunc A() int { return 1 }\n';

// ---- the readers, on captured output ----

test('every Go sample is named in its README and holds no machine path', () => {
  const readme = sample('README.md');
  for (const name of readdirSync(SAMPLES).filter((file) => file !== 'README.md')) {
    assert.ok(readme.includes(name), `${name} is not named in go/README.md`);
    assert.doesNotMatch(sample(name), /\/Users\/|\/home\/\w|\/private\/tmp|\/var\/folders|\/opt\/homebrew|scratchpad|Desap/i, name);
  }
});

test('go vet: a type error and an analyzer finding, ids file|vet: message without line numbers; the Windows variant gives the same ids', () => {
  const result = parseGoVet(sample('go-vet-1.27.4.txt'));
  assert.deepEqual(result.failures.map((failure) => failure.id), [
    'vettype/x.go|vet: cannot use "s" (untyped string constant) as int value in return statement',
    'vetan/x.go|vet: fmt.Printf format %d has arg "s" of wrong type string',
  ]);
  assert.deepEqual(result.failures.map((failure) => [failure.kind, failure.line]), [['types', 3], ['types', 5]]);
  const windows = parseGoVet(sample('go-vet-1.27.4-windows.txt'));
  assert.deepEqual(windows.failures.map((failure) => failure.id), result.failures.map((failure) => failure.id));
  assert.ok(windows.failures.every((failure) => !/[\r\\]/.test(failure.id + failure.file + failure.text)));
  assert.equal(parseGoVet(''), null); // nothing printed: the caller decides by the exit code
  assert.equal(parseGoVet('go: cannot find main module\n'), null);
});

test('gofmt -d: each drift hunk is one lint failure, its id the file and a hash of its changed lines only; garbage or a cut hunk is unreadable', () => {
  const text = sample('gofmt-1.27.4-diff.txt');
  const { failures, total } = parseGofmtDiff(text);
  assert.equal(total, 2);
  assert.deepEqual(failures.map((failure) => [failure.kind, failure.file, failure.line, failure.endLine]), [['lint', './fmtbad/x.go', 3, 3], ['lint', './fmtbad/x.go', 11, 13]]);
  assert.ok(failures.every((failure) => /^\.\/fmtbad\/x\.go\|gofmt [0-9a-f]{16}$/.test(failure.id)), failures.map((failure) => failure.id).join());
  // the same drift lower in the file (other line numbers, other context) keeps its id: the base compare matches hunks by content
  const moved = text.replace('@@ -1,6 +1,6 @@\n package fmtbad\n \n', '@@ -40,6 +40,6 @@\n // other\n \n');
  assert.deepEqual(parseGofmtDiff(moved).failures.map((failure) => failure.id), failures.map((failure) => failure.id));
  const firstHunk = text.slice(text.indexOf('@@ -1,6'), text.indexOf('@@ -8'));
  const twice = `${text}${text.endsWith('\n') ? '' : '\n'}${firstHunk}`;
  assert.deepEqual(parseGofmtDiff(twice).failures.map((failure) => failure.id.slice(-2)).filter((end) => end === '#2'), ['#2']); // a repeated hunk is counted, not merged
  assert.deepEqual(parseGofmtDiff(''), { failures: [], total: 0 });
  assert.equal(parseGofmtDiff('./x.go:2:8: expected \')\', found \'EOF\'\n'), null);
  assert.equal(parseGofmtDiff(text.split('\n').slice(0, -3).join('\n')), null); // the last hunk cut off
});

test('go test -json: failing leaf tests, build failures and a panic by package folder; skipped packages are no failure', () => {
  const result = parseGoTestJson(sample('go-test-1.27.4-fail.jsonl'), 'example.com/probe');
  assert.deepEqual(result.failures.map((failure) => failure.id).sort(), [
    'buildfail/|build failed', 'panics/|TestBoom', 'testfail/|TestOne', 'testfail/|TestSub/a_b', 'two words/|build failed',
  ]);
  assert.match(result.failures.find((failure) => failure.id === 'buildfail/|build failed').text, /undefined: y/);
  assert.match(result.failures.find((failure) => failure.id === 'testfail/|TestOne').text, /^TestOne: x_test\.go:7: want 1$/);
  assert.ok(result.total >= 6, `total ${result.total}`);
  assert.deepEqual(parseGoTestJson(sample('go-test-1.27.4-pass.jsonl'), 'example.com/probe'), { failures: [], total: 1, excluded: 0 });
});

test('a package build constraints leave empty is no failure: go test counts it excluded, go vet names its folder', () => {
  const excludedLine = 'package example.com/m/svc: build constraints exclude all Go files in /m/svc';
  const events = [
    { ImportPath: 'example.com/m/svc', Action: 'build-output', Output: '# example.com/m/svc\n' },
    { ImportPath: 'example.com/m/svc', Action: 'build-output', Output: `${excludedLine}\n` },
    { ImportPath: 'example.com/m/svc', Action: 'build-fail' },
    { Action: 'start', Package: 'example.com/m/svc' },
    { Action: 'fail', Package: 'example.com/m/svc', FailedBuild: 'example.com/m/svc' },
  ];
  assert.deepEqual(parseGoTestJson(events.map((event) => JSON.stringify(event)).join('\n'), 'example.com/m'), { failures: [], total: 0, excluded: 1 });
  assert.deepEqual(excludedPackageDirs(`${excludedLine}\npackage example.com/m: build constraints exclude all Go files in /m\n`, 'example.com/m'), ['svc', '']);
  assert.deepEqual(excludedPackageDirs('a/a.go:5:2: unreachable code\n', 'example.com/m'), []);
});

test('go test -json: a cut-off stream, a line that is not JSON or an empty stream is unreadable (null), never a pass', () => {
  const lines = sample('go-test-1.27.4-pass.jsonl').trimEnd().split('\n');
  assert.equal(parseGoTestJson(lines.slice(0, -1).join('\n'), 'example.com/probe'), null); // the package never ended: killed
  assert.equal(parseGoTestJson(`${lines.join('\n')}\npanic: boom\n`, 'example.com/probe'), null);
  assert.equal(parseGoTestJson('', 'example.com/probe'), null);
});

// ---- the plan ----

/** A plain folder tree (not git) with `files`, and a Scope over `changed` built by hand. */
function planOf(files, changed, { env = process.env, wide = [], named = [] } = {}) {
  const top = realpathSync(makeTempDir('go-plan-'));
  for (const [file, text] of Object.entries(files)) { mkdirSync(dirname(join(top, file)), { recursive: true }); writeFileSync(join(top, file), text); }
  const scope = { top, git: false, base: null, files: changed, wide, named, key: 'k' };
  return { top, scope, plan: planChecks(scope, { ...env, HOME: join(top, '.home') }) };
}
const goCmds = (plan) => plan.packages.flatMap((entry) => entry.cmds).filter((cmd) => cmd.parse);
const argsOf = (plan, parse) => goCmds(plan).filter((cmd) => cmd.parse === parse).flatMap((cmd) => cmd.argv.slice(parse === 'go-test' ? 3 : 2));

test('plan: vet and test of the changed package folders, gofmt of the changed files, no JS check named for a Go-only change', needsGo, (t) => {
  const { plan } = planOf({ 'go.mod': GO_MOD, 'a/a.go': A_ONE, 'b/b.go': 'package b\n' }, ['a/a.go', 'b/b.go']);
  assert.deepEqual(argsOf(plan, 'go-vet'), ['./a', './b']);
  assert.deepEqual(argsOf(plan, 'go-test'), ['./a', './b']);
  assert.deepEqual(argsOf(plan, 'gofmt'), ['./a/a.go', './b/b.go']);
  assert.deepEqual(plan.skipped, []);
  assert.equal(goCmds(plan).find((cmd) => cmd.parse === 'go-test').goModule, 'example.com/m');
});

test('plan: no go on PATH names types, lint and tests not run (go-not-installed) and runs nothing', (t) => {
  const { plan } = planOf({ 'go.mod': GO_MOD, 'a/a.go': A_ONE }, ['a/a.go'], { env: { PATH: '' } });
  assert.deepEqual(goCmds(plan), []);
  assert.deepEqual(plan.skipped, ['types', 'lint', 'tests'].map((kind) => ({ kind, why: 'go-not-installed', label: `${kind}: go: not installed` })));
});

test('plan: go without a gofmt beside it or on PATH names lint not run (gofmt-not-installed)', { skip: process.platform === 'win32' && 'a POSIX script stands in for go' }, (t) => {
  const bin = makeTempDir('go-only-bin-');
  writeFileSync(join(bin, 'go'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const { plan } = planOf({ 'go.mod': GO_MOD, 'a/a.go': A_ONE }, ['a/a.go'], { env: { PATH: bin } });
  assert.deepEqual(plan.skipped, [{ kind: 'lint', why: 'gofmt-not-installed', label: 'lint: gofmt: not installed' }]);
  assert.deepEqual(goCmds(plan).map((cmd) => cmd.parse), ['go-vet', 'go-test']);
});

test('plan: a vendor-only change runs no Go command and says so', needsGo, (t) => {
  const { plan } = planOf({ 'go.mod': GO_MOD, 'a/a.go': A_ONE, 'vendor/x/y/y.go': 'package y\n' }, ['vendor/x/y/y.go']);
  assert.deepEqual(goCmds(plan), []);
  assert.deepEqual(plan.skipped, [{ kind: 'tests', why: 'no-related', label: 'go: only vendor/ changed (never run)' }]);
});

test('plan: a changed testdata or embedded file tests the nearest folder of .go files, with no vet and no gofmt', needsGo, (t) => {
  const files = { 'go.mod': GO_MOD, 'a/a.go': A_ONE, 'a/testdata/in.json': '{}', 'store/store.go': 'package store\n', 'store/sql/q.sql': 'select 1;', 'README.md': '# m\n' };
  const { plan, scope } = planOf(files, [], { named: ['a/testdata/in.json', 'store/sql/q.sql'] });
  assert.deepEqual(argsOf(plan, 'go-test'), ['./a', './store']);
  assert.deepEqual([...argsOf(plan, 'go-vet'), ...argsOf(plan, 'gofmt')], []);
  assert.equal(planGoChecks({ top: scope.top, env: process.env, inGroups: () => [] }, { ...scope, named: ['README.md'] }).packages.length, 0); // docs are no Go data
});

test('plan: a go.mod change vets and tests the whole module (./...)', needsGo, (t) => {
  const { plan } = planOf({ 'go.mod': GO_MOD, 'a/a.go': A_ONE }, [], { wide: ['go.mod'] });
  assert.deepEqual(argsOf(plan, 'go-vet'), ['./...']);
  assert.deepEqual(argsOf(plan, 'go-test'), ['./...']);
});

test('plan: hostile names never become flags or break the argv; a name with a line feed is named, not passed', needsGo, (t) => {
  const odd = process.platform === 'win32' ? ['-x/-y.go', "sp ace/q'uote.go"] : ['-x/-y.go', `sp ace/q'u"ote.go`];
  const files = { 'go.mod': GO_MOD, [odd[0]]: 'package x\n', [odd[1]]: 'package s\n', ...(process.platform === 'win32' ? {} : { 'nl/a\nb.go': 'package nl\n' }) };
  const { plan } = planOf(files, Object.keys(files).filter((file) => file.endsWith('.go')));
  for (const parse of ['go-vet', 'gofmt', 'go-test']) assert.ok(argsOf(plan, parse).every((arg) => arg.startsWith('./') && !arg.includes('\n')), parse);
  assert.ok(argsOf(plan, 'gofmt').includes('./-x/-y.go'));
  if (process.platform !== 'win32') assert.ok(plan.skipped.some((entry) => /control character/.test(entry.label)));
});

test('plan: a change of 500 packages is split into argv groups under the command-line limit', needsGo, (t) => {
  const files = { 'go.mod': GO_MOD };
  const longName = 'a-folder-name-long-enough-that-five-hundred-of-them-pass-the-command-line-limit';
  for (let index = 0; index < 500; index += 1) files[`packages/${longName}-${index}/f.go`] = 'package p\n';
  const { plan } = planOf(files, Object.keys(files).filter((file) => file.endsWith('.go')));
  const vets = goCmds(plan).filter((cmd) => cmd.parse === 'go-vet');
  assert.ok(vets.length > 1);
  assert.ok(goCmds(plan).every((cmd) => cmd.argv.reduce((sum, arg) => sum + arg.length + 1, 0) <= ARGV_LIMIT_CHARS));
  assert.equal(argsOf(plan, 'go-vet').length, 500);
});

test('plan: a JS-only change is handed to the JS planner as the very same Scope', (t) => {
  const scope = { top: realpathSync(makeTempDir('go-plan-js-')), git: false, base: null, files: ['src/a.ts'], wide: ['package.json'], named: [], key: 'k' };
  assert.equal(planGoChecks({ top: scope.top, env: process.env, inGroups: () => [] }, scope).rest, scope);
});

// ---- whole runs on a Go module ----

/** A git Go module with `base` committed (the base) and `change` committed on top; returns the repo. */
function goRepo(t, base, change) {
  const repo = makeDoneCheckRepo({ files: { 'go.mod': GO_MOD, ...base } });
  t.after(() => repo.cleanup());
  for (const [file, text] of Object.entries(change)) repo.write(file, text);
  repo.commit('change');
  return repo;
}
function runCli(repo, extraEnv = {}) {
  const ran = repo.run(CLI, ['run', '--worktree', repo.dir, '--base', repo.baseSha, '--json'], { env: { ...GO_ENV, ...extraEnv } });
  return { code: ran.status, verdict: JSON.parse(ran.stdout), stderr: ran.stderr };
}

test('run: a new unformatted file blocks with a lint failure', needsGo, (t) => {
  const repo = goRepo(t, { 'a/a.go': A_ONE }, { 'b/b.go': 'package b\nfunc  B() int {return 2}\n' });
  const { code, verdict } = runCli(repo);
  assert.equal(code, 1, verdict.line);
  assert.equal(verdict.row.checks.lint.result, 'fail');
  assert.match(verdict.reason, /b\/b\.go: not gofmt-formatted/);
});

test('run: a vet type error and a vet analyzer finding block as types failures', needsGo, (t) => {
  const repo = goRepo(t, { 'a/a.go': A_ONE }, { 'a/a.go': 'package a\n\nimport "fmt"\n\nfunc A() int { fmt.Printf("%d\\n", "s"); return 1 }\n', 'b/b.go': 'package b\n\nfunc B() int { return "s" }\n' });
  const { code, verdict } = runCli(repo);
  assert.equal(code, 1, verdict.line);
  assert.equal(verdict.row.checks.types.new, 2, verdict.line);
  assert.match(verdict.reason, /a\/a\.go:5 vet: fmt\.Printf format %d has arg "s" of wrong type string/);
  assert.match(verdict.reason, /b\/b\.go:3 vet: cannot use "s"/);
});

test('run: a failing test and a package that does not build block as tests failures', needsGo, (t) => {
  const repo = goRepo(t, { 'a/a.go': A_ONE, 'a/a_test.go': PASSING_TEST }, { 'a/a.go': 'package a\n\nfunc A() int { return 2 }\n', 'c/c.go': 'package c\n\nfunc C() int { return y }\n', 'c/c_test.go': 'package c\n\nimport "testing"\n\nfunc TestC(t *testing.T) { C() }\n' });
  const { code, verdict } = runCli(repo);
  assert.equal(code, 1, verdict.line);
  assert.match(verdict.reason, /a\/: TestA: a_test\.go:7: A is not 1/);
  assert.match(verdict.reason, /c\/: build failed: c\/c\.go:3:\d+: undefined: y/);
});

test('run: failures the base already has are old, listed and never block', needsGo, (t) => {
  // `unreachable` is a go vet analyzer that go test's own vet subset does not run, so b fails vet only (printf would fail go test too)
  const broken = { 'a/a.go': 'package a\nfunc  A() int { return 2 }\n', 'a/a_test.go': PASSING_TEST, 'b/b.go': 'package b\n\nfunc B() int {\n\treturn 1\n\treturn 2\n}\n' };
  const repo = goRepo(t, broken, { 'a/a.go': `${broken['a/a.go']}\n// touched\n`, 'b/b.go': `${broken['b/b.go']}\n// touched\n` });
  const { code, verdict } = runCli(repo);
  assert.equal(code, 0, `${verdict.line}\n${verdict.reason}`);
  assert.equal(verdict.verdict, 'ok');
  for (const kind of ['types', 'lint', 'tests']) assert.deepEqual([verdict.row.checks[kind].result, verdict.row.checks[kind].new, verdict.row.checks[kind].old], ['ok', 0, 1], kind);
  assert.match(verdict.line, /types ok, 1 old fail · lint ok, 1 old fail · tests ok, 1 old fail/);
});

test('run: a Go repo whose change holds no Go file, go.mod or Go data runs nothing (no code change)', needsGo, (t) => {
  const repo = goRepo(t, { 'a/a.go': A_ONE }, { 'README.md': '# module\n', 'docs/notes.md': 'notes\n' });
  const { code, verdict } = runCli(repo);
  assert.equal(code, 0);
  assert.equal(verdict.line, 'checks: no code change');
});

test('run: no go on PATH shows types, lint and tests not run, never ok, and does not block', needsGo, async (t) => {
  const repo = goRepo(t, { 'a/a.go': A_ONE }, { 'a/a.go': 'package a\nfunc  A() int { return 2 }\n' });
  // only the plan reads this env (git still runs from this process's PATH): an empty PATH folder is a machine without go
  const verdict = await checkChange(rangeChange(repo.dir, repo.baseSha), { where: 'manual', env: { ...repo.env, PATH: makeTempDir('go-path-') } });
  assert.equal(verdict.verdict, 'ok');
  for (const kind of ['types', 'lint', 'tests']) assert.deepEqual([verdict.row.checks[kind].result, verdict.row.checks[kind].why], ['not-run', 'go-not-installed'], kind);
  assert.match(verdict.line, /types not run \(go: not installed\) · lint not run \(go: not installed\) · tests not run \(go: not installed\)/);
});

// ---- build constraints (goprobe2) ----

const OTHER_OS = process.platform === 'win32' ? 'linux' : 'windows';
const OTHER_OS_PACKAGE = { [`svc/svc_${OTHER_OS}.go`]: `//go:build ${OTHER_OS}\n\npackage svc\n\nfunc S() int { return 1 }\n` };
const TAGGED_TEST_PACKAGE = { 'integ/integ_test.go': '//go:build integration\n\npackage integ\n\nimport "testing"\n\nfunc TestI(t *testing.T) {}\n' };

test('run: a new package built only on another OS or under a tag is valid Go and does not block', needsGo, (t) => {
  const repo = goRepo(t, { 'a/a.go': A_ONE }, { ...OTHER_OS_PACKAGE, ...TAGGED_TEST_PACKAGE });
  const { code, verdict } = runCli(repo);
  assert.equal(code, 0, `${verdict.line}\n${verdict.reason}`);
  assert.deepEqual([verdict.row.checks.types.result, verdict.row.checks.tests.result], ['none', 'none'], verdict.line);
});

test('run: go vet still vets the other folders when one is left empty by build constraints', needsGo, (t) => {
  const repo = goRepo(t, { 'a/a.go': A_ONE }, { ...OTHER_OS_PACKAGE, 'b/b.go': 'package b\n\nfunc B() int {\n\treturn 1\n\treturn 2\n}\n' });
  const { code, verdict } = runCli(repo);
  assert.equal(code, 1, verdict.line);
  assert.equal(verdict.row.checks.types.new, 1, verdict.line);
  assert.match(verdict.reason, /b\/b\.go:5 vet: unreachable code/);
  assert.doesNotMatch(verdict.reason, /build constraints/);
});

const OLD_DRIFT = 'package a\n\nfunc  A() int { return 1 }\n';

test('run: new gofmt drift next to old drift in the same file blocks (goprobe5: gofmt joins them into one hunk)', needsGo, (t) => {
  const repo = goRepo(t, { 'a/a.go': OLD_DRIFT }, { 'a/a.go': `${OLD_DRIFT}\nfunc   B() int {return 2}\n` });
  const { code, verdict } = runCli(repo);
  assert.equal(code, 1, verdict.line);
  assert.deepEqual([verdict.row.checks.lint.result, verdict.row.checks.lint.new], ['fail', 1], verdict.line);
});

test('run: new gofmt drift far from old drift blocks alone; the old hunk stays old', needsGo, (t) => {
  const repo = goRepo(t, { 'a/a.go': OLD_DRIFT }, { 'a/a.go': `${OLD_DRIFT}${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `\n// note ${n}`).join('')}\n\nfunc   B() int {return 2}\n` });
  const { code, verdict } = runCli(repo);
  assert.equal(code, 1, verdict.line);
  assert.deepEqual([verdict.row.checks.lint.result, verdict.row.checks.lint.new, verdict.row.checks.lint.old], ['fail', 1, 1], verdict.line);
  assert.match(verdict.reason, /a\/a\.go: not gofmt-formatted at line 14/);
});
