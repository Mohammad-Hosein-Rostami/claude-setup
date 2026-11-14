// Tests for home/tools/ui-coverage/lib: expandMatrix (idempotent todo cells), mergeResults and checkMatrix (one failing
// and one passing fixture per failure class), and formatReport. Fixtures are built in code from a fully passing matrix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMatrix } from '../home/tools/ui-coverage/lib/check.mjs';
import { expandMatrix } from '../home/tools/ui-coverage/lib/cells.mjs';
import { formatReport } from '../home/tools/ui-coverage/lib/report.mjs';

const TEXT_FIELD_STATES = ['empty', 'focus', 'filled', 'error', 'success', 'disabled'];

/** A matrix with 2 locales (en ltr, fa rtl), 2 widths, 1 screen with a text field and 1 email without controls. */
function baseMatrix() {
  return {
    locales: [{ tag: 'en', dir: 'ltr' }, { tag: 'fa', dir: 'rtl' }],
    widths: [320, 1280],
    searched: { backend: ['rg -il "mjml|hbs" api/ -> 1 hit'], siblings: ['rg -il tel ../web -> 2 hits'] },
    deliverable: { reviewUrl: 'http://localhost:4099/review', mockExcluded: 'go build; grep -c authmock bin/app -> 0' },
    surfaces: [
      {
        id: 'login',
        kind: 'screen',
        source: 'src/login.tsx',
        controls: [{ id: 'phone', class: 'text field', component: 'src/ds/TelephoneInput.tsx', states: TEXT_FIELD_STATES, reference: 'web/Tel.tsx' }],
      },
      { id: 'welcome-email', kind: 'email', source: 'api/tpl/welcome.mjml', controls: 'none: static copy only' },
    ],
    cells: [],
  };
}

/** The base matrix with every expected cell present and passing. */
function passingMatrix(edit = () => {}) {
  const matrix = baseMatrix();
  edit(matrix);
  const expanded = expandMatrix(matrix);
  return { ...expanded, cells: expanded.cells.map((cell) => ({ ...cell, status: 'pass', evidence: 'out/x.png' })) };
}

const codes = (result) => new Set(result.problems.map((p) => p.code));
const withCell = (matrix, state, locale, patch) => ({
  ...matrix,
  cells: matrix.cells.map((c) => (c.state === state && c.locale === locale && c.width !== 1280 ? { ...c, ...patch } : c)),
});

test('expandMatrix adds a todo cell per surface x state x locale (rest also per width)', () => {
  const expanded = expandMatrix(baseMatrix());
  // login: rest 2 locales x 2 widths = 4, phone 6 states x 2 locales = 12; email: rest 4  => 20
  assert.equal(expanded.cells.length, 20);
  assert.ok(expanded.cells.every((c) => c.status === 'todo'));
  assert.ok(expanded.cells.some((c) => c.surface === 'login' && c.state === 'phone:error' && c.locale === 'fa' && c.width === null));
  assert.ok(expanded.cells.some((c) => c.surface === 'welcome-email' && c.state === 'rest' && c.locale === 'en' && c.width === 320));
});

test('expandMatrix is idempotent, keeps existing cells and does not mutate its input', () => {
  const input = baseMatrix();
  input.cells = [{ surface: 'login', state: 'rest', locale: 'en', width: 320, status: 'pass', evidence: 'a.png', reason: '' }];
  const snapshot = structuredClone(input);
  const once = expandMatrix(input);
  assert.deepEqual(input, snapshot);
  assert.equal(once.cells[0].status, 'pass');
  assert.equal(once.cells.length, 20);
  assert.deepEqual(expandMatrix(once), once);
});

test('a fully passing matrix has no problems', () => {
  assert.deepEqual(checkMatrix(passingMatrix()).problems, []);
});

test('missing cell, todo cell and fail cell are each reported', () => {
  const matrix = passingMatrix();
  const missing = { ...matrix, cells: matrix.cells.slice(1) };
  assert.ok(codes(checkMatrix(missing)).has('missing-cell'));
  assert.ok(codes(checkMatrix(withCell(matrix, 'phone:focus', 'en', { status: 'todo' }))).has('todo'));
  assert.ok(codes(checkMatrix(withCell(matrix, 'phone:focus', 'en', { status: 'fail', evidence: 'd.png' }))).has('fail'));
  assert.ok(codes(checkMatrix(withCell(matrix, 'phone:focus', 'en', { status: 'maybe' }))).has('cell-status'));
});

test('na and deferred need a reason; with one they pass and are listed in the summary', () => {
  const matrix = passingMatrix();
  for (const status of ['na', 'deferred']) {
    assert.ok(codes(checkMatrix(withCell(matrix, 'phone:success', 'en', { status, reason: '  ' }))).has('no-reason'), status);
    const ok = checkMatrix(withCell(matrix, 'phone:success', 'en', { status, reason: 'no success state in the design' }));
    assert.deepEqual(ok.problems, [], status);
    assert.match(formatReport(ok), new RegExp(`${status}: login phone:success en.*no success state in the design`));
  }
});

test('pass without evidence is a problem', () => {
  assert.ok(codes(checkMatrix(withCell(passingMatrix(), 'phone:focus', 'en', { evidence: '' }))).has('no-evidence'));
});

test('a control needs a component path or a new-reason', () => {
  const failing = (component) => passingMatrix((m) => { m.surfaces[0].controls[0].component = component; });
  for (const bad of [undefined, '', {}, { new: '' }, { new: '  ' }]) assert.ok(codes(checkMatrix(failing(bad))).has('control-component'), JSON.stringify(bad));
  assert.deepEqual(checkMatrix(failing({ new: 'no phone field exists in the design system' })).problems, []);
});

test('a control needs states and a reference (a path or none with a reason)', () => {
  const edit = (patch) => passingMatrix((m) => Object.assign(m.surfaces[0].controls[0], patch));
  assert.ok(codes(checkMatrix(edit({ states: [] }))).has('control-states'));
  for (const bad of [undefined, '', 'none:', 'none:   ']) assert.ok(codes(checkMatrix(edit({ reference: bad }))).has('control-reference'), String(bad));
  assert.deepEqual(checkMatrix(edit({ reference: 'none: no reference app has this field' })).problems, []);
});

test('a default state of the control class may only be dropped with a reason', () => {
  const edit = (patch) => passingMatrix((m) => Object.assign(m.surfaces[0].controls[0], patch));
  const withoutSuccess = TEXT_FIELD_STATES.filter((s) => s !== 'success');
  assert.ok(codes(checkMatrix(edit({ states: withoutSuccess }))).has('default-state'));
  assert.ok(codes(checkMatrix(edit({ states: withoutSuccess, dropped: { success: '' } }))).has('default-state'));
  assert.deepEqual(checkMatrix(edit({ states: withoutSuccess, dropped: { success: 'the field has no success look' } })).problems, []);
  // an unknown class has no defaults
  assert.deepEqual(checkMatrix(edit({ class: 'carousel', states: ['rest'] })).problems, []);
});

test('class aliases map to their default state sets', () => {
  const states = (cls, list) => passingMatrix((m) => Object.assign(m.surfaces[0].controls[0], { class: cls, states: list }));
  assert.ok(codes(checkMatrix(states('dropdown', ['rest', 'open']))).has('default-state'));
  assert.deepEqual(checkMatrix(states('Dropdown', ['rest', 'focus', 'open', 'option-hover', 'selected', 'disabled', 'error'])).problems, []);
  assert.ok(codes(checkMatrix(states('checkbox', ['checked']))).has('default-state'));
  assert.ok(codes(checkMatrix(states('dialog', []))).has('control-states'));
});

test('searched.backend must list at least one search', () => {
  for (const backend of [[], undefined, ['']]) {
    assert.ok(codes(checkMatrix(passingMatrix((m) => { m.searched = { backend, siblings: [] }; }))).has('no-search'), JSON.stringify(backend));
  }
  assert.deepEqual(checkMatrix(passingMatrix((m) => { m.searched.siblings = []; })).problems, []);
});

test('a project with an rtl locale needs an rtl pass cell for every surface', () => {
  const matrix = passingMatrix();
  const noRtlPass = { ...matrix, cells: matrix.cells.map((c) => (c.surface === 'welcome-email' && c.locale === 'fa' ? { ...c, status: 'na', reason: 'email is English only' } : c)) };
  const result = checkMatrix(noRtlPass);
  assert.ok(codes(result).has('no-rtl-pass'));
  assert.match(result.problems.find((p) => p.code === 'no-rtl-pass').message, /welcome-email/);
  const ltrOnly = passingMatrix((m) => { m.locales = [{ tag: 'en', dir: 'ltr' }]; });
  assert.ok(!codes(checkMatrix(ltrOnly)).has('no-rtl-pass'));
});

test('deliverable fields must not be empty', () => {
  for (const field of ['reviewUrl', 'mockExcluded']) {
    assert.ok(codes(checkMatrix(passingMatrix((m) => { m.deliverable[field] = ' '; }))).has('deliverable'), field);
  }
  assert.ok(codes(checkMatrix(passingMatrix((m) => { delete m.deliverable; }))).has('deliverable'));
});

test('a surface without controls needs "none: <reason>"', () => {
  assert.ok(codes(checkMatrix(passingMatrix((m) => { m.surfaces[1].controls = 'none:'; }))).has('surface-controls'));
});

test('structural errors stop the check with shape problems', () => {
  const broken = [
    (m) => { m.locales = []; },
    (m) => { m.locales[0].dir = 'up'; },
    (m) => { m.widths = []; },
    (m) => { m.widths = [320, -1]; },
    (m) => { m.surfaces = []; },
    (m) => { m.surfaces[0].kind = 'hologram'; },
    (m) => { m.surfaces[1].id = 'login'; },
    (m) => { m.surfaces[0].controls = 'whatever'; },
  ];
  for (const edit of broken) assert.deepEqual([...codes(checkMatrix(passingMatrix(edit)))], ['shape'], edit.toString());
  assert.deepEqual([...codes(checkMatrix(null))], ['shape']);
});

test('a cell that matches no surface, state, locale or width is reported, as is a duplicate', () => {
  const matrix = passingMatrix();
  const extra = (patch) => ({ ...matrix, cells: [...matrix.cells, { ...matrix.cells[0], ...patch }] });
  assert.ok(codes(checkMatrix(extra({ surface: 'ghost' }))).has('unknown-cell'));
  assert.ok(codes(checkMatrix(extra({ locale: 'de' }))).has('unknown-cell'));
  assert.ok(codes(checkMatrix(extra({ width: 999 }))).has('unknown-cell'));
  assert.ok(codes(checkMatrix(extra({}))).has('duplicate-cell'));
});

test('results fill todo cells: pass needs evidence, fail fails, fail beats pass', () => {
  const todo = expandMatrix(baseMatrix());
  const record = (surface, state, locale, width, status = 'pass', evidence = 'r/x.png') => ({ surface, state, locale, width, status, evidence });
  const all = todo.cells.map((c) => record(c.surface, c.state, c.locale, c.width));
  assert.deepEqual(checkMatrix(todo, all).problems, []);
  assert.equal(checkMatrix(todo, all.slice(1)).problems.filter((p) => p.code === 'todo').length, 1);
  const failed = [...all, { ...all[0], status: 'fail', evidence: 'r/diff.png' }];
  assert.ok(codes(checkMatrix(todo, failed)).has('fail'));
  assert.ok(codes(checkMatrix(todo, [{ ...all[0], evidence: '' }, ...all.slice(1)])).has('no-evidence'));
});

test('a result with the viewport width fills a width-less state cell; one that matches no cell is a problem', () => {
  const todo = expandMatrix(baseMatrix());
  const all = todo.cells.map((c) => ({ surface: c.surface, state: c.state, locale: c.locale, width: c.width ?? 1280, status: 'pass', evidence: 'e' }));
  assert.deepEqual(checkMatrix(todo, all).problems, []);
  assert.ok(codes(checkMatrix(todo, [...all, { ...all[0], state: 'phone:nope' }])).has('unmatched-result'));
});

test('malformed result records are reported; na and deferred cells keep their declared status', () => {
  const todo = expandMatrix(baseMatrix());
  const all = todo.cells.map((c) => ({ surface: c.surface, state: c.state, locale: c.locale, width: c.width, status: 'pass', evidence: 'e' }));
  for (const bad of [null, 'x', { ...all[0], status: 'todo' }, { ...all[0], status: 'na' }, { surface: 'login' }]) {
    assert.ok(codes(checkMatrix(todo, [...all, bad])).has('bad-result'), JSON.stringify(bad));
  }
  const declared = { ...todo, cells: todo.cells.map((c) => (c.state === 'phone:success' && c.locale === 'en' ? { ...c, status: 'na', reason: 'not designed' } : c)) };
  const result = checkMatrix(declared, all);
  assert.deepEqual(result.problems, []);
  assert.equal(result.cells.find((c) => c.state === 'phone:success' && c.locale === 'en').status, 'na');
});

test('formatReport prints counts per status first, then each problem', () => {
  const matrix = withCell(passingMatrix(), 'phone:focus', 'en', { status: 'fail', evidence: 'd.png' });
  const text = formatReport(checkMatrix(matrix));
  assert.match(text, /^cells: 20 \| pass 19 \| fail 1 \| na 0 \| deferred 0 \| todo 0 \| missing 0/);
  assert.match(text, /problems \(1\)/);
  assert.match(text, /fail: login phone:focus en/);
  assert.match(formatReport(checkMatrix(passingMatrix())), /result: PASS/);
});
