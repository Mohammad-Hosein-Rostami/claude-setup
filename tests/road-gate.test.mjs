// Tests of road-gate.mjs line 2 and the `<close row>.landed` correction row (STATUS row p8-gate-evidence).
// A fake `run` stands in for git and the tools, so no repo is needed; it records every git argv to show which sha was checked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { gateStep } from '../home/tools/road/lib/road-gate.mjs';

const START = 'a'.repeat(40);
const TO = 'b'.repeat(40);
const OTHER_TO = 'c'.repeat(40);
const DAY = Date.parse('2026-11-20T10:00:00Z');
const ROAD = { road: 'rd', repo: '/repo', base: 'main', steps: [{ lanes: [{ name: 'a', files: ['x.mjs'] }] }] };
const landedText = (to, from = START) => `landed ${to} on main from ${from}`;

const row = (id, evidence, done = DAY) => ({ id, item: `close: ${id}`, started: DAY, done, evidence });
const checkRow = row('rd.s1.check', 'x', null);
const startRow = { ...checkRow, item: `close: step 1 checkpoint, base ${START}` };

/**
 * A fake run: every `to` in `onBase` is a clean, new, first-parent commit of the base; other shas fail the first-parent check.
 * `rev-parse <sha>^{commit}` answers a full sha with itself, a key of `aliases` with its value (null = ambiguous), anything else is unknown.
 */
function fakeRun(onBase, aliases = {}) {
  const calls = [];
  const run = (file, argv) => {
    if (file !== 'git') return { exit: 0, out: '' };
    calls.push(argv.slice(2));
    const [command, ...rest] = argv.slice(2);
    if (command === 'rev-parse') return resolveSha(rest.at(-1), onBase, aliases);
    if (command === 'rev-list') return { exit: 0, out: rest.at(-1).endsWith(`..${onBase.at(-1)}`) && rest.at(-1).startsWith(START) ? onBase.join('\n') : `${rest.at(-1).split('..')[1]}\n` };
    if (command === 'cherry') return { exit: 0, out: '' };
    if (command === 'merge-base') return { exit: rest[1] === START && rest[2] === undefined ? 1 : rest[2] === START ? 1 : 0, out: '' };
    return { exit: 0, out: '' };
  };
  return { run, calls };
}

function resolveSha(arg, onBase, aliases) {
  if (arg.startsWith('refs/heads/')) return { exit: 0, out: `${onBase.at(-1)}\n` };
  const text = arg.replace('^{commit}', '');
  if (text in aliases) return aliases[text] === null ? { exit: 1, out: '' } : { exit: 0, out: `${aliases[text]}\n` };
  return text.length === 40 ? { exit: 0, out: `${text}\n` } : { exit: 1, out: '' };
}

const rangeLine = (result) => result.lines.find((line) => / 2 range/.test(line));
const STEERED_ROAD = { ...ROAD, steps: [{ form: 'agents', lanes: ROAD.steps[0].lanes }] };
const gate = (items, onBase = [TO], { aliases = {}, steered = false } = {}) => {
  const { run, calls } = fakeRun(onBase, aliases);
  const road = steered ? STEERED_ROAD : ROAD;
  return { result: gateStep(road, [startRow, ...items], 1, run, { isUiPath: () => false, checkOn: (category) => steered && category === 'review' }), calls };
};
const cherried = (calls, sha) => calls.some((call) => call[0] === 'cherry' && call.includes(sha));

test('a done close row without a landed line uses its .landed correction row', () => {
  const { result } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', 'merged by hand'), row('rd.s1.a-land.landed', landedText(TO))]);
  assert.match(rangeLine(result), /^PASS 2 range: 1 close rows/);
  assert.equal(result.pass, true);
});

test('the correction row id is matched case-insensitively', () => {
  const { result } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', 'merged by hand'), row('RD.S1.A-LAND.LANDED', landedText(TO))]);
  assert.match(rangeLine(result), /^PASS 2 range/);
});

test('a close row with its own landed line ignores the correction row', () => {
  const { result, calls } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', landedText(TO)), row('rd.s1.a-land.landed', landedText(OTHER_TO))]);
  assert.match(rangeLine(result), /^PASS 2 range: 1 close rows/);
  assert.equal(cherried(calls, OTHER_TO), false);
});

test('a correction row counts for nothing while the close row is not done', () => {
  const { result, calls } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', 'x', null), row('rd.s1.a-land.landed', landedText(TO))]);
  assert.equal(result.pass, false);
  assert.match(rangeLine(result), /^FAIL 2 range: commit .* lies in no close row's range/);
  assert.equal(cherried(calls, TO), false);
});

test('a close row and its correction row are one range, not two', () => {
  const { result } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', 'merged by hand'), row('rd.s1.a-land.landed', landedText(TO))]);
  assert.equal(result.lines.filter((line) => / 2 range/.test(line)).length, 1);
  assert.ok(!result.lines.some((line) => /another close row cites too|overlap/.test(line)), result.lines.join('\n'));
});

test('a fix close row takes its correction row once', () => {
  const { result } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', landedText(TO)), row('rd.s1.fix-b-land', 'by hand'), row('rd.s1.fix-b-land.landed', landedText(OTHER_TO, TO))], [TO, OTHER_TO]);
  assert.match(rangeLine(result), /^PASS 2 range: 2 close rows/);
});

test('a correction row with a bad sha is refused and never reaches git', () => {
  for (const bad of ['landed abcdef on main from ' + START, `landed ${TO.toUpperCase()} on main from ${START}`, `landed ${TO}; rm -rf on main from ${START}`]) {
    const { result, calls } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', 'merged by hand'), row('rd.s1.a-land.landed', bad)]);
    assert.equal(result.pass, false, bad);
    assert.match(rangeLine(result), /^FAIL 2 range: rd\.s1\.a-land has no "landed <to> on <base> from <from>" evidence/, bad);
    assert.equal(cherried(calls, TO), false, bad);
  }
});

test('a correction row that is not done counts for nothing', () => {
  const { result, calls } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', 'merged by hand'), row('rd.s1.a-land.landed', landedText(TO), null)]);
  assert.equal(result.pass, false);
  assert.match(rangeLine(result), /^FAIL 2 range: rd\.s1\.a-land has no "landed/);
  assert.equal(cherried(calls, TO), false);
});

test('a close row written in capitals finds its correction row', () => {
  const { result } = gate([row('rd.s1.a', 'x'), row('RD.S1.A-LAND', 'merged by hand'), row('rd.s1.a-land.landed', landedText(TO))]);
  assert.match(rangeLine(result), /^PASS 2 range/);
});

// "landed within <close row id>": a fix row that landed inside the fast-forward of another close row has no range of its own.
const within = (target) => `landed within ${target}`;
const withinFails = (result) => result.lines.filter((line) => /^FAIL 2 range/.test(line));

test('a fix row that landed within a close row with a range carries no range of its own', () => {
  const { result } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', landedText(TO)), row('rd.s1.fix-b', 'x'), row('rd.s1.fix-b-land', 'by hand'), row('rd.s1.fix-b-land.landed', within('rd.s1.a-land'))]);
  assert.match(rangeLine(result), /^PASS 2 range: 2 close rows, every commit in one range/);
  assert.equal(result.pass, true);
});

test('the named close row may get its range from its own .landed correction row', () => {
  const { result } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', 'by hand'), row('rd.s1.a-land.landed', landedText(TO)), row('rd.s1.fix-b-land', 'by hand'), row('rd.s1.fix-b-land.landed', `done, ${within('RD.S1.A-LAND')}.`)]);
  assert.match(rangeLine(result), /^PASS 2 range: 2 close rows/);
});

test('a within row whose named close row has no range is a FAIL naming both rows', () => {
  const { result } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', 'by hand'), row('rd.s1.fix-b-land', 'by hand'), row('rd.s1.fix-b-land.landed', within('rd.s1.a-land'))]);
  assert.equal(result.pass, false);
  assert.ok(withinFails(result).some((line) => /rd\.s1\.fix-b-land/.test(line) && /rd\.s1\.a-land/.test(line)), result.lines.join('\n'));
});

test('a row that names itself is a FAIL', () => {
  const { result } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', landedText(TO)), row('rd.s1.fix-b-land', 'by hand'), row('rd.s1.fix-b-land.landed', within('rd.s1.fix-b-land'))]);
  assert.equal(result.pass, false);
  assert.ok(withinFails(result).some((line) => /rd\.s1\.fix-b-land.*itself/.test(line)), result.lines.join('\n'));
});

test('a chain of within rows is a FAIL naming the row and the one it names', () => {
  const { result } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', landedText(TO)),
    row('rd.s1.fix-b-land', 'by hand'), row('rd.s1.fix-b-land.landed', within('rd.s1.a-land')),
    row('rd.s1.fix-c-land', 'by hand'), row('rd.s1.fix-c-land.landed', within('rd.s1.fix-b-land'))]);
  assert.equal(result.pass, false);
  assert.ok(withinFails(result).some((line) => /rd\.s1\.fix-c-land/.test(line) && /rd\.s1\.fix-b-land/.test(line)), result.lines.join('\n'));
  assert.ok(!withinFails(result).some((line) => line.startsWith('FAIL 2 range: rd.s1.fix-b-land ')), 'the first link is fine');
});

test('a within row naming an unknown id is a FAIL naming both rows', () => {
  const { result } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', landedText(TO)), row('rd.s1.fix-b-land', 'by hand'), row('rd.s1.fix-b-land.landed', within('rd.s1.nope-land'))]);
  assert.equal(result.pass, false);
  assert.ok(withinFails(result).some((line) => /rd\.s1\.fix-b-land/.test(line) && /rd\.s1\.nope-land/.test(line)), result.lines.join('\n'));
});

test('a within row naming a row that is not a close row is a FAIL', () => {
  const { result } = gate([row('rd.s1.a', landedText(TO)), row('rd.s1.a-land', landedText(TO)), row('rd.s1.fix-b-land', 'by hand'), row('rd.s1.fix-b-land.landed', within('rd.s1.a'))]);
  assert.equal(result.pass, false);
  assert.ok(withinFails(result).some((line) => /rd\.s1\.fix-b-land/.test(line) && /rd\.s1\.a\b/.test(line)), result.lines.join('\n'));
});

test('a within row that is not done counts for nothing', () => {
  const { result } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', landedText(TO)), row('rd.s1.fix-b-land', 'by hand'), row('rd.s1.fix-b-land.landed', within('rd.s1.a-land'), null)]);
  assert.equal(result.pass, false);
  assert.match(rangeLine(result), /^FAIL 2 range: rd\.s1\.fix-b-land has no "landed/);
});

// Row ids are at most 40 characters, so a long close row id `<name>-land` may be corrected under `<name>.landed` instead of `<name>-land.landed`.
const LONG_CLOSE = 'rd.s1.fix-commit-gate-baseline-land';

test('a close row ending in -land finds its correction row under the short id', () => {
  const { result, calls } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', 'by hand'), row('rd.s1.a.landed', landedText(TO))]);
  assert.match(rangeLine(result), /^PASS 2 range: 1 close rows/);
  assert.equal(cherried(calls, TO), true);
});

test('a long fix close row id is corrected under the short id (the correction row in capitals too)', () => {
  const { result } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', landedText(TO)), row(LONG_CLOSE, 'by hand'), row('RD.S1.FIX-COMMIT-GATE-BASELINE.LANDED', within('rd.s1.a-land'))]);
  assert.match(rangeLine(result), /^PASS 2 range: 2 close rows/);
});

test('a correction row under the long id still works when the short id is absent', () => {
  const { result } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', 'by hand'), row('rd.s1.a-land.landed', landedText(TO))]);
  assert.match(rangeLine(result), /^PASS 2 range/);
});

test('a correction row under both ids is a FAIL naming both rows', () => {
  const { result, calls } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', 'by hand'), row('rd.s1.a.landed', landedText(TO)), row('rd.s1.a-land.landed', landedText(TO))]);
  assert.equal(result.pass, false);
  assert.ok(withinFails(result).some((line) => /rd\.s1\.a\.landed/.test(line) && /rd\.s1\.a-land\.landed/.test(line)), result.lines.join('\n'));
  assert.equal(cherried(calls, TO), false);
});

test('a close row id not ending in -land has only the one correction id', () => {
  const { result } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', landedText(TO)), row('rd.s1.fix-b-land', 'by hand'), row('rd.s1.fix.landed', within('rd.s1.a-land'))]);
  assert.match(rangeLine(result), /^FAIL 2 range: rd\.s1\.fix-b-land has no "landed/);
});

// Shas in rows may be 7-40 hex; the gate resolves each one to its full sha once and compares only full shas.
const SHORT_TO = TO.slice(0, 8);
const SHORT_START = START.slice(0, 7);
// True when a git argument is `text` itself or one end of a `x..y` range (a prefix of a full sha does not count).
const usedAsText = (calls, text) => calls.some((call) => call[0] !== 'rev-parse' && call.some((arg) => arg.split('..').includes(text)));

test('a short to and from are resolved to full shas and accepted', () => {
  const { result, calls } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', landedText(SHORT_TO, SHORT_START))], [TO], { aliases: { [SHORT_TO]: TO, [SHORT_START]: START } });
  assert.match(rangeLine(result), /^PASS 2 range: 1 close rows/, result.lines.join('\n'));
  assert.equal(cherried(calls, TO), true);
  assert.equal(usedAsText(calls, SHORT_TO), false, 'a short sha reached a git command other than rev-parse');
  assert.equal(usedAsText(calls, SHORT_START), false);
});

test('a short sha is resolved once per row sha, through rev-parse --verify --quiet with ^{commit}', () => {
  const { calls } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', landedText(SHORT_TO))], [TO], { aliases: { [SHORT_TO]: TO } });
  assert.deepEqual(calls.filter((call) => call[0] === 'rev-parse' && call.includes(`${SHORT_TO}^{commit}`)), [['rev-parse', '--verify', '--quiet', `${SHORT_TO}^{commit}`]]);
});

test('an unknown sha in a row is a FAIL naming the row, and never reaches another git command', () => {
  const { result, calls } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', landedText(SHORT_TO))], [TO]);
  assert.equal(result.pass, false);
  assert.match(rangeLine(result), new RegExp(`^FAIL 2 range: rd\\.s1\\.a-land .*${SHORT_TO}`), result.lines.join('\n'));
  assert.equal(usedAsText(calls, SHORT_TO), false);
});

test('an ambiguous sha in a row is a FAIL naming the row', () => {
  const { result } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', landedText(TO, SHORT_START))], [TO], { aliases: { [SHORT_START]: null } });
  assert.equal(result.pass, false);
  assert.ok(result.lines.some((line) => line.startsWith('FAIL 2 range: rd.s1.a-land') && line.includes(SHORT_START)), result.lines.join('\n'));
});

// A steered (agents-form) step needs "reviewed <sha> clean" on the lane row; a done `<lane row id>.reviewed` row may hold it instead.
const reviewedText = (sha) => `reviewed ${sha} clean`;
const steeredRows = (laneEvidence, ...extra) => [row('rd.s1.a', laneEvidence), row('rd.s1.a-land', landedText(TO)), ...extra];
const reviewCherries = (calls) => calls.filter((call) => call[0] === 'cherry' && call.length === 4);

test('a steered lane without a reviewed line is a FAIL', () => {
  const { result } = gate(steeredRows('x'), [TO], { steered: true });
  assert.match(rangeLine(result), /^FAIL 2 range: rd\.s1\.a has no "reviewed <sha> clean" line/);
});

test('a steered lane takes the reviewed line of its .reviewed correction row', () => {
  const { result, calls } = gate(steeredRows('x', row('rd.s1.a.reviewed', reviewedText(TO))), [TO], { steered: true });
  assert.match(rangeLine(result), /^PASS 2 range: 1 close rows/, result.lines.join('\n'));
  assert.deepEqual(reviewCherries(calls).map((call) => call[1]), [TO]);
});

test('the .reviewed row id is matched case-insensitively', () => {
  const { result } = gate(steeredRows('x', row('RD.S1.A.REVIEWED', reviewedText(TO))), [TO], { steered: true });
  assert.match(rangeLine(result), /^PASS 2 range/);
});

test('the lane row own reviewed line wins over its .reviewed row', () => {
  const { result, calls } = gate(steeredRows(reviewedText(TO), row('rd.s1.a.reviewed', reviewedText(OTHER_TO))), [TO], { steered: true });
  assert.match(rangeLine(result), /^PASS 2 range/);
  assert.deepEqual(reviewCherries(calls).map((call) => call[1]), [TO]);
  assert.equal(usedAsText(calls, OTHER_TO), false);
});

test('a .reviewed row that is not done counts for nothing', () => {
  const { result, calls } = gate(steeredRows('x', row('rd.s1.a.reviewed', reviewedText(TO), null)), [TO], { steered: true });
  assert.match(rangeLine(result), /^FAIL 2 range: rd\.s1\.a has no "reviewed/);
  assert.equal(reviewCherries(calls).length, 0);
});

test('a .reviewed row is not read when the step is not steered', () => {
  const { result, calls } = gate(steeredRows('x', row('rd.s1.a.reviewed', reviewedText(OTHER_TO))), [TO]);
  assert.match(rangeLine(result), /^PASS 2 range/);
  assert.equal(usedAsText(calls, OTHER_TO), false);
});

test('a short reviewed sha is resolved to its full sha; an unknown one is a FAIL naming the lane row', () => {
  const short = gate(steeredRows('x', row('rd.s1.a.reviewed', reviewedText(SHORT_TO))), [TO], { steered: true, aliases: { [SHORT_TO]: TO } });
  assert.match(rangeLine(short.result), /^PASS 2 range/, short.result.lines.join('\n'));
  assert.deepEqual(reviewCherries(short.calls).map((call) => call[1]), [TO]);
  const unknown = gate(steeredRows(reviewedText(SHORT_TO)), [TO], { steered: true });
  assert.equal(unknown.result.pass, false);
  assert.ok(unknown.result.lines.some((line) => line.startsWith('FAIL 2 range: rd.s1.a ') && line.includes(SHORT_TO)), unknown.result.lines.join('\n'));
});

test('a reviewed sha git does not know is not looked up when the step is not steered', () => {
  const { result, calls } = gate(steeredRows(reviewedText(SHORT_TO)), [TO]);
  assert.match(rangeLine(result), /^PASS 2 range/, result.lines.join('\n'));
  assert.equal(calls.some((call) => call.includes(`${SHORT_TO}^{commit}`)), false);
});
