// Tests of the UI check evidence vocabulary (home/tools/ui-proof/lib/ui-evidence.mjs): plan depths and the stricter-wins rule, the
// classes of changed files and lines (markup, style, logic, text, docs pages, Windows paths, whitespace-only and huge inputs), and the
// request evidence in English and Persian (design words, Figma links, no-change, talk about the checks, negation). Pure module: no
// git, no files; the tables are the spec's named cases (ui-kinds-spec.md section 15, lane ui-evidence).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DEPTHS, FILE_CLASSES, FIGMA_LINK, DESIGN_WORDS, UI_WORDS, classifyFile, planEvidence, requestEvidence, stricterDepth, uiClauses,
} from '../home/tools/ui-proof/lib/ui-evidence.mjs';

const MODULE = new URL('../home/tools/ui-proof/lib/ui-evidence.mjs', import.meta.url);
const HANG_GUARD = { timeout: 20000 }; // a backtracking regex on these inputs would run for minutes; linear code ends in well under 1 s

// The owner's 2026-11-23 messages (STATUS standing rules R24 and R28, and the spec's quote): about the checks, never a design request.
const OWNER_MESSAGES = [
  "not every UI work is a full pixel-perfect or full UI implementation and check job: some is syncing the API with the UI, changing a condition, a polish, a refactor of UI code, or a docs .html page; deep analysis and improve the setup so the checks fit the kind of UI work (pixel-perfect stays full where it applies)",
  "UI checks: 'we must not set kinds; we must smartly understand what is the work that is needed and how sensitive it should be checked based on the user prompt and need, not set limitations or kinds'; 'any needed ui work must be detected automatically and sensitivity on its needed checks as well' (no waivers)",
  'no kinds, any needed ui work must be detected automatically and sensitivity on its needed checks as well',
  'we must smartly understand what is the work that is needed and how sensitive it should be checked based on the user prompt and need',
];

test('DEPTHS: ordered and frozen; FILE_CLASSES frozen', () => {
  assert.deepEqual(DEPTHS, ['none', 'same', 'render', 'visual', 'pixel']);
  assert.deepEqual(FILE_CLASSES, ['test', 'docs', 'devConfig', 'deps', 'globalLook', 'look', 'text', 'logic']);
  assert.ok(Object.isFrozen(DEPTHS) && Object.isFrozen(FILE_CLASSES));
});

test('stricterDepth: the later depth wins for every pair, both ways; pixel is never lowered', () => {
  for (const [i, a] of DEPTHS.entries()) {
    for (const [j, b] of DEPTHS.entries()) assert.equal(stricterDepth(a, b), DEPTHS[Math.max(i, j)], `${a} ${b}`);
    assert.equal(stricterDepth('pixel', a), 'pixel');
    assert.equal(stricterDepth(a, 'pixel'), 'pixel');
  }
});

test('stricterDepth and planEvidence: a value that is not a depth throws, so a bad input cannot lower a plan', () => {
  for (const bad of ['', 'PIXEL', 'kind', null, undefined, 4, 'none ']) {
    assert.throws(() => stricterDepth('pixel', bad), TypeError, String(bad));
    assert.throws(() => stricterDepth(bad, 'none'), TypeError, String(bad));
    assert.throws(() => planEvidence(bad), TypeError, String(bad));
  }
});

test('planEvidence: the landing row suffix of each depth', () => {
  assert.equal(planEvidence('render'), ' (ui plan render: proved)');
  for (const depth of DEPTHS) assert.equal(planEvidence(depth), ` (ui plan ${depth}: proved)`);
});

const PATH_CASES = [
  ['docs/team/a.html', ['<p>Team onboarding</p>'], 'docs'],
  ['docs/guide/setup.md', ['Run the tests'], 'docs'],
  ['docs/email-templates/a.html', ['<p>Your code</p>'], 'look'],
  ['docs/welcome-email.html', ['<p>Hello</p>'], 'look'],
  ['docs/templates/invoice.html', ['<td>Total</td>'], 'look'],
  ['src/app/docs/page.tsx', ['<h1>Docs</h1>'], 'look'],
  ['public/docs/help.html', ['<p>Help</p>'], 'look'],
  ['src/x.test.tsx', ['<div className="a" />'], 'test'],
  ['src/components/Card.stories.tsx', ['<Card />'], 'test'],
  ['src/__tests__/card.tsx', ['<Card />'], 'test'],
  ['e2e/login.spec.ts', ["await page.goto('/login')"], 'test'],
  ['eslint.config.js', ['export default []'], 'devConfig'],
  ['.eslintrc.cjs', ['module.exports = {}'], 'devConfig'],
  ['tsconfig.json', ['"strict": true'], 'devConfig'],
  ['tsconfig.app.json', ['"strict": true'], 'devConfig'],
  ['.github/x.yml', ['on: push'], 'devConfig'],
  ['.prettierrc', ['{}'], 'devConfig'],
  ['vitest.config.ts', ['export default {}'], 'devConfig'],
  ['README.md', ['# Title'], 'devConfig'],
  ['pnpm-lock.yaml', ['  react: 18.3.1'], 'deps'],
  ['yarn.lock', ['react@^18'], 'deps'],
  ['package-lock.json', ['"version": "1.0.0"'], 'deps'],
  ['src/theme/palette.ts', ["primary: '#1976d2',"], 'globalLook'],
  ['src/index.css', ['body { margin: 0 }'], 'globalLook'],
  ['src/styles/globals.css', ['body { margin: 0 }'], 'globalLook'],
  ['index.html', ['<div id="root"></div>'], 'globalLook'],
  ['tailwind.config.js', ['content: []'], 'globalLook'],
  ['src/fonts/inter.woff2', null, 'globalLook'],
  ['locales/fa.json', ['"save": "ذخیره"'], 'text'],
  ['src/i18n/en.yaml', ['save: Save'], 'text'],
  ['src/content/about.md', ['We build things'], 'text'],
  ['src/components/Card.module.css', ['.card { padding: 4px }'], 'look'],
  ['src/components/Card.styles.ts', ['export const card = {}'], 'look'],
  ['src/assets/logo.svg', null, 'look'],
];

test('classifyFile: path rules of the named cases (one class each)', () => {
  for (const [file, lines, expected] of PATH_CASES) assert.deepEqual(classifyFile(file, lines && [], lines), [expected], file);
});

test('classifyFile: dev config is a whole basename; app files named like a tool are app source (R3)', () => {
  for (const file of ['.eslintrc', '.eslintrc.json', '.eslintignore', 'prettier.config.mjs', '.prettierrc.yaml', '.stylelintrc.cjs', '.lintstagedrc',
    '.markdownlint.jsonc', '.mocharc.yml', '.nycrc', 'jest.setup.ts', 'playwright.config.ts', 'tsconfig.node.json', 'jsconfig.json',
    'renovate.json', '.editorconfig', '.gitlab-ci.yml', 'Jenkinsfile', 'CODEOWNERS', 'LICENSE', 'license.txt']) {
    assert.deepEqual(classifyFile(file, [], ['x']), ['devConfig'], file);
  }
  const heading = ['<h1 className="t">License</h1>'];
  for (const file of ['src/pages/license.tsx', 'src/license-banner.tsx', 'src/renovate-card.vue', 'src/tsconfig-viewer.tsx', 'src/prettier.tsx', 'src/eslint-report.tsx']) {
    assert.ok(classifyFile(file, [], heading).includes('look'), file);
  }
});

test('classifyFile: Windows backslash paths follow the same docs, test, style and config rules', () => {
  for (const [file, lines, expected] of PATH_CASES) {
    const windows = file.replace(/\//g, '\\');
    assert.deepEqual(classifyFile(windows, lines && [], lines), [expected], windows);
  }
  assert.deepEqual(classifyFile('.\\Docs\\Team\\A.HTML', [], ['<p>x</p>']), ['docs'], 'case and a leading .\\');
});

test('classifyFile: package.json dependency lines are deps; metadata and test or lint script lines are dev config', () => {
  assert.deepEqual(classifyFile('package.json', [], ['    "react": "^18.3.1",']), ['deps']);
  assert.deepEqual(classifyFile('package.json', ['    "zod": "3.22.0"'], ['    "zod": "3.23.8"']), ['deps']);
  assert.deepEqual(classifyFile('package.json', [], ['    "@ui/kit": "workspace:*",']), ['deps']);
  assert.deepEqual(classifyFile('package.json', [], ['    "build": "vite build --base /app"']), ['deps'], 'a build script changes the output');
  assert.deepEqual(classifyFile('package.json', [], ['  "sideEffects": false,']), ['deps'], 'can drop css imports');
  assert.deepEqual(classifyFile('package.json', [], ['    "lint": "eslint ."', '  "description": "x"']), ['devConfig']);
  assert.deepEqual(classifyFile('package.json', [], ['    "lint": "^1.0.0"']), ['deps'], 'a dependency named lint');
  assert.deepEqual(classifyFile('apps/web/package.json', null, null), ['deps'], 'by path only');
});

const LINE_CASES = [
  // look: markup, class names, sx, style, styled, css values and declarations
  ['<div className="card">', ['look']],
  ['<Card>', ['look']],
  ['</section>', ['look']],
  ['<>', ['look']],
  ['sx={{ p: 2, mt: 1 }}', ['look']],
  ["style={{ color: 'red' }}", ['look']],
  ['class="btn btn-primary"', ['look']],
  ['const Box = styled.div`', ['look']],
  ['  font-size: 14px;', ['look']],
  ['  display: flex;', ['look']],
  ['  fontSize: 14,', ['look']],
  ["import './card.css'", ['look']],
  ['variant="primary"', ['look']],
  ['disabled', ['look']],
  ['/>', ['look']],
  ['~~~ ### @@@', ['look']],
  // look and logic on one line
  ['onClick={() => save(form)}', ['look', 'logic']],
  ['{isOpen && <Modal />}', ['look', 'logic']],
  ['return <Empty />;', ['look', 'logic']],
  // text: JSX text, FA text, an i18n call
  ['Save your changes', ['text']],
  ["Don't have an account?", ['text']],
  ['ذخیره تغییرات', ['text']],
  ['Settings', ['text']],
  ["{t('profile.save')}", ['text']],
  // logic: fetch, conditions, state, imports, generics, types, comments
  ["const res = await fetch('/api/me');", ['logic']],
  ['if (user.isAdmin) {', ['logic']],
  ['const [open, setOpen] = useState<boolean>(false);', ['logic']],
  ["import { useQuery } from '@tanstack/react-query';", ['logic']],
  ['export default Profile', ['logic']],
  ['  name: string;', ['logic']],
  ['  width: number;', ['logic']],
  ['for (let i = 0; i<n; i++) {', ['logic']],
  ['});', ['logic']],
  ['// load the profile first', ['logic']],
  ["'use client'", ['logic']],
];

test('classifyFile: line classes in an app .tsx (markup, style, text and logic lines)', () => {
  for (const [line, expected] of LINE_CASES) assert.deepEqual(classifyFile('src/pages/Profile.tsx', [], [line]), expected, line);
});

test('classifyFile: a removed line counts like an added one; a file takes the union of its lines in FILE_CLASSES order', () => {
  assert.deepEqual(classifyFile('src/Card.tsx', ['<div className="card">'], []), ['look'], 'a removed class name is a look change');
  assert.deepEqual(classifyFile('src/Card.tsx', ['  const a = 1;'], ['<p>Hi</p>', 'Save your changes']), ['look', 'text', 'logic']);
});

test('classifyFile: non-markup scripts have no JSX text; style words still count as look', () => {
  assert.deepEqual(classifyFile('src/api/client.ts', [], ['Save your changes']), ['look'], 'unparseable in a .ts: look');
  assert.deepEqual(classifyFile('src/api/client.ts', [], ['  return res.json();']), ['logic']);
  assert.deepEqual(classifyFile('src/ui/card.ts', [], ["export const card = css`padding: 4px;`"]), ['look'], 'a style declaration');
  assert.deepEqual(classifyFile('src/ui/card.ts', [], ['const pad = theme.spacing(2) + 4px']), ['look', 'logic'], 'a method call on a look line');
});

test('classifyFile: markup and style lines in .vue, .svelte and .html files', () => {
  assert.deepEqual(classifyFile('src/App.vue', [], ['.card {', '  color: red;']), ['look']);
  assert.deepEqual(classifyFile('src/App.vue', [], ['v-if="user.isAdmin"']), ['look', 'logic']);
  assert.deepEqual(classifyFile('src/routes/+page.svelte', [], ['<h1>Welcome</h1>']), ['look']);
  assert.deepEqual(classifyFile('server/views/report.html', [], ['Monthly report']), ['text']);
  assert.deepEqual(classifyFile('cmd/web/main.go', [], ['\tw.Write([]byte("<p>ok</p>"))']), ['look', 'logic'], 'html in a Go string');
  assert.deepEqual(classifyFile('cmd/web/main.go', [], ['\tif err != nil {']), ['logic']);
});

test('classifyFile: unknown lines and file types count as look, never as nothing (P3)', () => {
  assert.deepEqual(classifyFile('src/pages/Profile.tsx', [], ['@@ ~~ %%']), ['look']);
  assert.deepEqual(classifyFile('src/pages/Profile.tsx', null, null), ['look', 'logic'], 'lines unknown: look and logic');
  assert.deepEqual(classifyFile('src/data/plans.json', [], ['"price": 9']), ['look'], 'unknown file type');
  assert.deepEqual(classifyFile('Dockerfile', [], ['FROM node:22']), ['look']);
  assert.deepEqual(classifyFile('browserslist', [], ['> 0.5%']), ['look'], 'browserslist changes the built css');
});

test('classifyFile: empty diff, whitespace-only changes and blank lines give no class, never a crash (F2)', () => {
  assert.deepEqual(classifyFile('src/Card.tsx', [], []), []);
  assert.deepEqual(classifyFile('src/Card.tsx', ['  <div>', '  </div>'], ['    <div>', '', '    </div>', '   ']), [], 're-indent');
  assert.deepEqual(classifyFile('src/index.css', ['body{}'], ['body{}  ']), [], 'trailing space in a global css');
  assert.deepEqual(classifyFile('', [], []), []);
  assert.deepEqual(classifyFile('', null, null), ['look'], 'no path, no lines: look');
  assert.deepEqual(classifyFile('src/Card.tsx', ['Hello world'], ['Helloworld']), ['text'], 'a space inside text is visible');
  assert.deepEqual(classifyFile('src/a.py', ['x = 1'], ['  x = 1']), ['logic'], 'indentation is meaning in python');
  assert.deepEqual(classifyFile('src/a.sass', ['.a'], ['  .a']), ['look'], 'and in sass');
});

test('classifyFile: huge lines and files stay linear (F4)', HANG_GUARD, () => {
  const minified = `.a{color:red}${'.b{margin:0;padding:1px}'.repeat(200000)}`;
  assert.deepEqual(classifyFile('dist/app.min.css', [], [minified]), ['look']);
  const lockfile = Array.from({ length: 100000 }, (_, i) => `  /pkg-${i}@1.0.${i}: { resolution: { integrity: sha512-${'a'.repeat(30)} } }`);
  assert.deepEqual(classifyFile('pnpm-lock.yaml', [], lockfile), ['deps']);
  assert.deepEqual(classifyFile('src/bundle.js', [], [`${'a('.repeat(50000)}`]), ['look', 'logic'], 'over the line cap: both');
  const nearCap = ['<'.repeat(3999), 'a '.repeat(1999), `${'a-'.repeat(1999)}x`, `.a${'['.repeat(3990)}`, `x${' '.repeat(3990)}<`];
  for (const line of nearCap) assert.ok(classifyFile('src/App.vue', [], [line]).length > 0, line.slice(0, 20));
  assert.deepEqual(classifyFile('src/App.vue', [], [' '.repeat(3999)]), [], 'a blank line is no change');
});

// ---- Requests ----
const DESIGN_CASES = [
  'https://www.figma.com/design/AbC123/Plans?node-id=12-34',
  'make it pixel perfect',
  'Make it Pixel-Perfect',
  'match the design of the settings frame',
  'build the settings screen to match the frame',
  'صفحه را مطابق فیگما بساز',
  'این صفحه باید پیکسل پرفکت باشد',
  'کارت را مطابق طرح بساز',
  "make it pixel perfect, don't skip the ui checks",
  'make it pixel perfect and don\'t skip the ui checks',
  "don't skip pixel perfect on this screen",
  'the header is not pixel perfect yet',
  'make the login screen pixel perfect so the ui check passes',
  'make it pixel perfect with no regressions',
  'صفحه را مطابق فیگما بساز و تست‌ها را رد نکن',
];

const NO_DESIGN_CASES = [
  ...OWNER_MESSAGES,
  'what do u mean by old screen problems?',
  'no dont do anything on pixel perfect or ui change',
  'the pixel checks are heavy',
  'the ui check chain is too heavy',
  'why did the pixel checks run on my docs page',
  'روی پیکسل پرفکت کاری نکن',
  'بدون پیکسل پرفکت',
  'چک‌های پیکسل خیلی کند هستند',
  'how much work do you think is left?',
  'wire the profile screen to the new /me API',
  'fix the button padding on the login screen',
  '',
];

test('requestEvidence: design words and Figma links in EN and FA give design evidence', () => {
  for (const text of DESIGN_CASES) assert.ok(requestEvidence(text).design.length > 0, text);
  assert.ok(requestEvidence('صفحه را مطابق فیگما بساز').design.includes('فیگما'));
});

test('requestEvidence: talk about the checks, negated clauses and plain UI requests give no design (F1)', () => {
  for (const text of NO_DESIGN_CASES) assert.deepEqual(requestEvidence(text).design, [], text);
});

test('requestEvidence: a Figma link counts in any clause, even negated or talk (pixel cannot be gamed down)', () => {
  const link = 'figma.com/design/AbC123/Plans';
  for (const text of [`don't use ${link}`, `the ui checks for ${link} are heavy`, `no visual change, see ${link}`, `بدون ${link}`]) {
    assert.ok(requestEvidence(text).design.some((phrase) => phrase.startsWith('figma.com/design/')), text);
  }
});

test('requestEvidence: noChange in EN and FA; it never removes design evidence', () => {
  for (const text of ['refactor only, no visual change', "don't change the look", 'keep the same look', 'the layout stays the same',
    'بدون تغییر ظاهر', 'ظاهر را تغییر نده', 'فقط ریفکتور']) {
    const evidence = requestEvidence(text);
    assert.ok(evidence.noChange.length > 0, text);
    assert.deepEqual(evidence.design, [], text);
  }
  assert.deepEqual(requestEvidence('refactor only, no visual change').noChange, ['refactor', 'no visual change']);
  const both = requestEvidence("refactor the card, don't change the look, then make the header pixel perfect");
  assert.ok(both.noChange.length > 0 && both.design.includes('pixel perfect'), 'both returned: the plan takes the stricter');
  assert.deepEqual(requestEvidence("don't refactor anything").noChange, [], 'a negated refactor');
  assert.deepEqual(requestEvidence('the ui checks say no visual change').noChange, [], 'talk');
});

test('requestEvidence: untrusted text is capped at 1 MB and only short phrases come back (P14)', HANG_GUARD, () => {
  const late = `${'a '.repeat(600000)} make it pixel perfect`; // the design words sit past the first 1 MB
  assert.deepEqual(requestEvidence(late).design, []);
  const many = requestEvidence('make it pixel perfect '.repeat(60000));
  assert.deepEqual(many.design, ['pixel perfect'], 'deduplicated');
  const spaced = requestEvidence(`pixel${' '.repeat(500000)}perfect`);
  assert.deepEqual(spaced.design, ['pixel perfect'], 'spaces collapsed, phrase short');
  const links = requestEvidence(Array.from({ length: 100 }, (_, i) => `figma.com/design/${i}/x`).join(' '));
  assert.ok(links.design.length <= 20 && links.design.every((phrase) => phrase.length <= 80));
  assert.deepEqual(requestEvidence(`${'no '.repeat(300000)}pixel perfect`).design, [], 'one long negated clause');
  assert.deepEqual(requestEvidence(`${'نکن '.repeat(200000)}پیکسل`).design, []);
});

test('requestEvidence: empty and missing text give nothing; a non-string throws', () => {
  for (const empty of ['', '   ', '\n\n', null, undefined]) assert.deepEqual(requestEvidence(empty), { design: [], noChange: [] });
  for (const bad of [42, {}, ['make it pixel perfect']]) assert.throws(() => requestEvidence(bad), TypeError);
});

test('uiClauses: talk and negated prompts route nothing; design keeps the pixel route; UI requests are UI (router bench rows)', () => {
  const nothing = [
    'what do u mean by old screen problems?', 'no dont do anything on pixel perfect or ui change', OWNER_MESSAGES[2], OWNER_MESSAGES[1],
    'the ui check chain is too heavy', 'why did the pixel checks run on my docs page', 'روی پیکسل پرفکت کاری نکن', '',
  ];
  for (const text of nothing) assert.deepEqual(uiClauses(text), { design: false, ui: false }, text);
  for (const text of ['make it pixel perfect', "make it pixel perfect, don't skip the ui checks", 'https://figma.com/design/x/y', 'صفحه را مطابق فیگما بساز']) {
    assert.deepEqual(uiClauses(text), { design: true, ui: true }, text);
  }
  for (const text of ['fix the button padding on the login screen', 'wire the profile screen to the new /me API', 'refactor the Dialog component into smaller parts', 'دکمه ذخیره را درست کن']) {
    assert.deepEqual(uiClauses(text), { design: false, ui: true }, text);
  }
});

test('the router reads the exported word lists: Figma link, design words, UI nouns', () => {
  assert.ok(FIGMA_LINK.test('see figma.com/file/abc') && !FIGMA_LINK.test('figma is nice'));
  assert.ok(DESIGN_WORDS.test('pixel perfect') && DESIGN_WORDS.test('مطابق طرح') && !DESIGN_WORDS.test('the design doc'));
  assert.ok(UI_WORDS.test('the login screen') && UI_WORDS.test('این صفحه') && !UI_WORDS.test('the database page size'));
  for (const pattern of [FIGMA_LINK, DESIGN_WORDS, UI_WORDS]) assert.ok(!pattern.global, 'stateless for .test');
});

test('the module imports nothing, so the router can import it without a cycle (F5)', () => {
  assert.doesNotMatch(readFileSync(MODULE, 'utf8'), /^\s*import\b|\bimport\(|\brequire\(/m);
});
