// Readers for what the checked tools print (design: section 6 parse.mjs, section 5 pass bar): tsc diagnostics, eslint json, vitest and
// jest json (one shape), and node:test TAP. Each reader takes the tool's text and returns { failures, total } or null.
// Exports: parseTsc, parseEslintJson, parseVitestJson, parseJestJson, parseTap.
// Invariants: pure (no file, no process, no clock); `null` means "no result could be read" (empty, cut-off, garbage or the wrong shape),
//   never an empty ok, so the engine can report not-run (error); skipped and todo tests and eslint warnings are never failures; a test
//   file that did not load is one failure of that file; every `file` uses `/` and no `\r`, and the id is `file|code-or-test-name`
//   with no line number, so moving code does not turn an old failure into a new one. Paths are kept as the tool printed them (absolute or
//   relative to its folder); run-checks.mjs makes them repo-relative.

const MAX_TEXT_CHARS = 300; // one reason line stays one line, whatever a tool prints
const TAP_INDENT = 4; // node:test indents nested tests by four spaces
const FILE_FAILED = 'file failed to run';
const TSC_DIAGNOSTIC = /^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/;
const TAP_POINT = /^( *)(not ok|ok) \d+(?: - (.*))?$/;
const TAP_DIRECTIVE = /\s+#\s*(SKIP|TODO)\b.*$/i;

const slashed = (path) => path.replaceAll('\\', '/');
const firstLine = (text) => text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
const oneLine = (text) => firstLine(text).slice(0, MAX_TEXT_CHARS);
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** JSON text to a value, or undefined when it is not JSON (the caller turns that into null: unreadable). */
function readJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // not JSON (empty, cut off, garbage) is an expected input here, answered with null by the callers
  }
}

/**
 * Reads `tsc --pretty false` output: one failure per `file(line,col): error TSnnnn: message` line (continuation lines are dropped).
 * @param {string} text what tsc printed
 * @returns {{ failures: object[], total: number } | null} null when no diagnostic line is in the text
 */
export function parseTsc(text) {
  const failures = [];
  for (const raw of text.split('\n')) {
    const found = TSC_DIAGNOSTIC.exec(raw.replace(/\r$/, ''));
    if (!found) continue;
    const [, rawFile, line, code, rawMessage] = found;
    const file = slashed(rawFile);
    const message = oneLine(rawMessage);
    failures.push({ kind: 'types', id: `${file}|${code}|${message}`, file, line: Number(line), text: `${file}:${line} ${code} ${message}` });
  }
  return failures.length > 0 ? { failures, total: failures.length } : null;
}

const isEslintFile = (entry) => isObject(entry) && typeof entry.filePath === 'string' && Array.isArray(entry.messages)
  && entry.messages.every((message) => isObject(message) && typeof message.severity === 'number');

/**
 * Reads `eslint --format json`: a severity-2 message is a failure only when its line is inside a changed range of its file.
 * @param {string} text what eslint printed
 * @param {(file: string) => [number, number][]} changedLinesOf 1-based inclusive ranges of the lines changed in `file` (the path as eslint printed it, `/` separators)
 * @returns {{ failures: object[], total: number } | null} total = messages of any severity; null when the text is not an eslint result
 */
export function parseEslintJson(text, changedLinesOf) {
  const report = readJson(text);
  if (!Array.isArray(report) || report.length === 0 || !report.every(isEslintFile)) return null;
  const failures = [];
  let total = 0;
  for (const entry of report) {
    const file = slashed(entry.filePath);
    const ranges = changedLinesOf(file);
    for (const message of entry.messages) {
      total += 1;
      const line = typeof message.line === 'number' ? message.line : 1;
      if (message.severity !== 2 || !ranges.some(([from, to]) => line >= from && line <= to)) continue;
      const rule = message.ruleId ?? 'parse-error';
      const detail = oneLine(String(message.message ?? ''));
      failures.push({ kind: 'lint', id: `${file}|${rule}|${detail}`, file, line, text: `${file}:${line} ${rule} ${detail}` });
    }
  }
  return { failures, total };
}

const isTestFile = (entry) => isObject(entry) && typeof entry.name === 'string' && Array.isArray(entry.assertionResults)
  && entry.assertionResults.every(isObject);

/** The reason a whole test file failed: the first message line that is not jest's own heading. */
const fileFailureText = (message) => oneLine(String(message ?? '').split(/\r?\n/).filter((line) => !/^\s*●\s*Test suite failed to run/.test(line)).join('\n')) || FILE_FAILED;

function testResultsFailures(file, entry) {
  const failed = entry.assertionResults.filter((one) => one.status === 'failed');
  if (failed.length === 0) {
    return entry.status === 'failed' ? [{ kind: 'tests', id: `${file}|${FILE_FAILED}`, file, text: `${file}: ${fileFailureText(entry.message)}` }] : [];
  }
  return failed.map((one) => {
    const name = String(one.fullName ?? [...(one.ancestorTitles ?? []), one.title].join(' '));
    const reason = Array.isArray(one.failureMessages) ? oneLine(String(one.failureMessages[0] ?? '')) : '';
    return { kind: 'tests', id: `${file}|${name}`, file, text: reason ? `${name}: ${reason}` : name };
  });
}

function parseTestResultsJson(text) {
  const report = readJson(text);
  if (!isObject(report) || !Array.isArray(report.testResults) || !report.testResults.every(isTestFile)) return null;
  const failures = report.testResults.flatMap((entry) => testResultsFailures(slashed(entry.name), entry));
  const counted = report.testResults.reduce((sum, entry) => sum + entry.assertionResults.length, 0);
  return { failures, total: Number.isInteger(report.numTotalTests) ? report.numTotalTests : counted };
}

/**
 * Reads `vitest --reporter=json`: a failed test is `test file|full name`; a file that did not load is `test file|file failed to run`.
 * @param {string} text the json (the --outputFile content)
 * @returns {{ failures: object[], total: number } | null} total = tests the tool counted (0 = no related test); null when unreadable
 */
export const parseVitestJson = parseTestResultsJson;

/** Reads `jest --json`, which has the same testResults[].assertionResults[] shape as vitest. Same result as {@link parseVitestJson}. */
export const parseJestJson = parseTestResultsJson;

/** The part of a TAP YAML value block that matters: the first line of `error`, the `location` split into file and line. */
function readTapBlock(lines, start, indent) {
  const fields = {};
  let next = start;
  if (lines[start]?.trim() !== '---') return { fields, next };
  for (next = start + 1; next < lines.length && lines[next].trim() !== '...'; next += 1) {
    const found = /^ +(\w+): ?(.*)$/.exec(lines[next]);
    if (!found || lines[next].search(/\S/) !== indent + 2 || found[1] in fields) continue;
    const [, key, value] = found;
    fields[key] = /^\|[-+]?$/.test(value) ? firstLine(lines.slice(next + 1, next + 4).join('\n')) : value.replace(/^'(.*)'$/, '$1');
  }
  return { fields, next };
}

function tapSummary(lines) {
  const count = (word) => { const found = lines.map((line) => new RegExp(`^# ${word} (\\d+)$`).exec(line)).find(Boolean); return found ? Number(found[1]) : null; };
  const tests = count('tests');
  const failed = count('fail');
  return tests === null || failed === null ? null : { tests, failed };
}

/**
 * Reads node:test `--test-reporter=tap` output. A failing test is `test file|suite name test name` (file from its `location`); a suite
 * that failed only because a subtest failed is not counted again; a test file that did not load is `test file|file failed to run`.
 * @param {string} text what the runner printed on stdout
 * @param {string} [fallbackFile] the test file to name when a failing test prints no location (an older node)
 * @returns {{ failures: object[], total: number } | null} total = the runner's own `# tests` count; null when the run has no summary
 */
export function parseTap(text, fallbackFile = '') {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  const summary = tapSummary(lines);
  if (!lines.some((line) => line.startsWith('TAP version')) || !summary) return null;
  const failures = [];
  const suites = [];
  let comments = [];
  for (let i = 0; i < lines.length; i += 1) {
    const subtest = /^( *)# Subtest: (.*)$/.exec(lines[i]);
    if (subtest) { suites.length = Math.floor(subtest[1].length / TAP_INDENT); suites.push(subtest[2]); continue; }
    if (/^# (?!tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)/.test(lines[i])) comments.push(lines[i].slice(2));
    const point = TAP_POINT.exec(lines[i]);
    if (!point) continue;
    const [, indent, status, rawName = ''] = point;
    const { fields, next } = readTapBlock(lines, i + 1, indent.length);
    i = next;
    const name = rawName.replace(TAP_DIRECTIVE, '');
    const skipped = TAP_DIRECTIVE.test(rawName);
    const level = Math.floor(indent.length / TAP_INDENT);
    if (status === 'not ok' && !skipped && fields.failureType !== 'subtestsFailed') {
      failures.push(tapFailure({ name, ancestors: suites.slice(0, level), fields, fallbackFile, level, comments }));
    }
    comments = [];
  }
  return failures.length === 0 && summary.failed > 0 ? null : { failures, total: summary.tests };
}

function tapFailure({ name, ancestors, fields, fallbackFile, level, comments }) {
  const located = /^(.*):(\d+):\d+$/.exec(fields.location ?? '');
  const file = slashed(located ? located[1] : fallbackFile);
  const line = located ? { line: Number(located[2]) } : {};
  const fileLevel = level === 0 && file !== '' && file.endsWith(slashed(name));
  if (fileLevel) {
    const cause = comments.find((comment) => /Error/.test(comment));
    return { kind: 'tests', id: `${file}|${FILE_FAILED}`, file, ...line, text: `${file}: ${oneLine(cause ?? FILE_FAILED)}` };
  }
  const fullName = [...ancestors, name].join(' ');
  return { kind: 'tests', id: `${file}|${fullName}`, file, ...line, text: fields.error ? `${fullName}: ${oneLine(fields.error)}` : fullName };
}
