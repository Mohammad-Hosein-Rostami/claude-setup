// Tests for home/tools/ui-proof/lib/ui-plan.mjs (planChecks, briefFloor, planProofProblem), the `ui-proof plan` and `check --plan`
// commands and the hook's record tree (ui-proof-gate.mjs recordRun: the ledger root's worktree). Every repo is a throw-away cs-test git
// repo; the screens cache, the proof store, the run folder and HOME are temp dirs (P8).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { recordRun } from '../home/hooks/ui-proof-gate.mjs';
import { readRecords, storeFile } from '../home/tools/ui-proof/lib/records.mjs';
import { NO_UI_TREE, changedUiFiles, uiTreeAt, workingUiTree } from '../home/tools/ui-proof/lib/ui-files.mjs';
import { briefFloor, planChecks, planProofProblem } from '../home/tools/ui-proof/lib/ui-plan.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const CLI = fileURLToPath(new URL('../home/tools/ui-proof/ui-proof.mjs', import.meta.url));
const STATE = fs.realpathSync.native(makeTempDir('ui-plan-state-'));
process.env.UI_SCREENS_STATE_DIR = path.join(STATE, 'screens');
const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};
const A = 'react-router:/a';
const B = 'react-router:/b';
const KEY_A = `${A} / rest / en @360`;
const REACH_LINE = /^reach unresolved: .+: rendering every inferred route$/;

function git(dir, args) {
  const result = spawnSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(dir, files, removed = []) {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  for (const file of removed) fs.rmSync(path.join(dir, file));
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'fixture']);
  return git(dir, ['rev-parse', 'HEAD']);
}

const page = (name, imports = []) => `${imports.map((spec, i) => `import part${i} from '${spec}';`).join('\n')}\nexport default function ${name}() { return null; }\n`;
const APP = {
  'package.json': '{\n  "name": "app",\n  "dependencies": {\n    "react": "19.0.0",\n    "react-router-dom": "7.0.0"\n  }\n}\n',
  'src/main.tsx': ["import { createBrowserRouter } from 'react-router-dom';", "import PageA from './pages/PageA';", "import PageB from './pages/PageB';",
    "export const router = createBrowserRouter([{ path: '/a', element: <PageA /> }, { path: '/b', element: <PageB /> }]);"].join('\n'),
  'src/pages/PageA.tsx': page('PageA', ['../ui/Button']),
  'src/pages/PageB.tsx': page('PageB'),
  'src/ui/Button.tsx': 'export default function Button() { return <button />; }\n',
  'src/ui/Unused.tsx': 'export const unused = (n) => n + 1;\n',
  'src/theme/palette.ts': "export const primary = '#1976d2';\n",
  'src/pages/PageA.test.tsx': "import PageA from './PageA';\n",
  'docs/team/a.html': '<p>Team notes</p>\n',
  'README.md': '# app\n',
  '.eslintrc.json': '{}\n',
};

/** A fixture app at base and one commit on top: { dir, base, tip }. */
function lane(change, removed = [], files = APP) {
  const dir = fs.realpathSync.native(makeTempDir('ui-plan-'));
  git(dir, ['init', '-q', '-b', 'main']);
  const base = commit(dir, files);
  return { dir, base, tip: commit(dir, change, removed) };
}

const planOf = ({ dir, base, tip }, extra = {}) => planChecks({ repoDir: dir, base, tip, ...extra });
const needs = (plan) => Object.fromEntries(plan.surfaces.map((s) => [s.id, s.needs.join('+')]));
const LOGIC_IN_BUTTON = { 'src/ui/Button.tsx': 'export const limit = (n) => Math.min(n, 3);\nexport default function Button() { return <button />; }\n' };
const LOOK_IN_BUTTON = { 'src/ui/Button.tsx': 'export default function Button() {\n  return <button className="big" />;\n}\n' };

test('docs-page-only diff -> none, the page listed as exempt', () => {
  const plan = planOf(lane({ 'docs/team/a.html': '<p>Team notes, updated</p>\n' }));
  assert.equal(plan.depth, 'none');
  assert.deepEqual(plan.exempt, [{ file: 'docs/team/a.html', why: 'docs page, not served by the app' }]);
});

test('tests/config only -> none', () => {
  const plan = planOf(lane({ 'src/pages/PageA.test.tsx': "import PageA from './PageA';\ntest('x', () => {});\n", '.eslintrc.json': '{"root": true}\n', 'README.md': '# app\n\nmore\n' }));
  assert.equal(plan.depth, 'none');
  assert.equal(plan.exempt.length, 3);
});

test('logic in a .tsx reaching A -> render A + tests', () => {
  const plan = planOf(lane(LOGIC_IN_BUTTON));
  assert.equal(plan.depth, 'render');
  assert.equal(plan.tests, true);
  assert.deepEqual(needs(plan), { [A]: 'render' });
  assert.equal(plan.surfaces[0].url, '/a');
});

test('theme file -> render every surface', () => {
  const plan = planOf(lane({ 'src/theme/palette.ts': "export const primary = '#d32f2f';\n" }));
  assert.equal(plan.depth, 'render');
  assert.deepEqual(needs(plan), { [A]: 'render', [B]: 'render' });
});

test('design word in the brief -> pixel', () => {
  const plan = planOf(lane(LOOK_IN_BUTTON), { requestText: 'Make the button match the Figma frame.' });
  assert.equal(plan.depth, 'pixel');
  assert.deepEqual(needs(plan), { [A]: 'pixel' });
});

test('look change on a surface with a Figma frame (lane matrix outside the repo) -> pixel for it only', () => {
  const fixture = lane(LOOK_IN_BUTTON);
  const matrixDir = makeTempDir('ui-plan-matrix-');
  const matrix = { root: path.relative(matrixDir, fixture.dir), locales: [{ tag: 'en', dir: 'ltr' }], widths: [360], cells: [],
    surfaces: [{ id: 'a', kind: 'screen', source: 'x', controls: [{ id: 'page', class: 'other', component: 'src/pages/PageA.tsx', mountedAt: 'src/pages/PageA.tsx:2', states: ['rest'] }] }],
    frames: [{ node: '1:2', name: 'A', width: 360, cells: [{ surface: 'a', state: 'rest', locale: 'en' }] }] };
  fs.writeFileSync(path.join(matrixDir, 'matrix.json'), JSON.stringify(matrix));
  const plan = planOf(fixture, { matrixPath: path.join(matrixDir, 'matrix.json') });
  assert.equal(plan.depth, 'pixel');
  assert.equal(needs(plan)[A], 'pixel');
  assert.equal(needs(plan)[B], undefined, 'B is not reached');
  assert.equal(planOf(lane(LOOK_IN_BUTTON), { matrixPath: path.join(matrixDir, 'matrix.json') }).depth, 'pixel', 'frames not tied to this repo: any look counts');
  assert.equal(planOf(lane(LOGIC_IN_BUTTON), { matrixPath: path.join(matrixDir, 'matrix.json') }).depth, 'render', 'a logic change never meets a frame');
});

test('deps only -> same on every surface', () => {
  const plan = planOf(lane({ 'package.json': APP['package.json'].replace('19.0.0', '19.1.0') }));
  assert.equal(plan.depth, 'same');
  assert.deepEqual(needs(plan), { [A]: 'same', [B]: 'same' });
});

test('new route (no base render) -> visual', () => {
  const plan = planOf(lane({ 'src/main.tsx': APP['src/main.tsx'].replace("import PageB from './pages/PageB';", "import PageB from './pages/PageB';\nimport PageC from './pages/PageC';")
    .replace("element: <PageB /> }", "element: <PageB /> }, { path: '/c', element: <PageC /> }"), 'src/pages/PageC.tsx': page('PageC') }));
  assert.equal(plan.depth, 'visual');
  assert.equal(needs(plan)['react-router:/c'], 'visual');
  assert.match(plan.surfaces.find((s) => s.id === 'react-router:/c').why, /new screen: no base render/);
});

test('UI-PLAN: pixel floor over a computed render -> pixel; a bad value is ignored with a reason line; a lower floor never lowers', () => {
  const fixture = lane(LOGIC_IN_BUTTON);
  assert.equal(briefFloor('brief\nUI-PLAN: pixel\n'), 'pixel');
  assert.equal(planOf(fixture, { requestText: 'Fix the total.\nUI-PLAN: pixel\n' }).depth, 'pixel');
  const bad = planOf(fixture, { requestText: 'UI-PLAN: loud\n' });
  assert.equal(bad.depth, 'render');
  assert.deepEqual(bad.reasons.filter((line) => line.startsWith('UI-PLAN')), ['UI-PLAN: "loud" ignored: not one of none, same, render, visual, pixel']);
  assert.equal(planOf(fixture, { requestText: 'UI-PLAN: none\n' }).depth, 'render');
});

test('unresolved reach -> render every inferred route plus one reach unresolved line', () => {
  const plan = planOf(lane(LOGIC_IN_BUTTON, [], { ...APP, 'src/pages/PageB.tsx': "import gone from './missing';\nexport default function PageB() { return null; }\n" }));
  assert.deepEqual(needs(plan), { [A]: 'render', [B]: 'render' });
  assert.equal(plan.reasons.filter((line) => REACH_LINE.test(line)).length, 1);
});

test('no inferable route -> visual plus one line', () => {
  const plan = planOf(lane({ 'src/widget.tsx': 'export const Widget = () => <div className="w" />;\n' }, [], { 'src/widget.tsx': 'export const Widget = () => <div />;\n' }));
  assert.equal(plan.depth, 'visual');
  assert.equal(plan.reasons.filter((line) => line.startsWith('no inferable route')).length, 1);
});

test('fu.uievidence-rename: a renamed app file counts as a change; an empty diff is none', () => {
  const fixture = lane({ 'src/ui/Other.tsx': APP['src/ui/Unused.tsx'] }, ['src/ui/Unused.tsx']);
  assert.notEqual(planOf(fixture).depth, 'none');
  assert.equal(planChecks({ repoDir: fixture.dir, base: fixture.tip, tip: fixture.tip }).depth, 'none');
});

test('a repository with no UI file plans none; unreadable evidence plans pixel', () => {
  const tools = lane({ 'lib/tool.mjs': 'export const b = 2;\n' }, [], { 'lib/tool.mjs': 'export const a = 1;\n' });
  assert.equal(planOf(tools).depth, 'none');
  assert.equal(planChecks({ repoDir: tools.dir, base: 'no-such-ref', tip: tools.tip }).depth, 'pixel');
});

function cli(args, env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, UI_PROOF_STATE_DIR: path.join(STATE, 'proof'), ...env } });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

test('cs-test repo with a docs/team/a.html text edit: ui-proof plan prints plan: none and the exempt line, exit 0', () => {
  const { dir, base, tip } = lane({ 'docs/team/a.html': '<p>Team notes, updated</p>\n' });
  const run = cli(['plan', '--base', base, '--tip', tip, '--repo', dir]);
  assert.equal(run.code, 0, run.err);
  assert.deepEqual(run.out.trim().split('\n'), ['plan: none', 'exempt docs/team/a.html (docs page, not served by the app)']);
});

test('plan --write-run writes the matrix and states of the reached screens under the setup state, never in the repo', () => {
  const { dir, base, tip } = lane(LOGIC_IN_BUTTON);
  const runs = path.join(STATE, 'runs');
  const run = cli(['plan', '--base', base, '--tip', tip, '--repo', dir, '--write-run', 'lane-1'], { UI_PLAN_STATE_DIR: runs });
  assert.equal(run.code, 0, run.err);
  const states = JSON.parse(fs.readFileSync(path.join(runs, 'lane-1', 'states.json'), 'utf8'));
  assert.deepEqual(states.states, [{ surface: A, state: 'rest', locale: 'en', url: '/a' }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runs, 'lane-1', 'matrix.json'), 'utf8')).surfaces.map((s) => s.id), [A]);
  const written = crypto.createHash('sha256').update(fs.readFileSync(path.join(runs, 'lane-1', 'matrix.json'))).digest('hex');
  assert.equal(JSON.parse(cli(['plan', '--base', base, '--tip', tip, '--repo', dir, '--json']).out).map.hash, written, 'the plan names the matrix it writes');
  assert.equal(git(dir, ['status', '--porcelain', '--untracked-files=all']), '', 'nothing written in the repo');
  assert.equal(cli(['plan', '--base', base, '--tip', tip, '--repo', dir, '--write-run', path.join(dir, 'run')], { UI_PLAN_STATE_DIR: runs }).code, 2);
  assert.equal(cli(['plan', '--base', base, '--tip', tip, '--repo', dir, '--write-run', 'x'], { UI_PLAN_STATE_DIR: path.join(dir, 'state') }).code, 2, 'a state dir inside the repo is refused');
});

let serial = 0;
const record = (over) => ({ id: `r${(serial += 1)}`, createdAt: '2026-11-23T00:00:00Z', verdict: 'FAIL', agentType: 'runner', matrixHash: null, captures: [], same: null, ...over });

/** A base run and a tip run with --same of the plan's run matrix (`matrixHash` overrides it), both at their commits and UI trees. */
function proofRecords({ dir, base, tip }, plan, { rows, captures = [], agentType = 'runner', tipHead = tip, matrixHash = plan.map.hash }) {
  const baseRun = record({ head: base, uiTree: uiTreeAt(dir, base), ledgerSha256: 'b'.repeat(64), agentType, matrixHash });
  const tipRun = record({ head: tipHead, uiTree: uiTreeAt(dir, tip), ledgerSha256: 'c'.repeat(64), agentType, captures, matrixHash,
    same: { ref: { sha256: 'b'.repeat(64) }, mismatch: null, refused: null, rows } });
  return [baseRun, tipRun];
}

/** One row per state, locale and width of the plan's map on each surface (`ids`); the row of KEY_A gets `extra`. */
const mapRows = (plan, verdict, extra = {}, ids = plan.surfaces.map((s) => s.id)) => ids.flatMap((id) => plan.map.states.flatMap((state) =>
  plan.map.locales.flatMap((l) => plan.map.widths.map((width) => `${id} / ${state} / ${l.tag} @${width}`))))
  .map((key) => ({ key, verdict, newFindings: [], newPageErrors: [], ...(key === KEY_A ? extra : {}) }));
const prove = (fixture, plan, records) => planProofProblem(plan, { records, repoDir: fixture.dir, base: fixture.base, tip: fixture.tip });
const visualQaPass = (fixture) => record({ head: fixture.tip, uiTree: uiTreeAt(fixture.dir, fixture.tip), verdict: 'PASS', agentType: 'visual-qa' });

test('noChange request with a changed row -> FAIL unexpected visual change; identical rows PASS', () => {
  const fixture = lane(LOGIC_IN_BUTTON);
  const plan = planOf(fixture, { requestText: 'Refactor the button, no visual change.' });
  assert.deepEqual(needs(plan), { [A]: 'same+render' });
  assert.match(prove(fixture, plan, proofRecords(fixture, plan, { rows: mapRows(plan, 'identical', { verdict: 'changed' }) })).problem, /^unexpected visual change: react-router:\/a \/ rest \/ en @360$/);
  assert.equal(prove(fixture, plan, proofRecords(fixture, plan, { rows: mapRows(plan, 'identical') })).problem, null);
});

test('old finding -> follow-up and PASS; new finding or more page errors -> FAIL', () => {
  const fixture = lane(LOGIC_IN_BUTTON);
  const plan = planOf(fixture);
  const captures = [{ key: KEY_A, sha256: 'd'.repeat(64), findings: ['contrast .btn'], pageErrors: [] }];
  assert.deepEqual(prove(fixture, plan, proofRecords(fixture, plan, { rows: mapRows(plan, 'changed'), captures })),
    { problem: null, followUps: [`follow-up: ${KEY_A}: contrast .btn (on the base and the tip)`] });
  assert.match(prove(fixture, plan, proofRecords(fixture, plan, { rows: mapRows(plan, 'changed', { newFindings: ['overflow body'] }) })).problem, /^new finding: /);
  assert.match(prove(fixture, plan, proofRecords(fixture, plan, { rows: mapRows(plan, 'equal', { newPageErrors: ['TypeError: x'] }) })).problem, /^more page errors: /);
});

test('implementer-run records, a stale tip head, zero rows, a missing row, a missing base or a new state -> FAIL', () => {
  const fixture = lane(LOGIC_IN_BUTTON);
  const plan = planOf(fixture);
  const rows = mapRows(plan, 'identical');
  assert.match(prove(fixture, plan, proofRecords(fixture, plan, { rows, agentType: 'implementer' })).problem, /^no runner or visual-qa run at /);
  assert.match(prove(fixture, plan, proofRecords(fixture, plan, { rows, tipHead: fixture.base })).problem, /^no runner or visual-qa run at /);
  assert.match(prove(fixture, plan, proofRecords(fixture, plan, { rows: [] })).problem, /^zero rows/);
  assert.match(prove(fixture, plan, proofRecords(fixture, plan, { rows: mapRows(plan, 'identical', {}, [B]) })).problem, /^missing row: /);
  assert.match(prove(fixture, plan, proofRecords(fixture, plan, { rows }).slice(1)).problem, /^the tip run's base ledger/);
  assert.match(prove(fixture, plan, proofRecords(fixture, plan, { rows: mapRows(plan, 'identical', { verdict: 'new' }) })).problem, /^new state with no base render \(the visual plan/);
  const pass = visualQaPass(fixture);
  assert.equal(prove(fixture, plan, [pass]).problem, null, 'a visual-qa PASS proves render');
  const same = planOf(fixture, { requestText: 'no visual change' });
  assert.match(prove(fixture, same, [pass]).problem, /^no runner or visual-qa run/, 'never same');
});

test('check --plan: a pixel plan prints exactly today\'s check; an unreadable store is FAIL', () => {
  const { dir, base, tip } = lane(LOOK_IN_BUTTON);
  const brief = path.join(makeTempDir('ui-plan-brief-'), 'brief.md');
  fs.writeFileSync(brief, 'Match the Figma design.\n');
  const today = cli(['check', '--tip', tip, '--repo', dir]);
  assert.deepEqual(cli(['check', '--tip', tip, '--plan', '--base', base, '--request', brief, '--repo', dir]), today);
  const proofDir = makeTempDir('ui-plan-proof-');
  fs.writeFileSync(storeFile(dir, { UI_PROOF_STATE_DIR: proofDir }), '{not json');
  const broken = cli(['check', '--tip', tip, '--plan', '--base', base, '--repo', dir], { UI_PROOF_STATE_DIR: proofDir });
  assert.equal(broken.code, 1);
  assert.match(broken.out, /^plan: render\nui-proof: FAIL - the proof records cannot be read/);
});

/** Run the hook's recordRun for a run whose ledger names `root`, from `cwd`; the record it wrote. */
async function recordFrom(cwd, root) {
  const runDir = makeTempDir('ui-plan-run-');
  fs.writeFileSync(path.join(runDir, 'ledger.json'), JSON.stringify({ states: [], root, head: null, captures: [{ key: KEY_A, file: 'w360.png', sha256: null, findings: [], pageErrors: [] }] }));
  fs.writeFileSync(path.join(runDir, 'results.json'), '[]');
  const prior = process.env.UI_PROOF_STATE_DIR;
  process.env.UI_PROOF_STATE_DIR = makeTempDir('ui-plan-store-');
  try {
    assert.equal(await recordRun({ cwd, agent_type: 'runner', tool_input: { command: 'ui-check run --matrix m.json' },
      tool_response: { stdout: `result: PASS run - 1 state - results ${path.join(runDir, 'results.json')}` } }), true);
    return readRecords(storeFile(cwd)).at(-1);
  } finally {
    if (prior === undefined) delete process.env.UI_PROOF_STATE_DIR;
    else process.env.UI_PROOF_STATE_DIR = prior;
  }
}

test('hook cwd = main checkout, ledger root = a linked worktree: the record\'s uiTree is the worktree\'s; another repo or no root: cwd\'s', async () => {
  const { dir } = lane(LOOK_IN_BUTTON);
  const worktree = path.join(fs.realpathSync.native(makeTempDir('ui-plan-wt-')), 'wt');
  git(dir, ['worktree', 'add', '-q', '-b', 'lane', worktree, 'HEAD~1']);
  assert.notEqual(workingUiTree(worktree), workingUiTree(dir));
  const linked = await recordFrom(dir, worktree);
  assert.equal(linked.uiTree, workingUiTree(worktree));
  assert.match(linked.ledgerSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(linked.captures, [{ key: KEY_A, sha256: null, findings: [], pageErrors: [] }]);
  assert.equal((await recordFrom(dir, lane({ 'x.css': 'a{}\n' }).dir)).uiTree, workingUiTree(dir));
  assert.equal((await recordFrom(dir, undefined)).uiTree, workingUiTree(dir));
});

// ---- Review round R1-R4 (the probes of the ui-plan review, as tests) ----

test('R1: a floor or a design word never drops same: a deps-only change with a changed render fails under every request', () => {
  const fixture = lane({ 'package.json': APP['package.json'].replace('19.0.0', '19.1.0') });
  for (const requestText of ['', 'UI-PLAN: render\n', 'UI-PLAN: visual\n', 'Bump react; keep it pixel perfect.\n']) {
    const plan = planOf(fixture, { requestText });
    assert.ok(plan.surfaces.length === 2 && plan.surfaces.every((s) => s.needs.includes('same')), `${JSON.stringify(requestText)}: ${JSON.stringify(needs(plan))}`);
    const records = [...proofRecords(fixture, plan, { rows: mapRows(plan, 'identical', { verdict: 'changed' }) }), visualQaPass(fixture)];
    assert.match(prove(fixture, plan, records).problem ?? 'PASS', /^unexpected visual change: react-router:\/a \/ rest \/ en @360$/, JSON.stringify(requestText));
    assert.equal(prove(fixture, plan, [...proofRecords(fixture, plan, { rows: mapRows(plan, 'identical') }), visualQaPass(fixture)]).problem, null);
  }
  assert.deepEqual(needs(planOf(fixture, { requestText: 'UI-PLAN: visual\n' })), { [A]: 'same+visual', [B]: 'same+visual' });
  assert.deepEqual(needs(planOf(lane(LOGIC_IN_BUTTON), { requestText: 'UI-PLAN: same\n' })), { [A]: 'same+render' }, 'a same floor adds the identical-render proof');
});

test('R2: a visible change in an Astro, JSX-in-.js, react-import or Expo repo never plans none; a plain tool repo stays none', () => {
  const repos = {
    astro: [{ 'src/pages/index.astro': '<h1>Welcome</h1>\n' }, { 'src/pages/index.astro': '<h1>Welcome - 50% off</h1>\n' }],
    mdx: [{ 'content/intro.mdx': '# Hello\n' }, { 'content/intro.mdx': '# Hello there\n' }],
    jsxInJs: [{ 'src/App.js': 'export default function App() { return <p>Hello</p>; }\n' }, { 'src/App.js': 'export default function App() { return <p className="big">Pay now</p>; }\n' }],
    reactImport: [{ 'src/useTotal.js': "import { useMemo } from 'react';\nexport const useTotal = (a) => useMemo(() => a, [a]);\n" }, { 'src/useTotal.js': "import { useMemo } from 'react';\nexport const useTotal = (a) => useMemo(() => a + 1, [a]);\n" }],
    expo: [{ 'package.json': '{"dependencies":{"expo":"52.0.0"}}\n', 'src/total.js': 'export const total = (a) => a;\n' }, { 'src/total.js': 'export const total = (a) => a + 1;\n' }],
  };
  for (const [name, [files, change]] of Object.entries(repos)) assert.notEqual(planOf(lane(change, [], files)).depth, 'none', name);
  const tool = lane({ 'lib/tool.js': 'export const less = (a, b) => a < b && b > 0;\n' }, [], { 'package.json': '{"scripts":{"test":"node --test"}}\n', 'lib/tool.js': 'export const less = (a, b) => a < b;\n' });
  assert.equal(planOf(tool).depth, 'none');
});

test('R3: a render proof covers every width, locale and state of the map, of the plan\'s own run matrix', () => {
  const fixture = lane(LOGIC_IN_BUTTON);
  const matrixDir = makeTempDir('ui-plan-matrix-');
  const matrixPath = path.join(matrixDir, 'matrix.json');
  fs.writeFileSync(matrixPath, JSON.stringify({ root: fixture.dir, widths: [360, 1280], locales: [{ tag: 'en', dir: 'ltr' }, { tag: 'fa', dir: 'rtl' }], surfaces: [], cells: [] }));
  const plan = planOf(fixture, { matrixPath });
  assert.deepEqual([plan.map.widths, plan.map.locales.map((l) => l.tag), plan.map.states], [[360, 1280], ['en', 'fa'], ['rest']]);
  const oneRow = mapRows(plan, 'identical').filter((r) => r.key === KEY_A);
  assert.equal(prove(fixture, plan, proofRecords(fixture, plan, { rows: oneRow })).problem,
    `missing row: no render of ${A} / rest / en @1280, ${A} / rest / fa @360, ${A} / rest / fa @1280`);
  assert.match(prove(fixture, plan, proofRecords(fixture, plan, { rows: mapRows(plan, 'identical'), matrixHash: 'f'.repeat(64) })).problem,
    /^the tip run rendered matrix sha256 ffffffffffff, not the plan's [0-9a-f]{12}: /);
  assert.equal(prove(fixture, plan, proofRecords(fixture, plan, { rows: mapRows(plan, 'identical') })).problem, null);
  const withLocales = planOf(lane(LOGIC_IN_BUTTON, [], { ...APP, 'src/locales/en.json': '{}\n', 'src/locales/fa/common.json': '{}\n', 'tests/fixtures/locales/xx.json': '{}\n' }));
  assert.deepEqual(withLocales.map.locales, [{ tag: 'en', dir: 'ltr' }, { tag: 'fa', dir: 'rtl' }]);
  assert.match(withLocales.map.source, /locales of the repository's locale folders/);
  assert.deepEqual([plan.map.source, planOf(fixture).map.source], ['widths of the lane matrix, locales of the lane matrix', 'default widths, locale en: the repository has no locale folder']);
});

test('R4: STATUS standing rules and owner decisions are never request evidence; the request itself still is', () => {
  const { dir, base, tip } = lane(LOGIC_IN_BUTTON);
  const folder = makeTempDir('ui-plan-status-');
  const rule = '- not every UI work is a full pixel-perfect job: a light change gets a light check; pixel-perfect stays full where it applies {R24}\n';
  fs.writeFileSync(path.join(folder, 'STATUS.md'), `# Job\n\n## Standing rules\n${rule}\n## Owner decisions\n- match the Figma frame for login\n`);
  fs.writeFileSync(path.join(folder, 'brief.md'), `Fix the total.\n\n## Standing rules\n${rule}\n## Done\nok\n`);
  const status = cli(['plan', '--base', base, '--tip', tip, '--repo', dir, '--request', path.join(folder, 'STATUS.md')]);
  assert.equal(status.out.split('\n')[0], 'plan: render', status.out);
  assert.match(status.out, /^request STATUS\.md not read: STATUS rules and decisions are not the request \(pass the brief\)$/m);
  const brief = cli(['plan', '--base', base, '--tip', tip, '--repo', dir, '--request', path.join(folder, 'brief.md')]);
  assert.equal(brief.out.split('\n')[0], 'plan: render', brief.out);
  fs.writeFileSync(path.join(folder, 'brief.md'), 'Fix the total; keep it pixel perfect.\n');
  assert.equal(cli(['plan', '--base', base, '--tip', tip, '--repo', dir, '--request', path.join(folder, 'brief.md')]).out.split('\n')[0], 'plan: pixel');
});

test('R2 in ui-files: .astro, .svelte, .vue, .mdx and a .js with JSX or a UI import are UI files; a plain .js is not', () => {
  const uiRepos = {
    astro: { 'src/pages/index.astro': '<h1>Hi</h1>\n' }, svelte: { 'src/App.svelte': '<p>Hi</p>\n' }, vue: { 'src/App.vue': '<template><p/></template>\n' },
    mdx: { 'content/intro.mdx': '# Hi\n' }, jsxInJs: { 'src/App.js': 'export default function App() { return <p>Hi</p>; }\n' },
    expoImport: { 'src/total.js': "import { Text } from 'react-native';\nexport const total = (a) => a;\n" },
  };
  for (const [name, files] of Object.entries(uiRepos)) {
    const file = Object.keys(files)[0];
    const { dir, base, tip } = lane({ [file]: `${files[file]}// more\n` }, [], files);
    assert.notEqual(uiTreeAt(dir, tip), NO_UI_TREE, name);
    assert.deepEqual(changedUiFiles(dir, base, tip), [file], name);
    assert.equal(workingUiTree(dir), uiTreeAt(dir, tip), `${name}: a clean working tree hashes as its commit`);
  }
  const plain = lane({ 'lib/tool.js': 'export const less = (a, b) => a < b && b > 0;\n' }, [], { 'lib/tool.js': 'export const less = (a, b) => a < b;\n' });
  assert.equal(uiTreeAt(plain.dir, plain.tip), NO_UI_TREE);
  assert.deepEqual(changedUiFiles(plain.dir, plain.base, plain.tip), []);
});
