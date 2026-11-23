// Readers for what the Go tools print (fixes spec section 7, go-checks): `go vet` diagnostics (stderr), the drift hunks of `gofmt -d`, and
// the event stream of `go test -json`. Same contract as parse.mjs: each reader takes the tool's text and returns { failures, total } or null.
// Exports: parseGoVet, parseGofmtDiff, parseGoTestJson, excludedPackageDirs.
// A package whose every file is left out by a build constraint on this machine (`//go:build windows`, `_linux.go`, a tag such as
//   `integration`) is valid Go that this machine does not build: go names it `build constraints exclude all Go files` when it is named on
//   the command line (`./...` skips it silently). That is never a failure: go test's reader leaves it out (counted in `excluded`), and
//   excludedPackageDirs finds it in go vet's output so the engine vets the other folders again without it.
// Invariants: pure (no file, no process, no clock); `null` means "no result could be read" (garbage, the wrong shape, a cut-off stream),
//   never an empty ok, so the engine reports not-run (error). Ids are `file|name` with no line number: `<file>|vet: <message>` for vet,
//   `<file>|gofmt <hash of the hunk's changed lines>` per gofmt drift hunk, `<package dir>/|<Test/sub>`, `<package dir>/|build failed` and `<package dir>/|package failed` for go test.
//   Every `file` uses `/` and holds no `\r`; paths are kept as the tool printed them (relative to the module folder the command ran in, or
//   absolute), and run-checks.mjs makes them repo-relative. A skipped test is never a failure.
import { createHash } from 'node:crypto';

const MAX_TEXT_CHARS = 300; // one reason line stays one line, whatever a tool prints
const VET_DIAGNOSTIC = /^(?:vet: )?(.+?):(\d+)(?::\d+)?: (.+)$/; // `vet: file:l:c: msg` (a type error) or `file:l:c: msg` (an analyzer)
const PACKAGE_HEADER = /^# /; // go vet and the go build output name the package on a line of its own
const TEST_FRAME = /^\s*(?:=== (?:RUN|PAUSE|CONT|NAME)|--- (?:FAIL|PASS|SKIP))\b/; // go test's own framing lines, not a test's message
const BUILD_FAILED = 'build failed';
const PACKAGE_FAILED = 'package failed';
// gofmt -d: `diff a.go.orig a.go`, `--- a.go.orig`, `+++ a.go`, `@@ -a,b +c,d @@` (a count of 1 is left out), `\ No newline at end of file`
const DIFF_HEADER = /^diff /;
const OLD_NAME = /^--- /;
const NEW_NAME = /^\+\+\+ (.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
const NO_NEWLINE = /^\\ /;
const HUNK_ID_CHARS = 16;
// go's text for a package with no file left for this GOOS, GOARCH and tag set (go/build's NoGoError with ignored files)
const ALL_EXCLUDED = /^package (\S+): build constraints exclude all Go files in /;
const PACKAGE_END_ACTIONS = new Set(['pass', 'fail', 'skip']);
const TEST_END_ACTIONS = new Set(['pass', 'fail', 'skip']);

const slashed = (path) => path.replaceAll('\\', '/');
const oneLine = (text) => (text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '').slice(0, MAX_TEXT_CHARS);
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const linesOf = (text) => text.split('\n').map((line) => line.replace(/\r$/, ''));

/**
 * Reads what `go vet` prints on stderr: one failure per diagnostic line (`vet: file:l:c: msg` or `file:l:c: msg`); package headers
 * (`# pkg`) and continuation lines are dropped.
 * @param {string} text what go vet printed (stderr)
 * @returns {{ failures: object[], total: number } | null} null when no diagnostic line is in the text (the caller decides by the exit code)
 */
export function parseGoVet(text) {
  const failures = [];
  for (const line of linesOf(text)) {
    if (PACKAGE_HEADER.test(line) || /^\s/.test(line)) continue;
    const found = VET_DIAGNOSTIC.exec(line);
    if (!found) continue;
    const [, rawFile, lineNumber, rawMessage] = found;
    const file = slashed(rawFile);
    const message = oneLine(rawMessage);
    failures.push({ kind: 'types', id: `${file}|vet: ${message}`, file, line: Number(lineNumber), text: `${file}:${lineNumber} vet: ${message}` });
  }
  return failures.length > 0 ? { failures, total: failures.length } : null;
}

/** One drift hunk as a failure: its id hashes only the lines gofmt removes and adds (never the line numbers or the context). */
function hunkFailure(hunk, seen) {
  const hash = createHash('sha256').update(hunk.changed.join('\n')).digest('hex').slice(0, HUNK_ID_CHARS);
  const count = (seen.get(`${hunk.file}|${hash}`) ?? 0) + 1;
  seen.set(`${hunk.file}|${hash}`, count);
  const id = `${hunk.file}|gofmt ${hash}${count > 1 ? `#${count}` : ''}`;
  return { kind: 'lint', id, file: hunk.file, line: hunk.first, endLine: hunk.last, text: `not gofmt-formatted at line ${hunk.first} (gofmt -w fixes it)` };
}

/** Adds one line of a hunk body to `hunk`; false when the line is not a body line. */
function addHunkLine(hunk, line) {
  const mark = line[0];
  if (mark === ' ' || mark === '-') hunk.oldLeft -= 1;
  if (mark === ' ' || mark === '+') hunk.newLeft -= 1;
  if (mark === ' ') { hunk.oldLine += 1; return true; }
  if (mark !== '-' && mark !== '+') return false;
  hunk.changed.push(line);
  hunk.first ??= Math.max(1, hunk.oldLine - (mark === '+' ? 1 : 0));
  hunk.last = Math.max(hunk.first, hunk.oldLine - (mark === '+' ? 1 : 0));
  if (mark === '-') hunk.oldLine += 1;
  return true;
}

/**
 * Reads what `gofmt -d` prints on stdout: per file a unified diff (`diff`, `---`, `+++ <file>` lines, then `@@ -a,b +c,d @@` hunks).
 * Each hunk is one drift, so drift a change adds to a file that had some already is a failure of its own (base-compare.mjs).
 * @param {string} text what gofmt printed (stdout); empty when every file is formatted
 * @returns {{ failures: object[], total: number } | null} ids `<file>|gofmt <hash>` (`#2`... for a repeated identical hunk), `line` and
 *   `endLine` the hunk's changed lines in the file; null when a line fits no diff part (an error text on stdout) or a hunk is cut off
 */
export function parseGofmtDiff(text) {
  const hunks = [];
  let file = null;
  let hunk = null;
  for (const line of linesOf(text)) {
    if (hunk !== null && (hunk.oldLeft > 0 || hunk.newLeft > 0)) {
      if (!addHunkLine(hunk, line)) return null;
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header && file !== null) {
      hunk = { file, changed: [], first: null, last: null, oldLine: Number(header[1]), oldLeft: Number(header[2] ?? 1), newLeft: Number(header[3] ?? 1) };
      hunks.push(hunk);
    } else if (NEW_NAME.test(line)) file = slashed(NEW_NAME.exec(line)[1]);
    else if (line !== '' && !DIFF_HEADER.test(line) && !OLD_NAME.test(line) && !NO_NEWLINE.test(line)) return null;
  }
  if (hunk !== null && (hunk.oldLeft > 0 || hunk.newLeft > 0)) return null;
  const seen = new Map();
  const failures = hunks.filter((one) => one.changed.length > 0).map((one) => hunkFailure(one, seen));
  return { failures, total: failures.length };
}

/** The events of a `go test -json` stream, or null when a line is not a JSON object (a cut-off or foreign stream). */
function eventsOf(text) {
  const events = [];
  for (const line of linesOf(text)) {
    if (line.trim() === '') continue;
    try {
      const event = JSON.parse(line);
      if (!isObject(event)) return null;
      events.push(event);
    } catch {
      return null; // a line that is not JSON: the stream is not go test's, or was cut mid-line
    }
  }
  return events;
}

/** The package folder (relative to the module, '' for the module root) of an import path, for the id's `<dir>/` part. */
function packageDirOf(importPath, modulePath) {
  if (modulePath !== '' && importPath === modulePath) return '';
  if (modulePath !== '' && importPath.startsWith(`${modulePath}/`)) return importPath.slice(modulePath.length + 1);
  if (importPath === '.' || importPath === './') return '';
  return importPath.startsWith('./') ? importPath.slice(2) : importPath;
}

const dirPart = (dir) => (dir === '' ? './' : `${slashed(dir)}/`);

/** Per package: started, ended (and how), failed tests with their first message line, the build output. */
function packagesOf(events) {
  const packages = new Map();
  const packageOf = (name) => {
    if (!packages.has(name)) packages.set(name, { started: false, end: null, failedBuild: false, tests: new Map(), messages: new Map(), counted: 0, buildText: '' });
    return packages.get(name);
  };
  const buildOutput = new Map(); // ImportPath (`pkg [pkg.test]` for a test build) -> first error line
  for (const event of events) {
    if (typeof event.Action !== 'string') return null;
    if (event.Action === 'build-output' && typeof event.ImportPath === 'string' && typeof event.Output === 'string') {
      const line = oneLine(event.Output);
      if (line !== '' && !PACKAGE_HEADER.test(line) && !buildOutput.has(event.ImportPath)) buildOutput.set(event.ImportPath, line);
      continue;
    }
    if (typeof event.Package !== 'string') continue; // build-fail and other events without a package carry nothing more
    const pkg = packageOf(event.Package);
    if (typeof event.Test === 'string') addTestEvent(pkg, event);
    else if (event.Action === 'start') pkg.started = true;
    else if (PACKAGE_END_ACTIONS.has(event.Action)) {
      pkg.end = event.Action;
      if (typeof event.FailedBuild === 'string') { pkg.failedBuild = true; pkg.buildText = buildOutput.get(event.FailedBuild) ?? ''; }
    }
  }
  return packages;
}

function addTestEvent(pkg, event) {
  if (event.Action === 'output' && typeof event.Output === 'string' && event.OutputType !== 'frame' && !TEST_FRAME.test(event.Output)) {
    const line = oneLine(event.Output);
    if (line !== '' && !pkg.messages.has(event.Test)) pkg.messages.set(event.Test, line);
  }
  if (TEST_END_ACTIONS.has(event.Action)) {
    pkg.counted += 1;
    pkg.tests.set(event.Test, event.Action);
  }
}

/** The failures of one package: its failed leaf tests (a parent that failed only through a subtest is not counted again), else the package. */
function packageFailures(name, pkg, modulePath) {
  const file = dirPart(packageDirOf(name, modulePath));
  const failed = [...pkg.tests].filter(([, action]) => action === 'fail').map(([test]) => test);
  const leaves = failed.filter((test) => !failed.some((other) => other.startsWith(`${test}/`)));
  if (leaves.length > 0) {
    return leaves.map((test) => {
      const message = pkg.messages.get(test);
      return { kind: 'tests', id: `${file}|${test}`, file, text: message ? `${test}: ${message}` : test };
    });
  }
  if (pkg.end !== 'fail') return [];
  const what = pkg.failedBuild ? BUILD_FAILED : PACKAGE_FAILED;
  const detail = pkg.failedBuild ? pkg.buildText : '';
  return [{ kind: 'tests', id: `${file}|${what}`, file, text: detail ? `${what}: ${detail}` : what }];
}

/**
 * Reads the `go test -json` event stream (stdout). A failing test is `<package dir>/|<Test/sub>`; a package that did not build is
 * `<package dir>/|build failed`; a package that failed with no failing test (a panic outside a test, TestMain, a timeout) is
 * `<package dir>/|package failed`. A package whose files build constraints all leave out is no failure (see the header).
 * @param {string} text the JSON lines go test printed
 * @param {string} [modulePath] the module path of go.mod, so an import path becomes a folder of the module ('' leaves `./x` paths only)
 * @returns {{ failures: object[], total: number, excluded: number } | null} total = tests that ended (pass, fail or skip; 0 = no test
 *   ran); excluded = packages left out by build constraints (go exits 1 for them); null when a line is not JSON, the stream is empty, or a
 *   package started but never ended (a killed or crashed run)
 */
export function parseGoTestJson(text, modulePath = '') {
  const events = eventsOf(text);
  if (events === null || events.length === 0) return null;
  const packages = packagesOf(events);
  if (packages === null || packages.size === 0) return null;
  if ([...packages.values()].some((pkg) => pkg.end === null)) return null; // started (or ran tests) but never ended: cut off
  const isExcluded = (pkg) => pkg.end === 'fail' && pkg.failedBuild && pkg.tests.size === 0 && ALL_EXCLUDED.test(pkg.buildText);
  const built = [...packages].filter(([, pkg]) => !isExcluded(pkg));
  const failures = built.flatMap(([name, pkg]) => packageFailures(name, pkg, modulePath));
  const total = built.reduce((sum, [, pkg]) => sum + pkg.counted, 0);
  return { failures, total, excluded: packages.size - built.length };
}

/**
 * The package folders go vet (or go build) named as left out by build constraints, from what it printed.
 * @param {string} text go vet's output (stderr)
 * @param {string} modulePath the module path of go.mod ('' keeps the import path as it is)
 * @returns {string[]} module-relative folders with `/` ('' for the module root), in the order printed
 */
export function excludedPackageDirs(text, modulePath) {
  return linesOf(text).map((line) => ALL_EXCLUDED.exec(line)?.[1]).filter((name) => name !== undefined).map((name) => packageDirOf(name, modulePath));
}
