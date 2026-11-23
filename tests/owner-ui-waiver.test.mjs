// Tests of the owner's ui-proof waiver rule (home/tools/ui-proof/lib/owner-waiver.mjs) and of road gate line 4 with it (road-gate-ui.mjs
// uiLine): the waiver holds only with the owner's `ui-proof waiver for road <id>` line under `## Owner decisions` for that exact road (no
// UNCONFIRMED line, no line outside the section, in a code fence or in an HTML comment, no negated line, and a later revoking line cancels
// it), and line 4 never passes on the waiver evidence (no waivers, owner R28). The ui-proof tool and git are faked (ctx.uiProof,
// ctx.isAncestor); the landing side is in land-lane-ui-waiver.test.mjs.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { makeRepo } from './git-tidy-helpers.mjs';
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

test('ownerWaiverLine: a line in an HTML comment, a negated line or a later revoking line cancels the waiver; a later grant holds again', () => {
  const REVOKED = '- 2026-11-24 ui-proof waiver for road iceweb revoked (owner, 2026-11-24)';
  const NEGATED = '- 2026-11-24 no ui-proof waiver for road iceweb';
  const REGRANT = '- 2026-11-25 ui-proof waiver for road iceweb: owner yes again';
  assert.equal(ownerWaiverLine(statusWith(`<!-- ${DECISION} -->`), 'iceweb'), null, 'one-line HTML comment');
  assert.equal(ownerWaiverLine(statusWith('<!--', DECISION, '-->'), 'iceweb'), null, 'HTML comment over several lines');
  assert.equal(ownerWaiverLine(statusWith(`<!-- note --> ${DECISION}`), 'iceweb'), DECISION, 'the visible part after a closed comment counts');
  assert.equal(ownerWaiverLine(statusWith(NEGATED), 'iceweb'), null, 'negated');
  assert.equal(ownerWaiverLine(statusWith(DECISION, REVOKED), 'iceweb'), null, 'revoked later');
  assert.equal(ownerWaiverLine(statusWith(DECISION, NEGATED.toUpperCase()), 'iceweb'), null, 'any case revokes');
  assert.equal(ownerWaiverLine(statusWith(DECISION, `<!-- ${REVOKED} -->`), 'iceweb'), DECISION, 'a commented-out revoke is no revoke');
  assert.equal(ownerWaiverLine(statusWith(DECISION, REVOKED.replace('iceweb', 'iceplat')), 'iceweb'), DECISION, 'another road\'s revoke');
  assert.equal(ownerWaiverLine(statusWith(DECISION, REVOKED, REGRANT), 'iceweb'), REGRANT);
  for (const line of [`${DECISION}: owner said no`, '- 2026-11-23 owner: ui-proof waiver for road iceweb', '* 2026-11-23 ui-proof waiver for road iceweb']) {
    assert.equal(ownerWaiverLine(statusWith(line), 'iceweb'), null, line);
    assert.equal(ownerWaiverLine(statusWith(DECISION, line), 'iceweb'), null, `${line} after a grant`);
  }
});

/** A git repo (the repo being landed) and, outside it, a STATUS.md with the road row and `decisions`. */
function waiverWorld(...decisions) {
  const repo = makeRepo();
  const file = join(makeTempDir('owner-waiver-'), 'STATUS.md');
  const table = '| id | item | size | started | done | evidence |\n| -- | ---- | ---- | ------- | ---- | -------- |\n| iceweb.s1.fe | build: fe | S | - | - | - |';
  writeFileSync(file, statusWith(...decisions).replace('## Work items\n', `## Work items\n\n${table}\n`));
  return { repo, file };
}

test('ownerWaiverProblem: null with the row and the line; a message naming what is missing otherwise; an unreadable file never passes', () => {
  const { repo, file } = waiverWorld(DECISION);
  assert.equal(ownerWaiverProblem({ statusFile: file, closeRow: 'iceweb.s1.fe', repo }), null);
  assert.match(ownerWaiverProblem({ statusFile: file, closeRow: 'iceweb.s1.other', repo }), /does not hold the row iceweb\.s1\.other/);
  assert.match(ownerWaiverProblem({ statusFile: file, closeRow: 'close:1', repo }), /is not a road lane row/);
  assert.match(ownerWaiverProblem({ statusFile: join(dirname(file), 'missing.md'), closeRow: 'iceweb.s1.fe', repo }), /cannot be read/);
  const other = waiverWorld(DECISION.replace('iceweb', 'iceplat'));
  assert.match(ownerWaiverProblem({ statusFile: other.file, closeRow: 'iceweb.s1.fe', repo }), /needs a line with "ui-proof waiver for road iceweb"/);
  const inside = join(repo, 'STATUS.md');
  writeFileSync(inside, readFileSync(file, 'utf8'));
  assert.match(ownerWaiverProblem({ statusFile: inside, closeRow: 'iceweb.s1.fe', repo }), /inside .*the repository being landed/);
  assert.match(ownerWaiverProblem({ statusFile: file, closeRow: 'iceweb.s1.fe', repo: dirname(file) }), /cannot list the worktrees/);
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

// Line 4 has no waived path any more (owner R28, 2026-11-23: no waivers; road-plan lane): the waiver evidence is no proof, even with the
// owner's line, so the web or terminal path decides. The rule's own tests above stay for land-lane until the land-plan lane removes it.
test('line 4: UI landings with the waiver evidence and the owner\'s line are no proof: ui-proof check decides', () => {
  const { line, calls } = line4();
  assert.equal(line, 'FAIL 4 ui: ui-proof check --against-step iceweb.s1 exited 1');
  assert.ok(calls.includes('check'));
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
  assert.match(line4({ rows: plain, changed: [1, 0] }).line, /^FAIL 4 ui: ui-proof check/, 'only the waived one changed UI: still no proof');
});

test('line 4: a step of none: matrices with no UI change takes the terminal proof, the waiver evidence and the owner\'s line or not', () => {
  assert.match(line4({ changed: [0, 0] }).line, /^FAIL 4 ui: terminal UI step: no owner-approved terminal proof/);
  assert.match(line4({ changed: [0, 0], status: statusWith() }).line, /^FAIL 4 ui: terminal UI step: no owner-approved terminal proof/);
  const noUi = { ...ROAD, steps: [{ lanes: [{ name: 'x', files: ['src/x.mjs'] }, { name: 'y', files: ['src/y.mjs'] }] }] };
  assert.equal(line4({ changed: [0, 0], road: noUi }).line, 'PASS 4 ui: no UI file changed in the step', 'a step with no UI keeps its own PASS');
});

test('line 4: the waiver evidence of a done correction row is no proof either', () => {
  const rows = [row('iceweb.s1.x', 'build done'), row('iceweb.s1.x.landed', `${landing('b', 'a')}${UI_WAIVER_EVIDENCE}`), WAIVED_ROWS[1]];
  assert.match(line4({ rows }).line, /^FAIL 4 ui: ui-proof check --against-step iceweb\.s1 exited 1$/);
});
