// Tests of two roads in one STATUS.md and of the terminal UI proof: gate line 2 counts the other roads' landings (road-gate.mjs
// otherRanges), line 4 takes a terminal proof row for a terminal UI step (an owner-approved render in the job's folder, dated, on record
// under `## Owner decisions`) and keeps the web ui-proof path for every UI landing, a fix row's included (road-gate-ui.mjs), and
// `road.mjs rows` opens a second road only when no lane name, branch or file clashes (road-file.mjs roadClash). Git is faked as a
// straight first-parent line for the gate; `rows` runs in a child process with a private HOME.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseWorkItems } from '../home/tools/estimate/lib/items.mjs';
import { gateStep } from '../home/tools/road/lib/road-gate.mjs';
import { CLEAN_ENV, commit, git, makeRepo } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const ROAD_CLI = fileURLToPath(new URL('../home/tools/road/road.mjs', import.meta.url));
const DAY = Date.parse('2026-11-22T10:00:00Z');
const sha = (char) => char.repeat(40);
const lane = (name, extra = {}) => ({ name, item: `lane ${name}`, size: 'S', branch: `lane/${name}`, files: [`src/${name}.mjs`], implementer: { model: 'opus', effort: 'high' }, checkpoints: ['true'], ...extra });
const roadOf = (id, lanes, extra = {}) => ({ road: id, goal: 'probe two roads', spec: 'none', repo: '/repo', base: 'main', steps: [{ lanes }], ...extra });
const row = (id, evidence, done = DAY) => ({ id, item: id.endsWith('.check') ? `close: step 1 checkpoint, base ${sha('a')}` : `build: ${id}`, size: 'S', started: DAY, done, evidence });
const landing = (to, from) => `landed ${sha(to)} on main from ${sha(from)}`;

/**
 * A fake git and tools on the base line `order` (the road start first): rev-list lists the commits of `from..to` on that line, merge-base
 * answers by position, a sha off the line is unknown; `ui` sets the ui-proof exits by subcommand (a number, or a function of the argv)
 * and `calls` records the ui-proof argv.
 */
function fakeRun(order, ui = {}) {
  const calls = [];
  const at = (text) => order.indexOf(text);
  const run = (file, argv) => {
    if (file === 'git-tidy') return { exit: 0, out: '' };
    if (file === 'ui-proof') { calls.push(argv); const exit = ui[argv[0]]; return { exit: (typeof exit === 'function' ? exit(argv) : exit) ?? 0, out: argv[0] === 'has' ? `record at ${order[0]}\n` : '' }; }
    const [command, ...rest] = argv.slice(2);
    const last = rest.at(-1);
    if (command === 'rev-parse') { const text = last.replace('^{commit}', ''); return text.startsWith('refs/heads/') ? { exit: 0, out: `${order.at(-1)}\n` } : at(text) === -1 ? { exit: 1, out: '' } : { exit: 0, out: `${text}\n` }; }
    if (command === 'rev-list') { const [from, to] = last.split('..'); return { exit: 0, out: order.slice(at(from) + 1, at(to) + 1).reverse().join('\n') }; }
    if (command === 'merge-base') return { exit: at(rest[1]) <= at(rest[2]) ? 0 : 1, out: '' };
    return { exit: 0, out: '' };
  };
  return { run, calls };
}

// Road rd lands a..b and d..e; road ot lands b..c and c..d in between (the case of roads r18 and solid, 2026-11-22).
const RD = roadOf('rd', [lane('x'), lane('y')]);
const OT = roadOf('ot', [lane('p'), lane('q')]);
const LINE = ['a', 'b', 'c', 'd', 'e'].map(sha);
const ITEMS = [row('rd.s1.check', '', null), row('rd.s1.x', landing('b', 'a')), row('rd.s1.y', landing('e', 'd')), row('ot.s1.p', landing('c', 'b')), row('ot.s1.q', landing('d', 'c'))];
const gate = ({ road = RD, items = ITEMS, order = LINE, others = [OT], ui = {}, status = {} } = {}) => {
  const { run, calls } = fakeRun(order, ui);
  return { result: gateStep(road, items, 1, run, { isUiPath: (file) => file.endsWith('.html'), otherRoads: others, ...status }), calls };
};
const lineOf = (result, n) => result.lines.filter((line) => new RegExp(`^[A-Z]+ ${n} `).test(line)).join('\n');

test('line 2: commits another road of the same STATUS.md landed in between count, and its tos are valid froms', () => {
  const alone = gate({ others: [] });
  assert.match(lineOf(alone.result, 2), /FAIL 2 range: rd\.s1\.y: from d{40} is neither the road-start tip nor another row's to/);
  assert.match(lineOf(alone.result, 2), /FAIL 2 range: commit c{40} lies in no close row's range/);
  const both = gate();
  assert.equal(lineOf(both.result, 2), 'PASS 2 range: 2 close rows and 2 of other roads, every commit in one range');
  assert.equal(both.result.pass, true, both.result.lines.join('\n'));
});

test('line 2: a commit in no road\'s range still FAILs', () => {
  const forged = gate({ order: [...LINE, sha('f')] });
  assert.match(lineOf(forged.result, 2), /^FAIL 2 range: commit f{40} lies in no close row's range$/m);
  assert.equal(forged.result.pass, false);
});

test('line 2: a range claimed by both roads FAILs, and another road\'s bad row is named', () => {
  const twice = gate({ items: [...ITEMS.slice(0, 3), row('ot.s1.p', landing('c', 'b')), row('ot.s1.q', landing('e', 'c'))] });
  assert.match(lineOf(twice.result, 2), /FAIL 2 range: ot\.s1\.q cites e{40}, which another close row cites too/);
  assert.match(lineOf(twice.result, 2), /overlap at e{40}/);
  const backwards = gate({ items: [...ITEMS.slice(0, 4), row('ot.s1.q', landing('d', 'e'))] });
  assert.match(lineOf(backwards.result, 2), /FAIL 2 range: ot\.s1\.q: e{40} is not an ancestor of d{40}/);
});

test('line 2: a road of another base adds no range; another road\'s landings before the start are left out', () => {
  assert.match(lineOf(gate({ others: [{ ...OT, base: 'develop' }] }).result, 2), /FAIL 2 range: commit c{40} lies in no close row's range/);
  const early = [row('rd.s1.check', '', null), row('rd.s1.x', landing('d', 'c')), row('rd.s1.y', landing('e', 'd')), row('ot.s1.p', landing('b', 'a')), row('ot.s1.q', landing('c', 'b'))];
  const items = early.map((one) => (one.id === 'rd.s1.check' ? { ...one, item: `close: step 1 checkpoint, base ${sha('c')}` } : one));
  assert.equal(lineOf(gate({ items }).result, 2), 'PASS 2 range: 2 close rows, every commit in one range');
});

// ---- line 4: the terminal proof of a terminal UI step, and the web path unchanged ----

const TERMINAL = { matrix: 'none: terminal status line text rows, no browser screen' };
const HOUR_MS = 3_600_000;
/** A real-render file in a fresh job folder, written an hour after the step's rows started (or at `writtenMs`). */
const render = (folder = makeTempDir('road-render-'), writtenMs = DAY + HOUR_MS) => {
  const file = join(folder, 'index.html');
  writeFileSync(file, '<pre>rows</pre>\n');
  utimesSync(file, new Date(writtenMs), new Date(writtenMs));
  return file;
};
const proofRow = (evidence) => row('rd.s1.terminal-proof', evidence);
const decision = (file, date = '2026-11-22') => `- ${date} terminal proof rd.s1: owner yes on ${file} (AskUserQuestion answer)`;
/** The STATUS.md beside the render (its job folder) with the owner's recorded yes, or the `decisions` given. */
const approved = (file, decisions = [decision(file)]) => ({ statusFile: join(dirname(file), 'STATUS.md'), statusText: `# STATUS\n\n## Owner decisions\n${decisions.join('\n')}\n` });
const terminalGate = (extra = [], { matrix = TERMINAL, ui = {}, status = {} } = {}) => gate({ road: roadOf('rd', [lane('x', matrix), lane('y')]), items: [...ITEMS, ...extra], ui, status });

test('line 4: a terminal UI step needs its terminal proof row and never asks ui-proof check', () => {
  const missing = terminalGate();
  assert.match(lineOf(missing.result, 4), /^FAIL 4 ui: terminal UI step: no owner-approved terminal proof; the record is a done row rd\.s1\.terminal-proof with the evidence "terminal proof: <absolute path of the real render> \(owner yes <YYYY-MM-DD>\)"$/);
  const file = render();
  const proved = terminalGate([proofRow(`terminal proof: ${file} (owner yes 2026-11-22)`)], { status: approved(file) });
  assert.equal(lineOf(proved.result, 4), `PASS 4 ui: terminal UI step: real render ${file} approved by the owner on 2026-11-22`);
  assert.equal(proved.result.pass, true, proved.result.lines.join('\n'));
  assert.deepEqual(proved.calls.map((argv) => argv[0]), ['changed', 'changed'], 'only ui-proof changed runs on the terminal path');
});

test('line 4: a terminal proof row that is open, malformed, relative or names no file FAILs', () => {
  const file = render();
  const open = row('rd.s1.terminal-proof', '', null);
  assert.match(lineOf(terminalGate([open]).result, 4), /^FAIL 4 ui: terminal UI step: no owner-approved terminal proof/);
  for (const evidence of [`terminal proof: ${file}`, `terminal proof: renders/index.html (owner yes 2026-11-22)`, `looked fine ${file} (owner yes 2026-11-22)`]) {
    assert.match(lineOf(terminalGate([proofRow(evidence)]).result, 4), /^FAIL 4 ui: rd\.s1\.terminal-proof evidence is not "terminal proof: <absolute path of the real render> \(owner yes <YYYY-MM-DD>\)"$/, evidence);
  }
  assert.match(lineOf(terminalGate([proofRow(`terminal proof: ${file}.gone (owner yes 2026-11-22)`)]).result, 4), /^FAIL 4 ui: rd\.s1\.terminal-proof names .*\.gone, which is not a non-empty file$/);
});

test('line 4: a changed UI file or a matrix path keeps the web ui-proof path, terminal proof row or not', () => {
  const proof = proofRow(`terminal proof: ${render()} (owner yes 2026-11-22)`);
  const changedUi = terminalGate([proof], { ui: { changed: 1, check: 1 } });
  assert.match(lineOf(changedUi.result, 4), /^FAIL 4 ui: ui-proof check --against-step rd\.s1 exited 1$/);
  const matrixPath = terminalGate([proof], { matrix: { matrix: 'coverage/matrix.json' }, ui: { check: 1 } });
  assert.match(lineOf(matrixPath.result, 4), /^FAIL 4 ui: ui-proof check --against-step rd\.s1 exited 1$/);
  assert.match(lineOf(terminalGate([], { matrix: { matrix: 'coverage/matrix.json' } }).result, 4), /^PASS 4 ui: visual-qa PASS at e{40}/);
  assert.match(lineOf(gate().result, 4), /^PASS 4 ui: no UI file changed in the step$/);
});

// A fix row of the step (no road entry) lands b..c between the lanes x (a..b) and y (c..d); only the fix changes a UI file.
const FIX_ITEMS = [row('rd.s1.check', '', null), row('rd.s1.x', landing('b', 'a')), row('rd.s1.fix-web', landing('c', 'b')), row('rd.s1.y', landing('d', 'c'))];
const fixChangesUi = (argv) => (argv[2] === sha('b') ? 1 : 0);
const fixGate = (lanes, ui, extra = [], status = {}) => gate({ road: roadOf('rd', lanes), items: [...FIX_ITEMS, ...extra], order: LINE.slice(0, 4), others: [], ui, status });

test('line 4: a fix row that lands a UI file needs ui-proof check; a terminal proof row never stands in, with or without a matrix', () => {
  const file = render();
  const terminal = fixGate([lane('x', TERMINAL), lane('y', TERMINAL)], { changed: fixChangesUi, check: 1 }, [proofRow(`terminal proof: ${file} (owner yes 2026-11-22)`)], approved(file));
  assert.match(lineOf(terminal.result, 4), /^FAIL 4 ui: ui-proof check --against-step rd\.s1 exited 1$/);
  assert.match(lineOf(fixGate([lane('x'), lane('y')], { changed: fixChangesUi, check: 1 }).result, 4), /^FAIL 4 ui: ui-proof check --against-step rd\.s1 exited 1$/);
  const checked = fixGate([lane('x'), lane('y')], { changed: fixChangesUi });
  assert.match(lineOf(checked.result, 4), /^PASS 4 ui: visual-qa PASS at d{40}/);
  assert.deepEqual(checked.calls.filter((argv) => argv[0] === 'changed').map((argv) => argv[2]), [sha('a'), sha('c'), sha('b')], 'the fix range is asked too');
});

const proofLine = (file, date = '2026-11-22') => proofRow(`terminal proof: ${file} (owner yes ${date})`);
const proofFail = (file, status, date) => lineOf(terminalGate([proofLine(file, date)], { status }).result, 4);

test('line 4: a terminal proof outside the job folder and the setup reports tree FAILs, through a link too', () => {
  const file = render();
  const outside = /^FAIL 4 ui: rd\.s1\.terminal-proof names .*, which lies outside the job's folder and ~\/Desktop\/claude-setup-reports$/;
  assert.match(proofFail(file, { ...approved(file), statusFile: join(makeTempDir('road-job-'), 'STATUS.md') }), outside);
  const link = join(makeTempDir('road-job-'), 'render.html');
  symlinkSync(file, link);
  assert.match(proofFail(link, approved(link)), outside);
  assert.match(proofFail('/etc/hosts', {}), /^FAIL 4 ui: rd\.s1\.terminal-proof names \/etc\/hosts, which (lies outside|is not a non-empty file)/);
});

test('line 4: a terminal proof in the setup reports tree under HOME passes from another job folder', () => {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const home = makeTempDir('road-home-');
  const reports = join(home, 'Desktop', 'claude-setup-reports', 'round');
  mkdirSync(reports, { recursive: true });
  const file = render(reports);
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    assert.match(proofFail(file, { ...approved(file), statusFile: join(makeTempDir('road-job-'), 'STATUS.md') }), /^PASS 4 ui: terminal UI step: real render /);
  } finally {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test('line 4: a terminal proof dated wrong, in the future or written before the step started FAILs', () => {
  const file = render();
  assert.match(proofFail(file, approved(file), '2026-02-30'), /^FAIL 4 ui: rd\.s1\.terminal-proof says owner yes 2026-02-30, which is not a real date$/);
  assert.match(proofFail(file, approved(file), '9999-12-31'), /^FAIL 4 ui: rd\.s1\.terminal-proof says owner yes 9999-12-31, a date after today$/);
  const early = render(makeTempDir('road-render-'), DAY - HOUR_MS);
  assert.match(proofFail(early, approved(early)), /^FAIL 4 ui: rd\.s1\.terminal-proof names .*, written before the step's first landing row started \(2026-11-22T10:00:00\.000Z\)$/);
});

test('line 4: a terminal proof with no matching owner decision line FAILs', () => {
  const file = render();
  const missing = /^FAIL 4 ui: rd\.s1\.terminal-proof has no owner decision on record: `## Owner decisions` needs "- 2026-11-22 terminal proof rd\.s1: owner yes on .* \(AskUserQuestion answer\)" \(status\.mjs decision\)$/;
  const cases = [
    [],
    [`- 2026-11-22 UNCONFIRMED (timeout default): terminal proof rd.s1: owner yes on ${file} (AskUserQuestion answer)`],
    [decision(file, '2026-11-21')],
    [decision(`${file}.other`)],
    [decision(file).replace('rd.s1:', 'rd.s2:')],
    ['```', decision(file), '```'],
  ];
  for (const decisions of cases) assert.match(proofFail(file, approved(file, decisions)), missing, decisions.join(' / '));
  const elsewhere = { ...approved(file), statusText: `# STATUS\n\n## Standing rules\n${decision(file)}\n\n## Owner decisions\n` };
  assert.match(proofFail(file, elsewhere), missing);
});

test('gate CLI: the terminal proof reads the road\'s STATUS.md folder and its owner decisions', () => {
  const world = roadsWorld([roadOf('rd', [lane('x', TERMINAL)])]);
  const start = git(world.repo, 'rev-parse', 'HEAD');
  assert.equal(rowsRun(world, world.files[0]).status, 0);
  const landed = commit(world.repo, 'x.mjs');
  const file = render(dirname(world.statusFile));
  const table = readFileSync(world.statusFile, 'utf8')
    .replace(/^\| rd\.s1\.x \|(.*)\| - \| - \| - \|$/m, `| rd.s1.x |$1| 2026-11-22T10:00Z | 2026-11-22T10:10Z | landed ${landed} on main from ${start} |`)
    .trimEnd().concat(`\n| rd.s1.terminal-proof | proof: step 1 terminal render | S | 2026-11-22T10:20Z | 2026-11-22T10:30Z | terminal proof: ${file} (owner yes 2026-11-22) |\n`);
  const gateRun = () => spawnSync(process.execPath, [ROAD_CLI, 'gate', world.files[0], '--step', '1'], { encoding: 'utf8', env: world.env });
  writeFileSync(world.statusFile, table);
  const unrecorded = gateRun();
  assert.equal(unrecorded.status, 1, unrecorded.stdout + unrecorded.stderr);
  assert.match(unrecorded.stderr, /^FAIL 4 ui: rd\.s1\.terminal-proof has no owner decision on record/m, 'a FAIL gate prints on stderr');
  writeFileSync(world.statusFile, table.replace('## Work items', `## Owner decisions\n${decision(file)}\n\n## Work items`));
  const recorded = gateRun();
  assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);
  assert.match(recorded.stdout, new RegExp(`^PASS 4 ui: terminal UI step: real render ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} approved by the owner on 2026-11-22$`, 'm'), recorded.stdout + recorded.stderr);
});

// ---- road.mjs rows: two open roads in one STATUS.md ----

/** A folder with road files for `roads` (all naming one fresh repo) and the env of a private HOME. */
function roadsWorld(roads) {
  const repo = makeRepo();
  const folder = makeTempDir('road-roads-');
  const home = makeTempDir('road-roads-home-');
  const files = roads.map((road) => { const file = join(folder, `road-${road.road}.json`); writeFileSync(file, `${JSON.stringify({ ...road, repo })}\n`); return file; });
  const env = { ...CLEAN_ENV, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  return { repo, files, env, statusFile: join(folder, 'STATUS.md') };
}
const rowsRun = (world, file, ...extra) => spawnSync(process.execPath, [ROAD_CLI, 'rows', file, ...extra], { encoding: 'utf8', env: world.env });
const roadIds = (world) => [...new Set(parseWorkItems(readFileSync(world.statusFile, 'utf8')).items.map((item) => item.id.split('.')[0]))];

test('rows: a second road opens beside an open one when no lane name, branch or file clashes', () => {
  const world = roadsWorld([RD, OT]);
  assert.equal(rowsRun(world, world.files[0]).status, 0);
  const second = rowsRun(world, world.files[1]);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /road ot: 3 rows added/);
  assert.deepEqual(roadIds(world), ['rd', 'ot']);
});

test('rows: a second road that shares a file, a lane name or a branch with an open road is refused, naming the clash', () => {
  const cases = [
    [roadOf('ot', [lane('p', { files: ['src/'] })]), /refused: .*STATUS\.md holds the open road rd: lane p and rd lane x both list src\//],
    [roadOf('ot', [lane('x', { branch: 'lane/other-x', files: ['lib/x.mjs'] })]), /refused: .*holds the open road rd: lane x \(branch lane\/other-x\) and rd lane x \(branch lane\/x\) share a name or branch/],
    [roadOf('ot', [lane('p', { branch: 'lane/y', files: ['lib/p.mjs'] })]), /refused: .*holds the open road rd: lane p \(branch lane\/y\) and rd lane y \(branch lane\/y\) share a name or branch/],
  ];
  for (const [other, refusal] of cases) {
    const world = roadsWorld([RD, other]);
    assert.equal(rowsRun(world, world.files[0]).status, 0);
    const second = rowsRun(world, world.files[1]);
    assert.equal(second.status, 1, second.stdout);
    assert.match(second.stderr, refusal);
    assert.deepEqual(roadIds(world), ['rd']);
  }
});

test('rows: an open road whose road file is not beside STATUS.md is refused (nothing to check the clash against)', () => {
  const world = roadsWorld([RD]);
  writeFileSync(world.statusFile, '# STATUS\n\n## Work items\n\n| id | item | size | started | done | evidence |\n| -- | ---- | ---- | ------- | ---- | -------- |\n| zz.s1.check | close: step 1 checkpoint | S | - | - | - |\n');
  const refused = rowsRun(world, world.files[0]);
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /refused: .*holds the open road zz: no readable road file of it beside STATUS\.md to check for clashes/);
});

test('rows --base: a landing of another open road at or before the base does not count as this road\'s', () => {
  const world = roadsWorld([RD, OT]);
  const start = git(world.repo, 'rev-parse', 'HEAD');
  assert.equal(rowsRun(world, world.files[0]).status, 0);
  const landed = commit(world.repo, 'x.mjs');
  writeFileSync(world.statusFile, readFileSync(world.statusFile, 'utf8').replace(/^\| rd\.s1\.x \|(.*)\| - \| - \| - \|$/m, `| rd.s1.x |$1| 2026-11-22T10:00Z | 2026-11-22T10:10Z | landed ${landed} on main from ${start} |`));
  const second = rowsRun(world, world.files[1], '--base', landed);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(readFileSync(world.statusFile, 'utf8'), new RegExp(`\\| ot\\.s1\\.check \\| close: step 1 checkpoint, base ${landed} \\|`));
  assert.equal(rowsRun(world, world.files[0], '--fix', '1', 'tidy').status, 0, 'the first road still takes rows');
});
