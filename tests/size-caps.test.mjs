// Size caps of the always-loaded text (node:test, no dependencies).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative) => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');

// The cap counts bytes (`wc -c`), not characters: UTF-8 text such as Persian costs more than its characters.
const byteSize = (text) => Buffer.byteLength(text, 'utf8');

// Every session loads home/CLAUDE.md whole; the speedups plan (U1, B8) caps it at 6500 bytes so the always-loaded text stays small.
const CLAUDE_MD_MAX_BYTES = 6500;
const CAPS = [{ file: 'home/CLAUDE.md', maxBytes: CLAUDE_MD_MAX_BYTES }];

const PERSIAN_TEXT = 'سلام';
const PERSIAN_TEXT_BYTES = 8;

test('byte counting counts UTF-8 bytes, not characters', () => {
  assert.equal(byteSize('abc'), 3);
  assert.equal(PERSIAN_TEXT.length, 4);
  assert.equal(byteSize(PERSIAN_TEXT), PERSIAN_TEXT_BYTES);
  assert.ok(byteSize(PERSIAN_TEXT) > PERSIAN_TEXT.length);
});

for (const { file, maxBytes } of CAPS) {
  test(`${file} stays at or under ${maxBytes} bytes`, () => {
    const bytes = byteSize(read(file));
    assert.ok(bytes <= maxBytes, `${file} is ${bytes} bytes, cap ${maxBytes}`);
  });
}
