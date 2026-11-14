// Tests for home/tools/ui-coverage/lib: expandMatrix (idempotent todo cells at every width), mergeResults and checkMatrix
// (one failing and one passing fixture per failure class), and formatReport. Fixtures are built in code from a fully passing matrix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { checkMatrix } from '../home/tools/ui-coverage/lib/check.mjs';
import { expandMatrix } from '../home/tools/ui-coverage/lib/cells.mjs';
import { formatReport } from '../home/tools/ui-coverage/lib/report.mjs';

const TEXT_FIELD_STATES = ['empty', 'focus', 'filled', 'error', 'success', 'disabled'];
const REASON = 'not part of this design file';

/** A matrix with 2 locales (en ltr, fa rtl), 2 widths, 1 screen with a text field and 1 email without controls. */
function baseMatrix() {
  return {
    locales: [{ tag: 'en', dir: 'ltr' }, { tag: 'fa', dir: 'rtl' }],
    widths: [320, 1280],
    searched: { backend: ['rg -il "mjml|hbs" api/ -> 1 hit'], siblings: ['rg -il tel ../web -> 2 hits'], reference: ['rg -il "validatePhone" ../ref-app -> 1 hit'] },
    deliverable: { reviewUrl: 'http://localhost:4099/review', mockExcluded: 'go build; grep -c authmock bin/app -> 0' },
    surfaces: [
      {
        id: 'login',
        kind: 'screen',
        source: 'src/login.tsx',
        controls: [{ id: 'phone', class: 'text field', component: 'src/ds/TelephoneInput.tsx', mountedAt: 'src/login.tsx:12', states: TEXT_FIELD_STATES, reference: 'web/Tel.tsx' }],
      },
      { id: 'welcome-email', kind: 'email', source: 'api/tpl/welcome.mjml', controls: 'none: static copy only, no controls' },
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
const messages = (result, code) => result.problems.filter((p) => p.code === code).map((p) => p.message).join('\n');
const isCell = (c, state, locale, width) => c.state === state && c.locale === locale && c.width === width;
const withCell = (matrix, state, locale, patch, width = 320) => ({
  ...matrix,
  cells: matrix.cells.map((c) => (isCell(c, state, locale, width) ? { ...c, ...patch } : c)),
});
const recordOf = (cell, patch = {}) => ({ surface: cell.surface, state: cell.state, locale: cell.locale, width: cell.width, status: 'pass', evidence: 'r/x.png', ...patch });

test('expandMatrix adds a todo cell per surface x state x locale x width', () => {
  const expanded = expandMatrix(baseMatrix());
  // login: (rest + 6 phone states) x 2 locales x 2 widths = 28; email: rest x 2 x 2 = 4  => 32
  assert.equal(expanded.cells.length, 32);
  assert.ok(expanded.cells.every((c) => c.status === 'todo' && Number.isInteger(c.width)));
  assert.ok(expanded.cells.some((c) => isCell(c, 'phone:error', 'fa', 1280)));
  assert.ok(expanded.cells.some((c) => c.surface === 'welcome-email' && isCell(c, 'rest', 'en', 320)));
});

test('expandMatrix is idempotent, keeps existing cells and does not mutate its input', () => {
  const input = baseMatrix();
  input.cells = [{ surface: 'login', state: 'rest', locale: 'en', width: 320, status: 'pass', evidence: 'a.png', reason: '' }];
  const snapshot = structuredClone(input);
  const once = expandMatrix(input);
  assert.deepEqual(input, snapshot);
  assert.equal(once.cells[0].status, 'pass');
  assert.equal(once.cells.length, 32);
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

test('na and deferred need a reason of 15+ characters; with one they pass and are listed in the summary', () => {
  const matrix = passingMatrix();
  for (const status of ['na', 'deferred']) {
    for (const reason of ['  ', 'n/a', 'no design']) {
      assert.ok(codes(checkMatrix(withCell(matrix, 'phone:success', 'en', { status, reason }))).has('no-reason'), `${status} ${reason}`);
    }
    const ok = checkMatrix(withCell(matrix, 'phone:success', 'en', { status, reason: 'no success state in the design' }));
    // a non-base locale of the same cell may not be na on its own, so only the base locale is changed for na
    assert.deepEqual(ok.problems.filter((p) => p.code !== 'na-locale'), [], status);
    assert.match(formatReport(ok), new RegExp(`${status}: login phone:success en @320.*no success state in the design`));
  }
});

test('pass without evidence is a problem', () => {
  assert.ok(codes(checkMatrix(withCell(passingMatrix(), 'phone:focus', 'en', { evidence: '' }))).has('no-evidence'));
});

test('a control needs a component path or a new-reason of 15+ characters', () => {
  const failing = (component) => passingMatrix((m) => { m.surfaces[0].controls[0].component = component; });
  for (const bad of [undefined, '', {}, { new: '' }, { new: '  ' }, { new: 'none exists' }]) assert.ok(codes(checkMatrix(failing(bad))).has('control-component'), JSON.stringify(bad));
  assert.deepEqual(checkMatrix(failing({ new: 'no phone field exists in the design system' })).problems, []); // mountedAt of the base control stays
});

test('a control needs states and a reference (a path or none with a reason)', () => {
  const edit = (patch) => passingMatrix((m) => Object.assign(m.surfaces[0].controls[0], patch));
  assert.ok(codes(checkMatrix(edit({ states: [] }))).has('control-states'));
  for (const bad of [undefined, '', 'none:', 'none:   ', 'none: unknown']) assert.ok(codes(checkMatrix(edit({ reference: bad }))).has('control-reference'), String(bad));
  assert.deepEqual(checkMatrix(edit({ reference: 'none: no reference app has this field' })).problems, []);
});

test('a default state of the control class may only be dropped with a reason', () => {
  const edit = (patch) => passingMatrix((m) => Object.assign(m.surfaces[0].controls[0], patch));
  const withoutSuccess = TEXT_FIELD_STATES.filter((s) => s !== 'success');
  assert.ok(codes(checkMatrix(edit({ states: withoutSuccess }))).has('default-state'));
  assert.ok(codes(checkMatrix(edit({ states: withoutSuccess, dropped: { success: '' } }))).has('default-state'));
  assert.deepEqual(checkMatrix(edit({ states: withoutSuccess, dropped: { success: 'the field has no success look' } })).problems, []);
});

test('class aliases map to their default state sets', () => {
  const states = (cls, list) => passingMatrix((m) => Object.assign(m.surfaces[0].controls[0], { class: cls, states: list }));
  assert.ok(codes(checkMatrix(states('dropdown', ['rest', 'open']))).has('default-state'));
  assert.deepEqual(checkMatrix(states('Dropdown', ['rest', 'focus', 'open', 'option-hover', 'selected', 'disabled', 'error'])).problems, []);
  assert.ok(codes(checkMatrix(states('checkbox', ['checked']))).has('default-state'));
  assert.ok(codes(checkMatrix(states('dialog', []))).has('control-states'));
});

test('control class is required and must be known or "other"; a misspelled class is a schema error naming the control', () => {
  const edit = (cls) => passingMatrix((m) => { m.surfaces[0].controls[0].class = cls; });
  for (const bad of [undefined, '', 'dropdwon', 'carousel']) {
    const result = checkMatrix(edit(bad));
    assert.deepEqual([...codes(result)], ['shape'], String(bad));
    assert.match(result.problems[0].message, /login control phone/);
  }
  const other = (states) => passingMatrix((m) => Object.assign(m.surfaces[0].controls[0], { class: 'other', states }));
  assert.deepEqual(checkMatrix(other(['rest'])).problems, []);
  assert.ok(codes(checkMatrix(other([]))).has('control-states'));
});

test('searched.backend must list at least one search', () => {
  for (const backend of [[], undefined, ['']]) {
    assert.ok(codes(checkMatrix(passingMatrix((m) => { m.searched = { backend, siblings: [] }; }))).has('no-search'), JSON.stringify(backend));
  }
  assert.deepEqual(checkMatrix(passingMatrix((m) => { m.searched.siblings = []; })).problems, []);
});

test('a project with an rtl locale needs an rtl pass cell for every surface', () => {
  const matrix = passingMatrix();
  const deferredRtl = { ...matrix, cells: matrix.cells.map((c) => (c.surface === 'welcome-email' && c.locale === 'fa' ? { ...c, status: 'deferred', reason: 'email is English only for now' } : c)) };
  const result = checkMatrix(deferredRtl);
  assert.ok(codes(result).has('no-rtl-pass'));
  assert.match(result.problems.find((p) => p.code === 'no-rtl-pass').message, /welcome-email/);
  const ltrOnly = passingMatrix((m) => { m.locales = [{ tag: 'en', dir: 'ltr' }]; });
  assert.ok(!codes(checkMatrix(ltrOnly)).has('no-rtl-pass'));
});

test('a locale-specific na is a problem unless the base locale is na for the same surface, state and width', () => {
  const matrix = passingMatrix();
  // 7 of 8 fa cells of the email na, one rest pass: the old rtl rule accepted this
  const mostlyNa = { ...matrix, cells: matrix.cells.map((c) => (c.surface === 'login' && c.locale === 'fa' && !isCell(c, 'rest', 'fa', 320) ? { ...c, status: 'na', reason: 'rtl not built yet, planned' } : c)) };
  const result = checkMatrix(mostlyNa);
  assert.ok(codes(result).has('na-locale'));
  assert.match(messages(result, 'na-locale'), /login phone:error fa @1280/);
  // na in the base locale and the same cell na in fa is fine
  const both = { ...matrix, cells: matrix.cells.map((c) => (c.state === 'phone:success' && c.width === 320 ? { ...c, status: 'na', reason: 'no success state in design' } : c)) };
  assert.ok(!codes(checkMatrix(both)).has('na-locale'));
  // deferred with a reason in fa is allowed
  const deferred = withCell(matrix, 'phone:success', 'fa', { status: 'deferred', reason: 'rtl field design pending' });
  assert.ok(!codes(checkMatrix(deferred)).has('na-locale'));
});

test('deliverable: reviewUrl needs a URL or an existing path, mockExcluded needs 15+ characters of proof', () => {
  for (const [field, bad] of [['reviewUrl', ' '], ['mockExcluded', ' '], ['mockExcluded', 'm'], ['mockExcluded', 'no mocks']]) {
    assert.ok(codes(checkMatrix(passingMatrix((m) => { m.deliverable[field] = bad; }))).has('deliverable'), `${field} ${bad}`);
  }
  assert.ok(codes(checkMatrix(passingMatrix((m) => { delete m.deliverable; }))).has('deliverable'));
  const local = passingMatrix((m) => { m.deliverable.reviewUrl = 'review/index.html'; });
  const seen = [];
  const missing = checkMatrix(local, [], { baseDir: '/proj', fileExists: (p) => { seen.push(p); return false; } });
  assert.match(messages(missing, 'deliverable'), /review\/index\.html/);
  assert.ok(seen.includes(resolve('/proj', 'review/index.html')));
  assert.deepEqual(checkMatrix(local, [], { baseDir: '/proj', fileExists: () => true }).problems, []);
});

test('a surface without controls needs "none: <reason of 15+ characters>"', () => {
  for (const bad of ['none:', 'none: static']) assert.ok(codes(checkMatrix(passingMatrix((m) => { m.surfaces[1].controls = bad; }))).has('surface-controls'), bad);
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
  assert.ok(codes(checkMatrix(extra({ width: null }))).has('unknown-cell'));
  assert.ok(codes(checkMatrix(extra({}))).has('duplicate-cell'));
});

test('a width that is not a positive integer or null is a schema error (cells) or a bad result (records)', () => {
  const matrix = passingMatrix();
  for (const width of ['abc', '320', 0, -5, 1.5, Number.NaN]) {
    assert.deepEqual([...codes(checkMatrix({ ...matrix, cells: [...matrix.cells, { ...matrix.cells[0], width }] }))], ['shape'], String(width));
    const todo = expandMatrix(baseMatrix());
    const result = checkMatrix(todo, [recordOf(todo.cells[0], { width })]);
    assert.ok(codes(result).has('bad-result'), String(width));
    assert.ok(codes(result).has('todo'), `${width}: the bad record fills nothing`);
  }
});

test('results fill todo cells at their own width: pass needs evidence, fail fails, fail beats pass', () => {
  const todo = expandMatrix(baseMatrix());
  const all = todo.cells.map((c) => recordOf(c));
  assert.deepEqual(checkMatrix(todo, all).problems, []);
  assert.equal(checkMatrix(todo, all.slice(1)).problems.filter((p) => p.code === 'todo').length, 1);
  assert.ok(codes(checkMatrix(todo, [...all, { ...all[0], status: 'fail', evidence: 'r/diff.png' }])).has('fail'));
  assert.ok(codes(checkMatrix(todo, [{ ...all[0], evidence: '' }, ...all.slice(1)])).has('no-evidence'));
});

test('a width that was never run stays todo: results at one width fill only that width', () => {
  const todo = expandMatrix(baseMatrix());
  const only320 = todo.cells.filter((c) => c.width === 320).map((c) => recordOf(c));
  const result = checkMatrix(todo, only320);
  assert.equal(result.problems.filter((p) => p.code === 'todo').length, 16);
  assert.ok(result.problems.filter((p) => p.code === 'todo').every((p) => /@1280/.test(p.message)));
  // a width-less record fills no width cell
  const widthless = todo.cells.map((c) => recordOf(c, { width: null }));
  const none = checkMatrix(todo, widthless);
  assert.equal(none.problems.filter((p) => p.code === 'todo').length, 32);
  assert.equal(none.problems.filter((p) => p.code === 'unmatched-result').length, 32);
});

test('a fail record on a na or deferred cell makes it a fail that says so', () => {
  const todo = expandMatrix(baseMatrix());
  const all = todo.cells.map((c) => recordOf(c));
  for (const status of ['na', 'deferred']) {
    const declared = { ...todo, cells: todo.cells.map((c) => (isCell(c, 'phone:focus', 'en', 1280) ? { ...c, status, reason: 'declared not applicable here' } : c)) };
    const failing = all.map((r) => (r.state === 'phone:focus' && r.locale === 'en' && r.width === 1280 ? { ...r, status: 'fail', evidence: 'r/d.png' } : r));
    const result = checkMatrix(declared, failing);
    assert.match(messages(result, 'fail'), new RegExp(`phone:focus en @1280 \\(declared ${status}, but a result failed\\)`), status);
    assert.equal(result.counts.fail, 1);
  }
});

test('a pass record turns todo, na and deferred into pass but never clears a fail from the matrix or another record', () => {
  const todo = expandMatrix(baseMatrix());
  const all = todo.cells.map((c) => recordOf(c));
  const failedCell = { ...todo, cells: todo.cells.map((c) => (isCell(c, 'phone:focus', 'en', 320) ? { ...c, status: 'fail', evidence: 'old/d.png' } : c)) };
  const cleared = checkMatrix(failedCell, all);
  assert.match(messages(cleared, 'fail'), /phone:focus en @320/);
  // a pass at another width does not touch it either
  const otherWidth = checkMatrix(failedCell, all.filter((r) => !(r.state === 'phone:focus' && r.locale === 'en' && r.width === 320)));
  assert.ok(codes(otherWidth).has('fail'));
  // fail in an older record list entry, pass later: still fail
  const mixed = [{ ...all[0], status: 'fail', evidence: 'r/d.png' }, ...all];
  assert.ok(codes(checkMatrix(todo, mixed)).has('fail'));
  // na / deferred with a pass record become pass
  const declared = { ...todo, cells: todo.cells.map((c) => (isCell(c, 'phone:focus', 'en', 320) ? { ...c, status: 'deferred', reason: 'declared deferred for now' } : c)) };
  const result = checkMatrix(declared, all);
  assert.deepEqual(result.problems, []);
  assert.equal(result.cells.find((c) => c.state === 'phone:focus' && c.locale === 'en' && c.width === 320).status, 'pass');
});

test('malformed result records and records matching no cell are reported', () => {
  const todo = expandMatrix(baseMatrix());
  const all = todo.cells.map((c) => recordOf(c));
  for (const bad of [null, 'x', { ...all[0], status: 'todo' }, { ...all[0], status: 'na' }, { surface: 'login' }]) {
    assert.ok(codes(checkMatrix(todo, [...all, bad])).has('bad-result'), JSON.stringify(bad));
  }
  assert.ok(codes(checkMatrix(todo, [...all, { ...all[0], state: 'phone:nope' }])).has('unmatched-result'));
});

test('evidence of a passing cell must be a URL or an existing file, resolved from the matrix directory', () => {
  const matrix = passingMatrix();
  const asked = [];
  const missingAll = checkMatrix(matrix, [], { baseDir: '/proj/ui', fileExists: (p) => { asked.push(p); return false; } });
  assert.equal(missingAll.problems.filter((p) => p.code === 'evidence-missing').length, 32);
  assert.ok(asked.includes(resolve('/proj/ui', 'out/x.png')));
  const urls = { ...matrix, cells: matrix.cells.map((c) => ({ ...c, evidence: 'https://ci.example/run/1/x.png' })) };
  assert.deepEqual(checkMatrix(urls, [], { baseDir: '/proj', fileExists: () => false }).problems, []);
  const fileUrl = { ...matrix, cells: matrix.cells.map((c) => ({ ...c, evidence: 'file:///tmp/x.png' })) };
  assert.deepEqual(checkMatrix(fileUrl, [], { baseDir: '/proj', fileExists: () => false }).problems, []);
  assert.deepEqual(checkMatrix(matrix, [], { baseDir: '/proj', fileExists: () => true }).problems, []);
});

test('stateWidths narrows control states only, needs a reason, and the reason is printed', () => {
  const narrowed = (edit = () => {}) => passingMatrix((m) => { m.stateWidths = [1280]; m.stateWidthsReason = 'control states are width independent'; edit(m); });
  const matrix = narrowed();
  // login: rest 4 + phone 6 states x 2 locales x 1 width = 12; email 4 => 20
  assert.equal(matrix.cells.length, 20);
  assert.deepEqual(checkMatrix(matrix).problems, []);
  assert.ok(matrix.cells.some((c) => c.state === 'rest' && c.width === 320));
  assert.ok(!matrix.cells.some((c) => c.state === 'phone:focus' && c.width === 320));
  assert.match(formatReport(checkMatrix(matrix)), /control states checked only at 1280 px: control states are width independent/);
  assert.ok(codes(checkMatrix(narrowed((m) => { delete m.stateWidthsReason; }))).has('state-widths'));
  assert.ok(codes(checkMatrix(narrowed((m) => { m.stateWidthsReason = 'same'; }))).has('state-widths'));
  for (const bad of [[], [999], 'x']) assert.deepEqual([...codes(checkMatrix({ ...baseMatrix(), stateWidths: bad, stateWidthsReason: 'control states are width independent' }))], ['shape'], JSON.stringify(bad));
});

test('formatReport prints counts per status first, then each problem', () => {
  const matrix = withCell(passingMatrix(), 'phone:focus', 'en', { status: 'fail', evidence: 'd.png' });
  const text = formatReport(checkMatrix(matrix));
  assert.match(text, /^result: FAIL, 1 cell, 1 cause\ncells: 32 \| pass 31 \| fail 1 \| na 0 \| deferred 0 \| todo 0 \| missing 0/);
  assert.match(text, /problems \(1 in 1 group\)/);
  assert.match(text, /fail: login phone:focus en @320/);
  assert.match(formatReport(checkMatrix(passingMatrix())), /^result: PASS\ncells: 32/);
});
