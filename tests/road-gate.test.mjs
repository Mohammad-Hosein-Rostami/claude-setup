// Tests of road-gate.mjs line 2 and the `<close row>.landed` correction row (STATUS row p8-gate-evidence), line 3's worktrees held by an
// open writer (road-gate-git.mjs, row r22.gate-open-lanes), and line 4's setup reports folder.
// A fake `run` stands in for git and the tools, so no repo is needed; it records every git argv to show which sha was checked. The open
// writer records are written by the guard's own recordAgentLaunch into a temp HOME, and the live session by a Claude Code session file
// (~/.claude/sessions/<pid>.json) in the same HOME.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordAgentLaunch } from '../home/hooks/lib/agent-launches.mjs';
import { gateStep } from '../home/tools/road/lib/road-gate.mjs';
import { gitLines, liveSessions, openWriterFolders } from '../home/tools/road/lib/road-gate-git.mjs';
import { setupReportsFolder } from '../home/tools/road/lib/road-gate-ui.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

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
const gate = (items, onBase = [TO], { aliases = {}, road = ROAD } = {}) => {
  const { run, calls } = fakeRun(onBase, aliases);
  return { result: gateStep(road, [startRow, ...items], 1, run, { isUiPath: () => false }), calls };
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

// The gate reads no review record (road README, "Rows"): a `reviewed <sha> clean` line or a `<lane row id>.reviewed` row changes nothing.
const reviewedText = (sha) => `reviewed ${sha} clean`;
const agentsRoad = { ...ROAD, steps: [{ form: 'agents', lanes: ROAD.steps[0].lanes }] };

test('a lane of an agents step needs no reviewed line, and a .reviewed row or a reviewed sha is never read or looked up', () => {
  const rows = [row('rd.s1.a', 'x'), row('rd.s1.a-land', landedText(TO))];
  assert.match(rangeLine(gate(rows, [TO], { road: agentsRoad }).result), /^PASS 2 range: 1 close rows/);
  const withReviewed = gate([row('rd.s1.a', reviewedText(SHORT_TO)), row('rd.s1.a-land', landedText(TO)), row('rd.s1.a.reviewed', reviewedText(OTHER_TO))], [TO], { road: agentsRoad });
  assert.match(rangeLine(withReviewed.result), /^PASS 2 range: 1 close rows/, withReviewed.result.lines.join('\n'));
  assert.equal(usedAsText(withReviewed.calls, OTHER_TO), false);
  assert.equal(withReviewed.calls.some((call) => call.includes(`${SHORT_TO}^{commit}`)), false);
  assert.equal(withReviewed.calls.filter((call) => call[0] === 'cherry').length, 1, 'only the base cherry of the close row runs');
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

// A sha that git resolves through a ref (a branch or tag named like hex) is not the commit the row names.
test('a row sha that resolves to a commit with another prefix is a FAIL naming the row', () => {
  const landed = gate([row('rd.s1.a', 'x'), row('rd.s1.a-land', landedText(SHORT_TO))], [TO, OTHER_TO], { aliases: { [SHORT_TO]: OTHER_TO } });
  assert.equal(landed.result.pass, false);
  assert.ok(landed.result.lines.some((line) => line.startsWith('FAIL 2 range: rd.s1.a-land') && line.includes(SHORT_TO)), landed.result.lines.join('\n'));
});

// "landed within <id>" is for fix rows only: a road lane (an entry of the road) lands alone, so it always has its own range.
const TWO_PLAIN = { ...ROAD, steps: [{ lanes: [{ name: 'a', files: ['x.mjs'] }, { name: 'g', files: ['y.mjs'] }] }] };
const D = 'd'.repeat(40);
const lineFor = (result, pattern) => result.lines.find((line) => pattern.test(line));
const NEEDS_OWN_RANGE = /^FAIL 2 range: rd\.s1\.g-land .*a road lane needs its own range; lanes land one at a time/;
const laneWithin = (correction, laneEvidence = 'x') => [row('rd.s1.a', 'x'), row('rd.s1.a-land', landedText(TO)), row('rd.s1.g', laneEvidence), row('rd.s1.g-land', 'by hand'), row('rd.s1.g-land.landed', correction)];
const fixWithin = (correction) => [row('rd.s1.a', 'x'), row('rd.s1.a-land', landedText(TO)), row('rd.s1.fix-b-land', 'by hand'), row('rd.s1.fix-b-land.landed', correction)];

const roadLaneWithinFails = (text) => () => {
  const { result } = gate(laneWithin(text), [TO], { road: TWO_PLAIN });
  assert.equal(result.pass, false, text);
  assert.match(lineFor(result, /^FAIL 2 range: rd\.s1\.g-land /), NEEDS_OWN_RANGE, text);
};
test('a road lane whose correction row says "landed within" is a FAIL naming the row', roadLaneWithinFails(within('rd.s1.a-land')));
test('a road lane whose correction row says "landed within ... as <sha>" is a FAIL naming the row', roadLaneWithinFails(`${within('rd.s1.a-land')} as ${TO}`));

test('a ghost lane that never landed cannot be closed by "landed within" (reviewer probe)', () => {
  const { result } = gate(laneWithin(`${within('rd.s1.a-land')} as ${TO}`), [TO], { road: TWO_PLAIN });
  assert.equal(result.pass, false);
  assert.match(lineFor(result, /^FAIL 2 range: rd\.s1\.g-land /), NEEDS_OWN_RANGE);
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

// Line 4's setup reports tree (lane share-scrub, F7 and review R5): always ~/Desktop/claude-setup-reports under HOME. No environment
// value moves it, since a project's settings can set env for the session and would widen the accepted folders to a planted one.
test('the setup reports tree is ~/Desktop/claude-setup-reports under HOME, and CLAUDE_SETUP_REPORTS never moves it', () => {
  const saved = { HOME: process.env.HOME, CLAUDE_SETUP_REPORTS: process.env.CLAUDE_SETUP_REPORTS };
  const home = join(tmpdir(), 'cs-test-road-home');
  const restore = (name) => (saved[name] === undefined ? delete process.env[name] : (process.env[name] = saved[name]));
  try {
    process.env.HOME = home;
    const fallback = { folder: join(home, 'Desktop', 'claude-setup-reports'), shown: join('~', 'Desktop', 'claude-setup-reports') };
    delete process.env.CLAUDE_SETUP_REPORTS;
    assert.deepEqual(setupReportsFolder(), fallback);
    process.env.CLAUDE_SETUP_REPORTS = tmpdir(); // a planted folder that would hold a fake proof
    assert.deepEqual(setupReportsFolder(), fallback, 'the process environment is not read');
    assert.deepEqual(setupReportsFolder({ CLAUDE_SETUP_REPORTS: tmpdir() }), fallback, 'an env object passed in is not read either');
  } finally {
    restore('HOME');
    restore('CLAUDE_SETUP_REPORTS');
  }
});

// ---- line 3: worktrees an open writer holds (row r22.gate-open-lanes) ----
// The live case of 2026-11-23: five lanes were built on branches the lead named (feat/road-ui-plan-gate, not the road file's
// feat/road-ui-plan), so no started row matched and git-tidy's merged-branch and merged-worktree findings of the running lanes FAILed.

const tidyOf = (...findings) => ({ exit: 1, out: JSON.stringify({ base: 'main', findings, hints: [] }) });
const finding = (kind, subject, detail = '') => ({ kind, subject, detail });
const LANE_ROAD = { ...ROAD, steps: [{ lanes: [{ name: 'a', branch: 'feat/a', files: ['x.mjs'] }] }] };

const LIVE = 's-1'; // the session whose Claude Code process (this test's own pid) is alive
const LANE_ROW = 'r22.lane-a'; // the row the writer's brief names (`row: <id>`), as the lead's STATUS.md holds it
const openRow = { id: LANE_ROW, item: 'build: lane a', started: DAY, done: null, evidence: '' };
const ahead = () => true; // git: the branch has commits not on the base, or none yet
const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;

/** A Claude Code session file `<pid>.json` naming `session` in HOME's session store. */
function sessionFile(home, pid, session) {
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true });
  writeFileSync(join(home, '.claude', 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: session, kind: 'interactive' }));
}

/**
 * A worktree folder and a temp HOME whose launch store holds one open writer launched in it by the live session, its brief naming
 * LANE_ROW, and a reader (which holds nothing).
 */
function heldWorld() {
  const home = makeTempDir('road-held-home-');
  const worktree = join(makeTempDir('road-held-repo-'), 'lane');
  mkdirSync(worktree);
  const env = { HOME: home, USERPROFILE: home };
  const about = { cwd: worktree, description: 'Lane a', prompt: `row: ${LANE_ROW}\nBASE: ${START}` };
  assert.equal(recordAgentLaunch(LIVE, 'implementer', env, { writer: true, about }).state, 'recorded');
  assert.equal(recordAgentLaunch('s-2', 'scout', env, { about: { cwd: join(worktree, '..') } }).state, 'recorded', 'a reader holds nothing');
  sessionFile(home, process.pid, LIVE);
  return { env, home, worktree };
}

const WORKTREE_FINDINGS = (worktree) => tidyOf(finding('merged-branch', 'feat/a-gate', '739e088 ancestor'), finding('merged-worktree', worktree, 'branch feat/a-gate'));

test('line 3: findings about a worktree a live open writer of an open row holds, and its branch, are INFO; without it FAIL', async () => {
  const { env, worktree } = heldWorld();
  const held = openWriterFolders(env, Date.now());
  assert.deepEqual(held.map((writer) => writer.row), [LANE_ROW], 'only the writer\'s launch');
  const live = await liveSessions(env);
  assert.deepEqual([...live], [LIVE]);
  const lines = gitLines(WORKTREE_FINDINGS(worktree), LANE_ROAD, [openRow], { held, live, branchAhead: ahead });
  assert.equal(lines[0], 'PASS 3 one git line: git-tidy check clean but for lanes in flight');
  const info = `INFO 3 one git line: in flight (held by an open writer of row ${LANE_ROW} in ${worktree}): `;
  assert.equal(lines.filter((line) => line.startsWith(info)).length, 2, lines.join('\n'));
  assert.ok(gitLines(WORKTREE_FINDINGS(worktree), LANE_ROAD, [openRow]).every((line) => line.startsWith('FAIL 3 one git line: ')), 'without the open record: FAIL, as before');
});

test('R2: a stale or planted record never hides a leftover: dead or unknown session, row done or not open, landed branch all FAIL', async () => {
  const { env, worktree } = heldWorld();
  const tidy = WORKTREE_FINDINGS(worktree);
  const allFail = (lines, why) => assert.ok(lines.length === 2 && lines.every((line) => line.startsWith('FAIL 3 one git line: ')), `${why}\n${lines.join('\n')}`);
  const sixDaysOn = openWriterFolders(env, Date.now() + SIX_DAYS_MS); // a crashed writer's record is still open (age cap 7 days)
  assert.equal(sixDaysOn.length, 1);
  allFail(gitLines(tidy, LANE_ROAD, [openRow], { held: sixDaysOn, live: new Set(), branchAhead: ahead }), 'its session is gone');
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid; // the process has ended: its session file is a leftover
  const planted = makeTempDir('road-held-planted-');
  const plantedEnv = { HOME: planted, USERPROFILE: planted };
  recordAgentLaunch('99999999-aaaa-bbbb-cccc-dddddddddddd', 'implementer', plantedEnv, { writer: true, about: { cwd: worktree, prompt: `row: ${LANE_ROW}` } });
  sessionFile(planted, deadPid, '99999999-aaaa-bbbb-cccc-dddddddddddd');
  sessionFile(planted, process.pid, 'another-live-session');
  const plantedLive = await liveSessions(plantedEnv);
  assert.ok(!plantedLive.has('99999999-aaaa-bbbb-cccc-dddddddddddd') && plantedLive.has('another-live-session'), 'a dead pid is no live session');
  allFail(gitLines(tidy, LANE_ROAD, [openRow], { held: openWriterFolders(plantedEnv, Date.now()), live: plantedLive, branchAhead: ahead }), 'made-up session id');
  const held = openWriterFolders(env, Date.now());
  const live = await liveSessions(env);
  const rowsCases = [[], [{ ...openRow, done: DAY }], [{ ...openRow, started: null }], [{ ...openRow, id: 'r22.other' }]];
  for (const items of rowsCases) allFail(gitLines(tidy, LANE_ROAD, items, { held, live, branchAhead: ahead }), `row ${JSON.stringify(items)}`);
  allFail(gitLines(tidy, LANE_ROAD, [openRow], { held, live, branchAhead: () => false }), 'the branch is an ancestor of the base (landed)');
  allFail(gitLines(tidy, LANE_ROAD, [openRow], { held, live }), 'no git answer: nothing held');
});

test('line 3: an open writer holds nothing else: another worktree, a merge commit or a dirty base still FAIL', async () => {
  const { env, worktree } = heldWorld();
  const context = { held: openWriterFolders(env, Date.now()), live: await liveSessions(env), branchAhead: ahead };
  const other = join(worktree, '..');
  const tidy = tidyOf(finding('merged-worktree', worktree, 'branch feat/a-gate'), finding('merged-worktree', other, 'branch feat/old'),
    finding('merged-branch', 'feat/old', 'x'), finding('merge-commit', 'abc1234', 'Merge x'));
  const lines = gitLines(tidy, LANE_ROAD, [openRow], context);
  assert.deepEqual(lines.map((line) => line.split(':')[0]), ['INFO 3 one git line', 'FAIL 3 one git line', 'FAIL 3 one git line', 'FAIL 3 one git line']);
});

test('line 3: the agent branch of a live open launch (Claude Code isolation worktree) is held by the same rules; no store holds nothing', () => {
  const writer = { session: LIVE, folder: null, agentBranch: 'worktree-agent-abc', row: LANE_ROW };
  const tidy = tidyOf(finding('agent-leftover', 'worktree-agent-abc', 'x'));
  const lines = gitLines(tidy, LANE_ROAD, [openRow], { held: [writer], live: new Set([LIVE]), branchAhead: ahead });
  assert.match(lines[1], new RegExp(`^INFO 3 one git line: in flight \\(held by an open writer of row ${LANE_ROW}\\): agent-leftover worktree-agent-abc`));
  assert.match(gitLines(tidy, LANE_ROAD, [openRow], { held: [writer], live: new Set(), branchAhead: ahead })[0], /^FAIL /, 'its session is not live');
  assert.deepEqual(openWriterFolders({ HOME: makeTempDir('road-held-none-') }, Date.now()), []);
});

test('gate: line 3 through gateStep asks git whether the held branch is ahead of the base or at its tip', async () => {
  const { env, worktree } = heldWorld();
  const OLD = 'd'.repeat(40);
  const gateWith = (branchHead, isAncestorExit) => {
    const { run: base } = fakeRun([TO]);
    const run = (file, argv) => {
      if (file === 'git-tidy') return tidyOf(finding('merged-worktree', worktree, 'branch feat/a-gate'));
      if (file === 'git' && argv.includes('refs/heads/feat/a-gate^{commit}')) return { exit: 0, out: `${branchHead}\n` };
      if (file === 'git' && argv.includes(OLD) && argv.includes('--is-ancestor')) return { exit: isAncestorExit, out: '' };
      return base(file, argv);
    };
    const items = [startRow, row('rd.s1.a', landedText(TO)), openRow];
    return gateStep(LANE_ROAD, items, 1, run, { isUiPath: () => false, held: openWriterFolders(env, Date.now()), live: new Set([LIVE]) }).lines.find((line) => / 3 /.test(line));
  };
  assert.match(gateWith(TO, 0), /^PASS 3 one git line: git-tidy check clean but for lanes in flight/, 'no commits yet: at the base tip');
  assert.match(gateWith(OLD, 1), /^PASS 3 one git line: git-tidy check clean but for lanes in flight/, 'commits not on the base');
  assert.match(gateWith(OLD, 0), /^FAIL 3 one git line: merged-worktree /, 'an ancestor of the base: a landed leftover');
  assert.match(gateWith(OLD, 128), /^FAIL 3 one git line: merged-worktree /, 'git cannot answer: FAIL');
});
