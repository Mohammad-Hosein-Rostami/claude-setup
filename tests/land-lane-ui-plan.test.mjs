// Tests of the UI check plan at landing (ui-kinds-spec.md section 3) with the real land-lane, git-tidy, ui-proof, done-check and status
// tools on throw-away repos (land-lane-helpers.mjs: private HOME, so the proof store and the screens cache are temp files). The app is a
// small React Router fixture: /a renders PageA, which uses Button, which uses limit.mjs (tested by tests/limit.test.mjs) and format.mjs
// (no test). Proof records are written into the store the way the ui-proof hook writes them for a runner or visual-qa run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { storeFile } from '../home/tools/ui-proof/lib/records.mjs';
import { uiTreeAt } from '../home/tools/ui-proof/lib/ui-files.mjs';
import { git } from './git-tidy-helpers.mjs';
import { landArgs, makeWorld, readRow } from './land-lane-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const UI_PROOF = fileURLToPath(new URL('../home/tools/ui-proof/ui-proof.mjs', import.meta.url));
const GIT_TIDY = fileURLToPath(new URL('../home/tools/git-tidy/git-tidy.mjs', import.meta.url));
const A = 'react-router:/a';
const KEY_A = `${A} / rest / en @360`;
const ROW = 'ui.s1.button';
// The owner's old UI waiver flag, built from its parts so the repository holds no trace of the removed waiver (lane checkpoint: rg).
const OLD_WAIVER_FLAG = ['--owner', 'waive', 'ui'].join('-');
const APP = {
  'package.json': `${JSON.stringify({ name: 'app', private: true, type: 'module', dependencies: { react: '19.0.0', 'react-router-dom': '7.0.0' }, scripts: { test: 'node --test tests/*.test.mjs' } })}\n`,
  'src/main.tsx': ["import { createBrowserRouter } from 'react-router-dom';", "import PageA from './pages/PageA';", "import PageB from './pages/PageB';",
    "export const router = createBrowserRouter([{ path: '/a', element: <PageA /> }, { path: '/b', element: <PageB /> }]);", ''].join('\n'),
  'src/pages/PageA.tsx': "import Button from '../ui/Button';\nexport default function PageA() { return <Button />; }\n",
  'src/pages/PageB.tsx': 'export default function PageB() { return null; }\n',
  'src/ui/Button.tsx': "import { limit } from './limit.mjs';\nimport { format } from './format.mjs';\nexport default function Button() {\n  return (\n    <button>\n      {format(limit(5))}\n    </button>\n  );\n}\n",
  'src/ui/limit.mjs': 'export const limit = (n) => Math.min(n, 3);\n',
  'src/ui/format.mjs': 'export const format = (n) => String(n);\n',
  'tests/limit.test.mjs': "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { limit } from '../src/ui/limit.mjs';\ntest('limit', () => assert.equal(limit(9), 3));\n",
  'docs/team/onboarding.html': '<p>Team notes</p>\n',
};
const TESTED_LOGIC = { 'src/ui/limit.mjs': 'export const limit = (n) => Math.min(n, 4);\n', 'tests/limit.test.mjs': APP['tests/limit.test.mjs'].replace('9), 3', '9), 4') };
const UNTESTED_LOGIC = { 'src/ui/format.mjs': 'export const format = (n) => `${n}`;\n' };
const LOOK_IN_BUTTON = { 'src/ui/Button.tsx': APP['src/ui/Button.tsx'].replace('<button>', '<button className="big">') };
const output = (result) => result.stdout + result.stderr;

function writeFiles(dir, files) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', `change ${Object.keys(files)[0]}`);
  return git(dir, 'rev-parse', 'HEAD');
}

/** A world whose main holds `app` and a lane `lane/x` with one commit of `change` (main does not move, so the rebased tip is the tip). */
function appLane(change, app = APP) {
  const world = makeWorld();
  const base = writeFiles(world.dir, app);
  git(world.dir, 'checkout', '-q', '-b', 'lane/x');
  const tip = writeFiles(world.dir, change);
  git(world.dir, 'checkout', '-q', 'main');
  return { world, base, tip };
}

/** A brief file with `text`. */
function brief(text) {
  const file = join(makeTempDir('land-plan-brief-'), 'brief.md');
  writeFileSync(file, `${text}\n`);
  return file;
}

/** The plan `ui-proof plan --json` computes for the lane (what the runner renders). */
function planOf({ world, base, tip }, briefFile) {
  const run = spawnSync(process.execPath, [UI_PROOF, 'plan', '--base', base, '--tip', tip, '--request', briefFile, '--json', '--repo', world.dir], { encoding: 'utf8', env: world.env });
  assert.equal(run.status, 0, output(run));
  return JSON.parse(run.stdout);
}

let serial = 0;
/** Writes the base and tip runs of the plan's run matrix (agent `runner`), every map row with `verdict`, KEY_A's capture with `findings`. */
function writeRunnerProof(lane, plan, { verdict, findings = [] }) {
  const { world, base, tip } = lane;
  const keys = plan.surfaces.flatMap((s) => plan.map.states.flatMap((state) => plan.map.locales.flatMap((l) => plan.map.widths.map((w) => `${s.id} / ${state} / ${l.tag} @${w}`))));
  const record = (over) => ({ id: `r${(serial += 1)}`, createdAt: '2026-11-23T00:00:00Z', verdict: 'FAIL', agentType: 'runner', matrixHash: plan.map.hash, captures: [], same: null, ...over });
  const records = [
    record({ head: base, uiTree: uiTreeAt(world.dir, base), ledgerSha256: 'b'.repeat(64) }),
    record({ head: tip, uiTree: uiTreeAt(world.dir, tip), ledgerSha256: 'c'.repeat(64), captures: [{ key: KEY_A, sha256: 'd'.repeat(64), findings, pageErrors: [] }],
      same: { ref: { sha256: 'b'.repeat(64) }, mismatch: null, refused: null, rows: keys.map((key) => ({ key, verdict, newFindings: [], newPageErrors: [] })) } }),
  ];
  const file = storeFile(world.dir, { HOME: world.home });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(records));
}

const land = (lane, extra = [], row = 'close:1') => lane.world.run(landArgs(lane.world, 'lane/x', lane.tip, extra, row));
const mainAt = (lane) => git(lane.world.dir, 'rev-parse', 'main');

test('docs page only lands with no UI proof: a Go repo, no brief, no record, plan none named in the row (F3)', () => {
  const lane = appLane({ 'docs/team/onboarding.html': '<p>Team notes, updated</p>\n' }, { 'go.mod': 'module example.com/x\n\ngo 1.22\n', 'main.go': 'package main\n\nfunc main() {}\n', 'docs/team/onboarding.html': '<p>Team notes</p>\n' });
  const result = land(lane);
  assert.equal(result.status, 0, output(result));
  assert.equal(mainAt(lane), lane.tip);
  assert.ok(result.stdout.split('\n').includes('ui plan none: proved'), result.stdout);
  assert.ok(readRow(lane.world).split('|').at(-2).trim().endsWith(' (ui plan none: proved)'), readRow(lane.world));
});

test('a lane with no UI file lands as before: no plan line, no row pointer', () => {
  const lane = appLane({ 'notes.txt': 'n\n' }, { 'notes.txt': 'm\n' });
  const result = land(lane);
  assert.equal(result.status, 0, output(result));
  assert.doesNotMatch(result.stdout, /ui plan/);
  assert.doesNotMatch(readRow(lane.world), /ui plan/);
});

test('logic change with runner records lands, row evidence ends \' (ui plan render: proved)\' and old problems print as \'follow-up:\' lines', () => {
  const lane = appLane(TESTED_LOGIC);
  const file = brief('Raise the limit to 4.');
  const plan = planOf(lane, file);
  assert.equal(plan.depth, 'render');
  writeRunnerProof(lane, plan, { verdict: 'changed', findings: ['contrast .btn'] });
  const result = land(lane, ['--brief', file]);
  assert.equal(result.status, 0, output(result));
  assert.equal(mainAt(lane), lane.tip);
  assert.ok(result.stdout.split('\n').includes(`follow-up: ${KEY_A}: contrast .btn (on the base and the tip)`), result.stdout);
  assert.ok(readRow(lane.world).split('|').at(-2).trim().endsWith(' (ui plan render: proved)'), readRow(lane.world));
});

test('logic change with tests none related exit 4, nothing lands', () => {
  const lane = appLane(UNTESTED_LOGIC);
  const file = brief('Format the count as a template string.');
  writeRunnerProof(lane, planOf(lane, file), { verdict: 'equal' });
  const result = land(lane, ['--brief', file]);
  assert.equal(result.status, 4, output(result));
  assert.match(result.stdout, /^land: checks-red$/m);
  assert.match(result.stdout, /the change has logic: a test must run it \(done-check tests: (none|not-run)\)/);
  assert.notEqual(mainAt(lane), lane.tip);
});

test('changed state under a noChange request exit 6 naming the state, nothing lands', () => {
  const lane = appLane(TESTED_LOGIC);
  const file = brief('Refactor the limit, no visual change.');
  const plan = planOf(lane, file);
  assert.deepEqual(plan.surfaces.map((s) => s.needs.join('+')), ['same+render']);
  writeRunnerProof(lane, plan, { verdict: 'changed' });
  const result = land(lane, ['--brief', file]);
  assert.equal(result.status, 6, output(result));
  assert.match(result.stdout, /^land: ui-proof$/m);
  assert.ok(result.stdout.includes(`unexpected visual change: ${KEY_A}`), result.stdout);
  assert.notEqual(mainAt(lane), lane.tip);
});

test('look change on a Figma surface without visual-qa PASS exit 6: the matrix comes from the road beside STATUS.md', () => {
  const lane = appLane(LOOK_IN_BUTTON);
  const folder = dirname(lane.world.statusFile);
  const matrix = { root: '.', locales: [{ tag: 'en', dir: 'ltr' }], widths: [360], cells: [],
    surfaces: [{ id: 'a', kind: 'screen', source: 'x', controls: [{ id: 'page', class: 'other', component: 'src/pages/PageA.tsx', mountedAt: 'src/pages/PageA.tsx:2', states: ['rest'] }] }],
    frames: [{ node: '1:2', name: 'A', width: 360, cells: [{ surface: 'a', state: 'rest', locale: 'en' }] }] };
  writeFileSync(join(lane.world.dir, '..', 'lane-matrix.json'), JSON.stringify({ ...matrix, root: lane.world.dir.split('/').at(-1) }));
  const laneEntry = { name: 'button', item: 'bigger button', size: 'S', branch: 'lane/x', files: ['src/ui/Button.tsx'], implementer: { model: 'opus', effort: 'high' }, checkpoints: ['true'], matrix: join(lane.world.dir, '..', 'lane-matrix.json') };
  writeFileSync(join(folder, 'road-ui.json'), JSON.stringify({ road: 'ui', goal: 'bigger button', spec: 'none', repo: lane.world.dir, base: 'main', steps: [{ lanes: [laneEntry] }] }));
  writeFileSync(lane.world.statusFile, `# STATUS\n\n## Work items\n\n| id | item | size | started | done | evidence |\n| -- | -- | -- | -- | -- | -- |\n| ${ROW} | build: button | S | - | - | - |\n`);
  const file = brief('Make the button bigger.');
  assert.equal(planOf(lane, file).depth, 'render', 'without the matrix the plan is lighter: the road is what makes it pixel');
  const result = land(lane, ['--brief', file], ROW);
  assert.equal(result.status, 6, output(result));
  assert.match(result.stdout, /^land: ui-proof$/m);
  assert.match(result.stdout, /^ui-proof: FAIL - no visual-qa PASS for the UI files of [0-9a-f]{40}/m);
  assert.notEqual(mainAt(lane), lane.tip);
});

test('an app change with no --brief is exit 2 before anything runs; an unreadable brief is exit 2 (P3)', () => {
  const lane = appLane(TESTED_LOGIC);
  const before = [mainAt(lane), git(lane.world.dir, 'rev-parse', 'lane/x')];
  const none = land(lane);
  assert.equal(none.status, 2, output(none));
  assert.match(none.stdout, /the lane changes the app \(ui check plan render\): give --brief/);
  const missing = land(lane, ['--brief', join(makeTempDir('land-plan-gone-'), 'nope.md')]);
  assert.equal(missing.status, 2, output(missing));
  assert.match(missing.stdout, /--brief .*nope\.md cannot be read/);
  assert.deepEqual([mainAt(lane), git(lane.world.dir, 'rev-parse', 'lane/x')], before);
  assert.doesNotMatch(readRow(lane.world), /landed/);
});

test('restart after a kill: the landing found again keeps its row evidence with the plan suffix (F2)', () => {
  const lane = appLane(TESTED_LOGIC);
  const file = brief('Raise the limit to 4.');
  writeRunnerProof(lane, planOf(lane, file), { verdict: 'equal' });
  const tidy = spawnSync(process.execPath, [GIT_TIDY, 'land', 'lane/x', lane.world.dir, '--base', 'main', '--tip', lane.tip, '--brief', file], { encoding: 'utf8', env: lane.world.env });
  assert.equal(tidy.status, 0, output(tidy));
  assert.ok(tidy.stdout.split('\n').includes('ui plan render: proved'), tidy.stdout);
  const result = land(lane, ['--brief', file]);
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /^land: already landed$/m);
  const evidence = readRow(lane.world).split('|').at(-2).trim();
  assert.ok(evidence.endsWith(`after a restart) (ui plan render: proved)`), evidence);
});

test('the old UI waiver flag exit 2 with \'removed\', in land-lane and in git-tidy land', () => {
  const lane = appLane(TESTED_LOGIC);
  const result = land(lane, [OLD_WAIVER_FLAG, 'x']);
  assert.equal(result.status, 2, output(result));
  assert.ok(result.stdout.split('\n').some((line) => line.startsWith(`${OLD_WAIVER_FLAG} was removed: there are no UI waivers`)), result.stdout);
  const tidy = spawnSync(process.execPath, [GIT_TIDY, 'land', OLD_WAIVER_FLAG, 'x'], { encoding: 'utf8', env: lane.world.env });
  assert.equal(tidy.status, 2, output(tidy));
  assert.ok(tidy.stderr.includes(`${OLD_WAIVER_FLAG} was removed: there are no UI waivers`), tidy.stderr);
});
