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
function fakeRun(onBase, aliases = {}, unreviewed = '', reviewExit = 0) {
  const calls = [];
  const run = (file, argv) => {
    if (file !== 'git') return { exit: 0, out: '' };
    calls.push(argv.slice(2));
    const [command, ...rest] = argv.slice(2);
    if (command === 'rev-parse') return resolveSha(rest.at(-1), onBase, aliases);
    if (command === 'rev-list') return { exit: 0, out: rest.at(-1).endsWith(`..${onBase.at(-1)}`) && rest.at(-1).startsWith(START) ? onBase.join('\n') : `${rest.at(-1).split('..')[1]}\n` };
    if (command === 'cherry') return rest.length === 3 ? { exit: reviewExit, out: unreviewed } : { exit: 0, out: '' };
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
const gate = (items, onBase = [TO], { aliases = {}, steered = false, unreviewed = '', reviewExit = 0, road = steered ? STEERED_ROAD : ROAD } = {}) => {
  const { run, calls } = fakeRun(onBase, aliases, unreviewed, reviewExit);
  return { result: gateStep(road, [startRow, ...items], 1, run, { isUiPath: () => false, checkOn: (category) => category === 'review' && road.steps[0].form === 'agents' }), calls };
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
  const { result } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', 'by hand'), row('rd.s1.a-land.landed', landedText(TO)), row('rd.s1.fix-b-land', 'by hand'), row('rd.s1.fix-b-land.landed', `${within('RD.S1.A-LAND')}.`)]);
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
  assert.ok(withinFails(result).some((line) => /rd\.s1\.fix-b-land.*cannot name itself/.test(line)), result.lines.join('\n'));
});

test('a chain of within rows is a FAIL naming the row and the one it names', () => {
  const { result } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', landedText(TO)),
    row('rd.s1.fix-b-land', 'by hand'), row('rd.s1.fix-b-land.landed', within('rd.s1.a-land')),
    row('rd.s1.fix-c-land', 'by hand'), row('rd.s1.fix-c-land.landed', within('rd.s1.fix-b-land'))]);
  assert.equal(result.pass, false);
  assert.ok(withinFails(result).some((line) => /rd\.s1\.fix-c-land/.test(line) && /rd\.s1\.fix-b-land/.test(line) && /no chains/.test(line)), result.lines.join('\n'));
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

// Own-line guards: a close row with its own landed line never reads its correction rows.
test('a close row with its own landed line ignores a within correction row naming nothing', () => {
  const { result } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', landedText(TO)), row('rd.s1.a-land.landed', within('rd.s1.nope-land'))]);
  assert.match(rangeLine(result), /^PASS 2 range: 1 close rows/, result.lines.join('\n'));
});

test('a close row with its own landed line ignores correction rows under both ids', () => {
  const { result } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', landedText(TO)), row('rd.s1.a.landed', landedText(OTHER_TO)), row('rd.s1.a-land.landed', landedText(OTHER_TO))]);
  assert.match(rangeLine(result), /^PASS 2 range: 1 close rows/, result.lines.join('\n'));
});

test('a correction row holding a landed line and a within text is read as its landed line', () => {
  const { result } = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', 'by hand'), row('rd.s1.a-land.landed', `${landedText(TO)}; ${within('rd.s1.nope-land')}`)]);
  assert.match(rangeLine(result), /^PASS 2 range: 1 close rows/, result.lines.join('\n'));
});

test('two done .reviewed rows for one lane row are a FAIL, never silently the first', () => {
  const road = { ...ROAD, steps: [{ form: 'agents', lanes: [{ name: 'x-land', files: ['x.mjs'] }] }] };
  const { result } = gate([row('rd.s1.x-land', 'x'), row('rd.s1.x-land-land', landedText(TO)), row('rd.s1.x-land.reviewed', reviewedText(TO)), row('rd.s1.x.reviewed', reviewedText(TO))], [TO], { road });
  assert.match(rangeLine(result), /^FAIL 2 range: rd\.s1\.x-land has no "reviewed/, result.lines.join('\n'));
});

// A sha that git resolves through a ref (a branch or tag named like hex) is not the commit the row names.
test('a row sha that resolves to a commit with another prefix is a FAIL naming the row', () => {
  const landed = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', landedText(SHORT_TO))], [TO, OTHER_TO], { aliases: { [SHORT_TO]: OTHER_TO } });
  assert.equal(landed.result.pass, false);
  assert.ok(landed.result.lines.some((line) => line.startsWith('FAIL 2 range: rd.s1.a-land') && line.includes(SHORT_TO)), landed.result.lines.join('\n'));
  const reviewed = gate(steeredRows(reviewedText(SHORT_TO)), [TO], { steered: true, aliases: { [SHORT_TO]: OTHER_TO } });
  assert.ok(reviewed.result.lines.some((line) => line.startsWith('FAIL 2 range: rd.s1.a ') && line.includes(SHORT_TO)), reviewed.result.lines.join('\n'));
  assert.equal(usedAsText(reviewed.calls, OTHER_TO), false);
});

// "landed within <id>" is for fix rows only: a road lane (an entry of the road) lands alone, so it always has its own range.
const TWO_STEERED = { ...ROAD, steps: [{ form: 'agents', lanes: [{ name: 'a', files: ['x.mjs'] }, { name: 'g', files: ['y.mjs'] }] }] };
const TWO_PLAIN = { ...ROAD, steps: [{ lanes: TWO_STEERED.steps[0].lanes }] };
const D = 'd'.repeat(40);
const lineFor = (result, pattern) => result.lines.find((line) => pattern.test(line));
const NEEDS_OWN_RANGE = /^FAIL 2 range: rd\.s1\.g-land .*a road lane needs its own range; lanes land one at a time/;
const laneWithin = (correction, laneEvidence = 'x') => [row('rd.s1.a', reviewedText(TO)), row('rd.s1.a-land', landedText(TO)), row('rd.s1.g', laneEvidence), row('rd.s1.g-land', 'by hand'), row('rd.s1.g-land.landed', correction)];
const fixWithin = (correction) => [row('rd.s1.a', 'x'), row('rd.s1.a-land', landedText(TO)), row('rd.s1.fix-b-land', 'by hand'), row('rd.s1.fix-b-land.landed', correction)];

const roadLaneWithinFails = (text) => () => {
  const { result } = gate(laneWithin(text), [TO], { road: TWO_PLAIN });
  assert.equal(result.pass, false, text);
  assert.match(lineFor(result, /^FAIL 2 range: rd\.s1\.g-land /), NEEDS_OWN_RANGE, text);
};
test('a road lane whose correction row says "landed within" is a FAIL naming the row', roadLaneWithinFails(within('rd.s1.a-land')));
test('a road lane whose correction row says "landed within ... as <sha>" is a FAIL naming the row', roadLaneWithinFails(`${within('rd.s1.a-land')} as ${TO}`));

test('an unlanded stacked steered lane cannot hide behind the named row (reviewer probe)', () => {
  const { result } = gate(laneWithin(`${within('rd.s1.a-land')} as ${TO}`, reviewedText(D)), [TO], { road: TWO_STEERED });
  assert.equal(result.pass, false);
  assert.match(lineFor(result, /^FAIL 2 range: rd\.s1\.g-land /), NEEDS_OWN_RANGE);
});

test('a ghost lane that never landed cannot be closed by "landed within" (reviewer probe)', () => {
  for (const road of [TWO_PLAIN, TWO_STEERED]) {
    const { result } = gate(laneWithin(`${within('rd.s1.a-land')} as ${TO}`, reviewedText(TO)), [TO], { road });
    assert.equal(result.pass, false);
    assert.match(lineFor(result, /^FAIL 2 range: rd\.s1\.g-land /), NEEDS_OWN_RANGE);
  }
});

test('a road lane within row under the short id is a FAIL too, and a lane with its own range still passes', () => {
  const short = [row('rd.s1.a', 'x'), row('rd.s1.a-land', landedText(TO)), row('rd.s1.g', 'x'), row('rd.s1.g-land', 'by hand'), row('rd.s1.g.landed', within('rd.s1.a-land'))];
  assert.match(lineFor(gate(short, [TO], { road: TWO_PLAIN }).result, /^FAIL 2 range: rd\.s1\.g-land /), NEEDS_OWN_RANGE);
  const own = [row('rd.s1.a', 'x'), row('rd.s1.a-land', landedText(TO)), row('rd.s1.g', 'x'), row('rd.s1.g-land', landedText(OTHER_TO, TO))];
  assert.match(rangeLine(gate(own, [TO, OTHER_TO], { road: TWO_PLAIN }).result), /^PASS 2 range: 2 close rows/);
});

test('"landed within" at the start of the evidence or after "; " is read', () => {
  const named = within('rd.s1.a-land');
  for (const text of [named, `${named}; evidence: reflog`, `evidence: reflog; ${named}`, `${named} assured by the reflog`]) {
    assert.match(rangeLine(gate(fixWithin(text)).result), /^PASS 2 range: 2 close rows/, text);
  }
});

test('"landed within" inside other words ("never landed within") is not read', () => {
  const named = within('rd.s1.a-land');
  for (const text of [`never ${named}`, `done, ${named}`, `not ${named}.`]) {
    const { result } = gate(fixWithin(text));
    assert.equal(result.pass, false, text);
    assert.match(rangeLine(result), /^FAIL 2 range: rd\.s1\.fix-b-land has no "landed <to>/, text);
  }
});

test('a fix row closed by within takes no "as" part: valid or malformed, it is a FAIL naming the row', () => {
  for (const tail of [` as ${TO}`, ` as ${TO.toUpperCase()}`, ' as 12', ` as ${'e'.repeat(41)}`, ' as  x']) {
    const { result } = gate(fixWithin(`${within('rd.s1.a-land')}${tail}`));
    assert.equal(result.pass, false, tail);
    assert.ok(result.lines.some((line) => /^FAIL 2 range: rd\.s1\.fix-b-land .*"as"/.test(line)), `${tail}\n${result.lines.join('\n')}`);
  }
});

// The review check ties a steered lane's own range to its reviewed sha: `git cherry <reviewed> <to> <from>`, a `+` line is a commit not reviewed.
test('a steered lane whose own range holds a commit missing from the reviewed sha is a FAIL naming it, and cherry gets reviewed, to, from', () => {
  const REVIEWED = 'e'.repeat(40);
  const { result, calls } = gate(steeredRows(reviewedText(REVIEWED)), [TO], { steered: true, unreviewed: `- ${TO}\n+ ${D}\n` });
  assert.equal(result.pass, false, result.lines.join('\n'));
  assert.ok(result.lines.includes(`FAIL 2 range: a: commit ${D} is not in the reviewed ${REVIEWED}`), result.lines.join('\n'));
  assert.deepEqual(reviewCherries(calls), [['cherry', REVIEWED, TO, START]]);
});

test('a steered lane whose own range holds only reviewed commits passes with a reviewed sha other than its to', () => {
  const REVIEWED = 'e'.repeat(40);
  const { result } = gate(steeredRows(reviewedText(REVIEWED)), [TO], { steered: true, unreviewed: `- ${TO}\n` });
  assert.match(rangeLine(result), /^PASS 2 range: 1 close rows/, result.lines.join('\n'));
});

// One "landed within" is read: the last one of the evidence (the match is greedy up to it). An earlier one is ignored, never checked.
test('with two "landed within" claims in one evidence the last is the one read', () => {
  const nope = within('rd.s1.nope-land');
  const named = within('rd.s1.a-land');
  assert.match(rangeLine(gate(fixWithin(`${nope}; ${named}`)).result), /^PASS 2 range: 2 close rows/);
  const { result } = gate(fixWithin(`${named}; ${nope}`));
  assert.equal(result.pass, false);
  assert.match(rangeLine(result), /^FAIL 2 range: rd\.s1\.fix-b-land says "landed within rd\.s1\.nope-land", but rd\.s1\.nope-land is not a done close row/);
});

// The gate gets rows as parsed; it trims the evidence itself, so a padded cell still anchors at its start.
test('spaces around the evidence of a within row do not hide it', () => {
  assert.match(rangeLine(gate(fixWithin(`  ${within('rd.s1.a-land')}  `)).result), /^PASS 2 range: 2 close rows/);
});

// Fail closed (P3): the review check of a steered lane with its own range must FAIL when git cherry itself fails, not only on a `+` line.
test('a steered lane whose reviewed git cherry exits non-zero without output is a FAIL', () => {
  const { result } = gate(steeredRows(reviewedText(TO)), [TO], { steered: true, reviewExit: 127 });
  assert.equal(result.pass, false);
  assert.match(rangeLine(result), /^FAIL 2 range: a: git cherry exited 127/);
});

test('a steered lane that names the road-start tip as reviewed is a FAIL', () => {
  const { result } = gate(steeredRows(reviewedText(START)), [TO], { steered: true });
  assert.match(rangeLine(result), /^FAIL 2 range: rd\.s1\.a names the road-start tip as reviewed/);
});
