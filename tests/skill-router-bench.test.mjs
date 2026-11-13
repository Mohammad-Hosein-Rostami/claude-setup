// Routing benchmark for home/hooks/skill-router.mjs: EN and FA prompt tables (strong routes), negative rows that must
// route nothing, weak-word rows, and sticky rows (weak UI prompt with and without the session UI marker).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { skillsForPrompt, weakUiPrompt } from '../home/hooks/skill-router.mjs';

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
  const tmp = await mkdtemp(`${tmpdir()}/router-bench-`);
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
