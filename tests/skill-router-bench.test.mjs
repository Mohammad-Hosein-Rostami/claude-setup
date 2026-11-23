// Routing benchmark for home/hooks/skill-router.mjs: EN and FA prompt tables (strong routes), negative rows that must
// route nothing, weak-word rows, and sticky rows (weak UI prompt with and without the session UI marker). Evidence rows
// (ui-kinds-spec.md section 3, router): talk and negated prompts route nothing, design words keep the pixel text byte for
// byte, any other UI request gets one check-plan line; edits name the skills of their line classes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { skillsForPrompt, weakUiPrompt } from '../home/hooks/skill-router.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/skill-router.mjs', import.meta.url));

const EN = [
  ['match the figma frame', 'figma-pixel-perfect'],
  ['implement this figma.com design', 'responsive-ui'],
  ['make it pixel perfect', 'figma-pixel-perfect'],
  ['make it responsive', 'responsive-ui'],
  ['text overflow on mobile', 'responsive-ui'],
  ['fix the breakpoint at 768px', 'responsive-ui'],
  ['check the mobile layout', 'responsive-ui'],
  ['the viewport is too narrow', 'responsive-ui'],
  ['fix the form validation', 'forms-validation'],
  ['add a form to the page', 'forms-validation'],
  ['validate the form fields', 'forms-validation'],
  ['add a loading state', 'async-ui-states'],
  ['show an empty state', 'async-ui-states'],
  ['add a skeleton while fetching', 'async-ui-states'],
  ['add pagination to the list', 'async-ui-states'],
  ['keyboard navigation is broken', 'accessibility-build'],
  ['add a focus ring', 'accessibility-build'],
  ['improve a11y of the menu', 'accessibility-build'],
  ['low contrast on the label', 'accessibility-build'],
  ['build the settings component', 'ui-quality-pass'],
  ['add a modal for deleting', 'ui-quality-pass'],
  ['fix the button styling', 'ui-quality-pass'],
  ['add tailwind classes', 'ui-quality-pass'],
];
const FA = [
  ['فرم ثبت نام بساز', 'forms-validation'],
  ['اعتبارسنجی فرم', 'forms-validation'],
  ['فرم ورود را درست کن', 'forms-validation'],
  ['فرم تماس با ما', 'forms-validation'],
  ['طرح فیگما را پیاده کن', 'figma-pixel-perfect'],
  ['مطابق فیگما بساز', 'figma-pixel-perfect'],
  ['طراحی را با فیگما مقایسه کن', 'figma-pixel-perfect'],
  ['ریسپانسیو کن', 'responsive-ui'],
  ['در موبایل خراب است', 'responsive-ui'],
  ['نمای موبایل را درست کن', 'responsive-ui'],
  ['صفحه را ریسپانسیو کن', 'responsive-ui'],
  ['فرم را در موبایل درست کن', 'responsive-ui'],
  ['صفحه تنظیمات را بساز', 'ui-quality-pass'],
  ['یک کامپوننت جدید بنویس', 'ui-quality-pass'],
  ['استایل کارت را عوض کن', 'ui-quality-pass'],
  ['طراحی صفحه اصلی', 'ui-quality-pass'],
  ['کامپوننت دکمه بساز', 'ui-quality-pass'],
  ['صفحه ورود را اصلاح کن', 'accessibility-build'],
  ['کامپوننت لیست را اصلاح کن', 'accessibility-build'],
  ['استایل صفحه را درست کن', 'accessibility-build'],
];
const NEGATIVE_EN = [
  'validate the JSON payload in the API',
  'add validation to the endpoint',
  'fix stack overflow in parser',
  'add a REST endpoint for orders',
  'fix the DB table index',
  'add a header to the HTTP request',
  'write the README section',
  'git rebase the feature branch',
  'commit and push the changes',
  'fix integer overflow in the hash function',
  'migrate the database schema',
  'bump the dependency versions',
];
const NEGATIVE_FA = [
  'یک endpoint برای سفارش‌ها اضافه کن',
  'ایندکس جدول دیتابیس را درست کن',
  'هدر HTTP را به درخواست اضافه کن',
  'تغییرات را commit کن',
  'مستندات README را به‌روز کن',
  'خطای stack overflow را رفع کن',
  'JSON را اعتبارسنجی کن',
  'branch را rebase کن',
  'نسخه وابستگی‌ها را بالا ببر',
  'اسکریپت مهاجرت دیتابیس را بنویس',
  'لاگ سرور را بررسی کن',
];
const WEAK_HITS = [
  'now style the settings page header',
  'change the colors',
  'increase the padding',
  'use a bigger font',
  'add a hover effect',
  'align the icons',
  'رنگ را عوض کن',
  'فونت را بزرگ‌تر کن',
  'فاصله را کم کن',
  'آیکون را عوض کن',
];
const WEAK_MISSES = ['add a header to the HTTP request', 'fix the DB table index', 'add a tab', 'open the menu file'];

const hits = (table) => table.filter(([prompt, skill]) => skillsForPrompt(prompt).includes(skill)).length;
const silent = (prompts) => prompts.filter((prompt) => skillsForPrompt(prompt).length === 0).length;
const total = EN.length + FA.length + NEGATIVE_EN.length + NEGATIVE_FA.length + WEAK_HITS.length + WEAK_MISSES.length;
const passed =
  hits(EN) + hits(FA) + silent(NEGATIVE_EN) + silent(NEGATIVE_FA) +
  WEAK_HITS.filter(weakUiPrompt).length + WEAK_MISSES.filter((p) => !weakUiPrompt(p)).length;

test(`routing bench: ${passed}/${total}`, () => {
  assert.ok(EN.length >= 20 && FA.length >= 20 && NEGATIVE_EN.length >= 10 && NEGATIVE_FA.length >= 10);
  for (const [prompt, skill] of [...EN, ...FA]) assert.ok(skillsForPrompt(prompt).includes(skill), prompt);
  for (const prompt of [...NEGATIVE_EN, ...NEGATIVE_FA]) assert.deepEqual(skillsForPrompt(prompt), [], prompt);
  for (const prompt of WEAK_HITS) assert.ok(weakUiPrompt(prompt), prompt);
  for (const prompt of WEAK_MISSES) assert.ok(!weakUiPrompt(prompt), prompt);
});

test('sticky rows: weak prompt follows up with the marker, stays silent without it', async () => {
  const tmp = makeTempDir('router-bench-');
  const env = { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
  const ask = (prompt, session_id) => {
    const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, session_id });
    const r = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', env });
    const context = r.stdout === '' ? '' : JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    // These rows test the UI follow-up; the gate lines (bug, done) are covered in skill-router.test.mjs.
    return context.split('\n').filter((line) => !/^Skill router: (bug or failure|done or ship) /.test(line)).join('\n');
  };
  ask('make it responsive', 'marked');
  for (const prompt of WEAK_HITS) {
    assert.match(ask(prompt, 'marked'), /UI follow-up/, prompt);
    assert.equal(ask(prompt, 'unmarked'), '', prompt);
  }
  for (const prompt of WEAK_MISSES) assert.equal(ask(prompt, 'marked'), '', prompt);
});

// ---- Evidence rows (spec checkpoints, EN and FA). The owner's two 2026-11-23 messages are quoted in ui-kinds-spec.md's header. ----
const TALK_OR_NEGATED = [
  'what do u mean by old screen problems?',
  'no dont do anything on pixel perfect or ui change',
  'we must not set kinds we must smartly understand what is the work that is needed and how sensitive it should be checked based on the user prompt',
  'no kinds, any needed ui work must be detected automatically and sensitivity on its needed checks as well',
  'the ui check chain is too heavy',
  'why did the pixel checks run on my docs page',
  'روی پیکسل پرفکت کاری نکن',
];
const PIXEL_ROWS = ['make it pixel perfect', "make it pixel perfect, don't skip the ui checks", 'build https://www.figma.com/design/AbC123/app?node-id=1-2', 'صفحه را مطابق فیگما بساز'];
const PLAN_ROWS = ['fix the button padding on the login screen', 'wire the profile screen to the new /me API', 'refactor the Dialog component into smaller parts'];
// The pixel text, as at BASE 739e0884 (the checkpoint: byte-equal); a change here is a change of the pixel path.
const PIXEL_FULL = 'Skill router: this request involves UI. Before writing UI code, invoke with the Skill tool: figma-pixel-perfect, responsive-ui (skip any' +
  ' already loaded in this context). A project skill with the same purpose whose paths match wins. Delegate UI implementation to the' +
  " `ui-implementer` agent, not `implementer`, and name these skills in the delegation prompt (a project's own `ui-implementer` preloads only" +
  ' project skills); run `ui-quality-pass` before saying done. Proof before "done" or "fixed": the UI lane runs `ui-check run` rounds until' +
  ' every state passes, then a `visual-qa` lane runs the final gate on the tree that lands; only its PASS counts.';
const PLAN_LINE = /^Skill router: UI change - invoke [\w-]+(, [\w-]+)* \(skip any already loaded\); ui-quality-pass before done; the check plan decides the depth \(standards\/ui-checks\.md, `ui-proof plan`\)\.$/;
const GATE = /^Skill router: (bug or failure|repository restructure|git history|repeated report)/;

/** A hook session in a temp folder (HOME, TMPDIR, no project folder); `fire` returns the UI part of additionalContext (gate lines apart). */
function hookSession() {
  const tmp = makeTempDir('router-evidence-');
  const env = { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp, HOME: tmp, USERPROFILE: tmp, CLAUDE_PROJECT_DIR: '', CLAUDE_SKILL_ROUTER: '' };
  const fire = (event) => {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(event), encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout === '' ? [] : JSON.parse(r.stdout).hookSpecificOutput.additionalContext.split('\n');
    return { ui: lines.filter((line) => !GATE.test(line)).join('\n'), gates: lines.filter((line) => GATE.test(line)) };
  };
  return { prompt: (text, session) => fire({ hook_event_name: 'UserPromptSubmit', prompt: text, session_id: session }), fire };
}

test('evidence rows: talk and negated prompts route nothing, design rows keep the pixel text, UI changes get one plan line', () => {
  const { prompt } = hookSession();
  for (const [i, text] of TALK_OR_NEGATED.entries()) {
    assert.deepEqual(skillsForPrompt(text), [], text);
    prompt('make it responsive', `talk-${i}`); // a UI session: weak words in a talk clause still give no follow-up
    assert.equal(prompt(text, `talk-${i}`).ui, '', text);
  }
  for (const [i, text] of PIXEL_ROWS.entries()) assert.match(prompt(text, `pixel-${i}`).ui, /^Skill router: this request involves UI\. .*`ui-check run` rounds/, text);
  assert.equal(prompt('make it pixel perfect', 'pixel-exact').ui, PIXEL_FULL);
  for (const [i, text] of PLAN_ROWS.entries()) {
    const { ui } = prompt(text, `plan-${i}`);
    assert.match(ui, PLAN_LINE, text);
    assert.doesNotMatch(ui, /pixel|ui-implementer|visual-qa|ui-check run/, text);
  }
});

test('F2/F3: gate routes are unchanged for a prompt the talk filter silences; a Figma link inside a pasted block still routes pixel', () => {
  const { prompt } = hookSession();
  const silenced = prompt('no dont do anything on pixel perfect or ui change, just fix the crash in checkout', 'gates');
  assert.equal(silenced.ui, '');
  assert.match(silenced.gates.join('\n'), /root-cause-debug/);
  const pasted = prompt('<pasted_content>see https://www.figma.com/design/AbC/app?node-id=3-4 for the frame</pasted_content>', 'pasted');
  assert.match(pasted.ui, /figma-pixel-perfect/);
});

test('edits name the skills of their line classes, once per class per session and agent; the user ui-implementer stays quiet', () => {
  const { fire } = hookSession();
  const edit = (file, toolInput, extra = {}) => fire({ hook_event_name: 'PostToolUse', session_id: 'edits', tool_input: { file_path: file, ...toolInput }, ...extra }).ui;
  const look = edit('src/Login.tsx', { old_string: '<Button>', new_string: '<Button className="mt-4 px-2">' });
  assert.match(look, /`responsive-ui`[\s\S]*`accessibility-build`[\s\S]*`ui-quality-pass`/);
  assert.doesNotMatch(look, /async-ui-states|ui-coverage|visual-qa/);
  assert.equal(edit('src/Other.tsx', { old_string: 'a', new_string: '<div className="x">' }), '', 'look again: once per session and agent');
  assert.match(edit('src/Profile.tsx', { old_string: "const r = await fetch('/api/me');", new_string: "const r = await fetch('/api/v2/me');" }), /`async-ui-states`[\s\S]*test/);
  assert.match(edit('src/locales/fa.json', { old_string: '"save": "ذخیره"', new_string: '"save": "ثبت"' }), /`ui-coverage`[\s\S]*every locale/);
  assert.equal(edit('docs/team/backend-onboarding.html', { old_string: '<p>old</p>', new_string: '<p class="x">new</p>' }, { agent_id: 'd1' }), '', 'a docs page: nothing (a fresh agent)');
  assert.match(edit('src/Login.tsx', { old_string: '<a>', new_string: '<a className="y">' }, { agent_id: 'w1' }), /editing UI look/, 'another agent');
  assert.equal(edit('src/Login.tsx', { old_string: '<a>', new_string: '<a className="y">' }, { agent_id: 'u1', agent_type: 'ui-implementer' }), '');
});

test('P1: an edit is classed from its first 128 KiB per side; a cut edit still counts as look and logic', () => {
  const { fire } = hookSession();
  const filler = 'const a = 1;\n'.repeat(20_000); // about 260 KB of logic lines: the look line after it is past the cap
  const ui = fire({ hook_event_name: 'PostToolUse', session_id: 'cap', tool_input: { file_path: 'src/Big.tsx', content: `${filler}<div className="late" />\n` } }).ui;
  assert.match(ui, /editing UI look[\s\S]*editing UI logic/);
  const test = fire({ hook_event_name: 'PostToolUse', session_id: 'cap', tool_input: { file_path: 'src/Big.test.tsx', content: filler }, agent_id: 't1' }).ui;
  assert.equal(test, '', 'a cut test file is still a test file');
});
