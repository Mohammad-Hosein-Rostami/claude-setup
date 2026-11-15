// Tests for home/tools/recall/lib/owner-mask.mjs: what `recall --owner` masks and, as important, what it leaves readable.
// Fixtures are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { maskOwnerText, MAX_MASK_INPUT_CHARS } from '../home/tools/recall/lib/owner-mask.mjs';

const printsMasked = (cases) => {
  for (const [text, secret] of cases) {
    const masked = maskOwnerText(text);
    assert.ok(!masked.includes(secret), `"${text}" printed as "${masked}"`);
  }
};

test('a label that ends its line (with filler words or arrows) masks the next non-empty line whole', () => {
  printsMasked([
    ['رمزش اینه:\nsunflower', 'sunflower'], ['رمز سرور:\n\nsunflower', 'sunflower'], ['پسورد هست\nsunflower', 'sunflower'],
    ['password below\nsunflower', 'sunflower'], ['the password is:\nsunflower', 'sunflower'], ['token ->\nsunflower', 'sunflower'], ['token for the staging box:\nsunflower', 'sunflower'],
  ]);
  assert.equal(maskOwnerText('Password:\n\nsecretword\nnext line'), 'Password:\n\n[masked]\nnext line');
});

test('typos, Finglish and short forms are labels; the value after them, with any separator, is masked', () => {
  printsMasked([
    ['pasword: hunter2', 'hunter2'], ['passwrod hunter2', 'hunter2'], ['passwrd hunter2', 'hunter2'], ['psw: hunter2', 'hunter2'],
    ['pswd = hunter2', 'hunter2'], ['pw → hunter2', 'hunter2'], ['pw -> hunter2', 'hunter2'], ['pw => hunter2', 'hunter2'],
    ['pass: sunflower', 'sunflower'], ['ramz: sunflower', 'sunflower'], ['ramze man sunflower', 'sunflower'],
    ['sekret: sunflower', 'sunflower'], ['tokan: sunflower', 'sunflower'], ['the passwords are sunflower', 'sunflower'],
  ]);
});

test('a label inside a longer word is not a label', () => {
  for (const sentence of ['passwordless sign-in is nicer for users', 'the passing tests are green', 'tokenizer settings stay as they are', 'a pass-through proxy is not wanted']) {
    assert.equal(maskOwnerText(sentence), sentence);
  }
});

test('a value before the label is masked, ordinary words before it stay', () => {
  printsMasked([['Zqx9abc is the password', 'Zqx9abc'], ['use `hunter2` as the pass', 'hunter2'], ['SunFlower is my password', 'SunFlower'], ['a@b#c is the token', 'a@b#c']]);
  const masked = maskOwnerText('use the long ordinary words before the password is secretword');
  assert.ok(masked.startsWith('use the long ordinary words before the password') && !masked.includes('secretword'), masked);
  assert.equal(maskOwnerText('The password field needs a tooltip'), 'The password [masked]');
});

test('four or more single digits or digit groups are one value (Latin, Persian, Arabic digits)', () => {
  printsMasked([
    ['the code is 4 8 2 9 1 3', '8 2 9'], ['enter 4-8-2-9-1-3 now', '8-2-9'], ['enter 48 29 13 77 now', '29 13'],
    ['۴ ۸ ۲ ۹ ۱ ۳', '۸'], ['٤ ٨ ٢ ٩ ١ ٣', '٨'],
  ]);
});

test('harakat and tatweel inside a label do not hide it', () => {
  printsMasked([['رَمز: hunter2', 'hunter2'], ['رمـــز: sunflower', 'sunflower']]);
});

test('a token the 2,000-character limit cuts in two is dropped whole, so no part of a value prints', () => {
  const text = `${'a '.repeat(998)}Zqx9abcdefghij`;
  const masked = maskOwnerText(text);
  assert.ok(!masked.includes('Zqx9'), 'a value split by the cut printed in part');
  assert.ok(masked.length <= MAX_MASK_INPUT_CHARS);
});

// Ordinary instructions: these must stay exactly as written, so tightening the masks cannot silently wreck the listing.
const ORDINARY = [
  'use the DS uploader, not a custom one',
  'the code field has 5 digits and a 3 min timer',
  'images are 320px wide on mobile and node 22 is required',
  'run the tests in tests/recall-owner.test.mjs after every change',
  'snackbars bottom-left, one reusable system in shared',
  'reuse libs/shared/src/layouts and form-validation-core, animation-core',
  'the language switcher is a dropdown like the header menu',
  'keep the sidebar items as in Figma and change nothing else',
  'always run the full test suite before you say done',
  'mock the APIs and write e2e flow tests for every page',
  'why did you build your own uploader? use the design system one',
  'the passing tests and the passwordless login flow are fine',
  'دکمه ذخیره باید کنار فیلد قرار بگیرد',
  'انیمیشن ها باید با animation-core ساخته شوند',
  'همه صفحه ها باید از کامپوننت مشترک استفاده کنند',
];

test('ordinary instruction sentences, English and Persian, stay unchanged', () => {
  assert.ok(ORDINARY.length >= 12);
  for (const sentence of ORDINARY) assert.equal(maskOwnerText(sentence), sentence);
});
