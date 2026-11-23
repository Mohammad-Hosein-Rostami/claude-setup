// Tests of the owner's ui-proof waiver rule (home/tools/ui-proof/lib/owner-waiver.mjs) and of road gate line 4 with it (road-gate-ui.mjs
// uiLine): the waiver holds only with the owner's `ui-proof waiver for road <id>` line under `## Owner decisions` for that exact road (no
// UNCONFIRMED line, no line outside the section or in a code fence), and line 4 passes only when the step's UI landings carry the waiver
// evidence. The ui-proof tool and git are faked (ctx.uiProof, ctx.isAncestor); the landing side is in land-lane-ui-waiver.test.mjs.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { uiLine } from '../home/tools/road/lib/road-gate-ui.mjs';
import { UI_WAIVER_EVIDENCE, ownerWaiverLine, ownerWaiverProblem, roadOfRow, waiverReasonProblem } from '../home/tools/ui-proof/lib/owner-waiver.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const DECISION = '- 2026-11-23 ui-proof waiver for road iceweb: web API lanes land without the screen check (owner, 2026-11-23)';
const statusWith = (...decisions) => `# STATUS\n\n## Work items\n\n## Owner decisions\n${decisions.join('\n')}\n\n## Later\n`;

test('roadOfRow: the road of a road row, null for any other row', () => {
  assert.equal(roadOfRow('iceweb.s1.fe-session'), 'iceweb');
  assert.equal(roadOfRow('iceweb.s12.fix-fe-review'), 'iceweb');
  for (const id of ['close:1', 'P13', 'iceweb', 'iceweb.s0.x', 'IceWeb.s1.x', 'toolongroad.s1.x']) assert.equal(roadOfRow(id), null, id);
});

test('ownerWaiverLine: the owner\'s line for that exact road under ## Owner decisions', () => {
  assert.equal(ownerWaiverLine(statusWith(DECISION), 'iceweb'), DECISION);
  assert.equal(ownerWaiverLine(statusWith('- x', `  ${DECISION}  `), 'iceweb'), DECISION, 'any line of the section, trimmed');
  assert.equal(ownerWaiverLine(statusWith(DECISION), 'iceplat'), null, 'another road');
  assert.equal(ownerWaiverLine(statusWith(DECISION), 'ice'), null, 'a prefix of the road id is another road');
  assert.equal(ownerWaiverLine(statusWith(DECISION.replace('iceweb', 'iceweb-2')), 'iceweb'), null, 'a longer road id is another road');
  assert.equal(ownerWaiverLine(statusWith('- 2026-11-23 no waiver'), 'iceweb'), null);
});

test('ownerWaiverLine: a timeout default (UNCONFIRMED), a line outside the section or inside a code fence is no owner decision', () => {
  assert.equal(ownerWaiverLine(statusWith(`${DECISION}: UNCONFIRMED (timeout default)`), 'iceweb'), null);
  assert.equal(ownerWaiverLine(statusWith(`- unconfirmed ${DECISION.slice(2)}`), 'iceweb'), null, 'any case');
  assert.equal(ownerWaiverLine(`# STATUS\n\n## Standing rules\n${DECISION}\n\n## Owner decisions\n- other\n`, 'iceweb'), null);
  assert.equal(ownerWaiverLine(`# STATUS\n\n## Owner decisions\n\`\`\`\n${DECISION}\n\`\`\`\n`, 'iceweb'), null);
  assert.equal(ownerWaiverLine(`# STATUS\n\n${DECISION}\n`, 'iceweb'), null, 'no section at all');
});

test('ownerWaiverProblem: null with the line; a message naming the missing line otherwise; an unreadable file never passes', () => {
  const folder = makeTempDir('owner-waiver-');
  const file = join(folder, 'STATUS.md');
  writeFileSync(file, statusWith(DECISION));
  assert.equal(ownerWaiverProblem(file, 'iceweb'), null);
  assert.match(ownerWaiverProblem(file, 'iceplat'), /needs a line with "ui-proof waiver for road iceplat"/);
  assert.match(ownerWaiverProblem(join(folder, 'missing.md'), 'iceweb'), /cannot be read/);
  assert.match(ownerWaiverProblem(file, 'Ice Web'), /is not a road id/);
});

test('waiverReasonProblem: 1 to 200 characters, no control character', () => {
  assert.equal(waiverReasonProblem('API lane, owner waiver 2026-11-23'), null);
  for (const reason of ['', 'x'.repeat(201), 'line\nbreak']) assert.match(waiverReasonProblem(reason), /1 to 200 characters/);
});

// ---- road gate line 4 ----

const sha = (char) => char.repeat(40);
const lane = (name, extra = {}) => ({ name, files: [`src/${name}.tsx`], matrix: 'none: data hooks only, no rendered change', ...extra });
const ROAD = { road: 'iceweb', repo: '/repo', base: 'main', steps: [{ lanes: [lane('x'), lane('y')] }] };
const landing = (to, from) => `landed ${sha(to)} on main from ${sha(from)}`;
const row = (id, evidence) => ({ id, item: `build: ${id}`, started: 1, done: 2, evidence });
const range = (id, from, to) => ({ step: 1, row: id, entry: null, unknown: [], landed: { from: sha(from), to: sha(to) } });
const RANGES = [range('iceweb.s1.x', 'a', 'b'), range('iceweb.s1.y', 'b', 'c')];
const WAIVED_ROWS = [row('iceweb.s1.x', `${landing('b', 'a')}${UI_WAIVER_EVIDENCE}`), row('iceweb.s1.y', `${landing('c', 'b')} (skipped)${UI_WAIVER_EVIDENCE}`)];

/** Line 4 with `changed` exits per landing (1 = UI files changed) and `ui-proof check` failing, so only the waiver can PASS. */
function line4({ rows = WAIVED_ROWS, status = statusWith(DECISION), changed = [1, 1], road = ROAD } = {}) {
  const calls = [];
  const uiProof = (argv) => {
    calls.push(argv[0]);
    if (argv[0] === 'changed') return { exit: changed[RANGES.findIndex((one) => one.landed.from === argv[2])], out: '' };
    return { exit: 1, out: '' };
  };
  const ctx = { tip: sha('c'), repo: '/repo', isUiPath: (file) => file.endsWith('.tsx'), uiProof, isAncestor: () => 0, statusText: status };
  return { line: uiLine(road, new Map(rows.map((one) => [one.id, one])), RANGES, 1, ctx), calls };
}

test('line 4: UI landings with the waiver evidence and the owner\'s line PASS as waived, and ui-proof check is never asked', () => {
  const { line, calls } = line4();
  assert.equal(line, 'PASS 4 ui: waived by owner decision (ui-proof waiver for road iceweb): 2 landing(s) of the step landed with --owner-waive-ui');
  assert.ok(!calls.includes('check'));
});

test('line 4: the waiver evidence without the owner\'s line for this road (none, another road, UNCONFIRMED) keeps the web path', () => {
  for (const status of [statusWith(), statusWith(DECISION.replace('iceweb', 'iceplat')), statusWith(`${DECISION}: UNCONFIRMED (timeout default)`)]) {
    assert.equal(line4({ status }).line, 'FAIL 4 ui: ui-proof check --against-step iceweb.s1 exited 1', status);
  }
});

test('line 4: a UI landing without the waiver evidence keeps the web path, the owner\'s line or not', () => {
  const plain = [WAIVED_ROWS[0], row('iceweb.s1.y', landing('c', 'b'))];
  assert.equal(line4({ rows: plain }).line, 'FAIL 4 ui: ui-proof check --against-step iceweb.s1 exited 1');
  const middle = [row('iceweb.s1.x', `${landing('b', 'a')}${UI_WAIVER_EVIDENCE} later text`), WAIVED_ROWS[1]];
  assert.equal(line4({ rows: middle, changed: [1, 0] }).line, 'FAIL 4 ui: ui-proof check --against-step iceweb.s1 exited 1', 'the evidence must end with it');
  assert.match(line4({ rows: plain, changed: [0, 1] }).line, /^FAIL 4 ui: ui-proof check/, 'the UI landing is the one without it');
  assert.match(line4({ rows: plain, changed: [1, 0] }).line, /^PASS 4 ui: waived by owner decision .*: 1 landing\(s\)/, 'only the waived one changed UI');
});

test('line 4: a step of none: matrices with no UI change takes the waiver instead of the terminal proof, only with the owner\'s line', () => {
  assert.match(line4({ changed: [0, 0] }).line, /^PASS 4 ui: waived by owner decision/);
  assert.match(line4({ changed: [0, 0], status: statusWith() }).line, /^FAIL 4 ui: terminal UI step: no owner-approved terminal proof/);
  const noUi = { ...ROAD, steps: [{ lanes: [{ name: 'x', files: ['src/x.mjs'] }, { name: 'y', files: ['src/y.mjs'] }] }] };
  assert.equal(line4({ changed: [0, 0], road: noUi }).line, 'PASS 4 ui: no UI file changed in the step', 'a step with no UI keeps its own PASS');
});

test('line 4: the waiver evidence of a done correction row counts like the row\'s own', () => {
  const rows = [row('iceweb.s1.x', 'build done'), row('iceweb.s1.x.landed', `${landing('b', 'a')}${UI_WAIVER_EVIDENCE}`), WAIVED_ROWS[1]];
  assert.match(line4({ rows }).line, /^PASS 4 ui: waived by owner decision/);
});
