// Tests for the reader's rule "when not sure a token is a name, count it and print nothing": every multi-line value shape
// from the security audit (PEM, dotenv colon form, YAML block scalar, escaped quotes, bash $'...', base32 padding).
// Each input plants a marker-like fragment (Zqx...) that must never come back as a name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { namesFromEnvText } from '../home/tools/env-names/lib/env-file-names.mjs';
import { PEM_BEGIN, PEM_END } from './env-names-fixtures.mjs';

const text = (...lines) => `${lines.join('\n')}\n`;

test('after a line that is not a definition nothing is parsed until the next blank line', () => {
  const result = namesFromEnvText(text('FIRST=1', 'stray MARKER_PART line', 'ZqxSwallowed=1', 'ZQX_SWALLOWED_TOO=2', '', 'AFTER=3'));
  assert.deepEqual(result, { names: ['AFTER', 'FIRST'], otherLines: 3 });
});

test('a PEM block is skipped whole, even when its body lines look like definitions', () => {
  const result = namesFromEnvText(text(`PRIVATE_KEY=${PEM_BEGIN}`, 'ZqxBody=abc', 'MIIEowIBAAKCAQEA', 'ZqxLastLine0==', PEM_END, 'AFTER=1'));
  assert.deepEqual(result, { names: ['AFTER', 'PRIVATE_KEY'], otherLines: 4 });
});

test('a PEM block that starts on a line of its own, or has no END, or begins and ends on one line', () => {
  assert.deepEqual(namesFromEnvText(text('-----BEGIN X-----', 'ZqxOne=1', '-----END X-----', 'B=2')), { names: ['B'], otherLines: 3 });
  assert.deepEqual(namesFromEnvText(text('K=-----BEGIN X-----abc-----END X-----', 'B=2')).names, ['B', 'K']);
  assert.deepEqual(namesFromEnvText('PRIVATE_KEY=-----BEGIN X-----\r\nZqxBody=abc\r\n').names, ['PRIVATE_KEY']);
});

test('unquoted PEM with a base64 last line ending in = (LF and CRLF) gives only the key name, over 200 random keys', () => {
  for (let round = 0; round < 200; round += 1) {
    const base64 = randomBytes(40 + round * 3).toString('base64').replace(/(.{64})/g, '$1\n');
    for (const eol of ['\n', '\r\n']) {
      const body = base64.trimEnd().split('\n').join(eol);
      const result = namesFromEnvText(`PRIVATE_KEY=${PEM_BEGIN}${eol}${body}${eol}${PEM_END}${eol}AFTER=1${eol}`);
      assert.deepEqual(result.names, ['AFTER', 'PRIVATE_KEY'], body);
    }
  }
});

test('a base64 body with no BEGIN header: its lines are skipped until the blank line', () => {
  const body = ['KEY_DATA=', 'MIIEowIBAAKCAQEAZqxLine', 'ZqxLastLine0==', '', 'AFTER=1'];
  assert.deepEqual(namesFromEnvText(text(...body)), { names: ['AFTER', 'KEY_DATA'], otherLines: 2 });
});

test('a line whose value is only = characters (base64 or base32 padding) is not a definition', () => {
  assert.deepEqual(namesFromEnvText(text('TOTP=', 'ZQXTOTPABCDEFG2====')), { names: ['TOTP'], otherLines: 1 });
  assert.deepEqual(namesFromEnvText(text('ZqxPad==', '', 'A=1')), { names: ['A'], otherLines: 1 });
});

test('dotenv colon form: KEY: "-----BEGIN ... is one value and the key itself is found', () => {
  const result = namesFromEnvText(text(`KEY: "${PEM_BEGIN}`, 'ZqxColonPad==', `${PEM_END}"`, 'AFTER: 1'));
  assert.deepEqual(result, { names: ['AFTER', 'KEY'], otherLines: 2 });
  assert.deepEqual(namesFromEnvText(text('Q: "open quote', 'ZqxColonPad==', 'ZqxMore=1', '"', 'B: 2')), { names: ['B', 'Q'], otherLines: 3 });
});

test('YAML block scalar value (.env.yaml shape): indented lines are not parsed, even after a blank line', () => {
  const result = namesFromEnvText(text('PRIVATE_KEY: |', '  ZqxYamlLine0=', '  ZqxYamlLine1==', '', '  ZqxAfterBlank=1', 'NEXT: 1'));
  assert.deepEqual(result, { names: ['NEXT', 'PRIVATE_KEY'], otherLines: 3 });
});

test('escaped closing quotes do not close a single-quoted or backtick value; a plain backtick value continues', () => {
  assert.deepEqual(namesFromEnvText(text("K='abc\\'", 'ZqxSqEsc=1', "'", 'B=2')), { names: ['B', 'K'], otherLines: 2 });
  assert.deepEqual(namesFromEnvText(text('K=`abc\\`', 'ZqxBtEsc=1', '`', 'B=2')), { names: ['B', 'K'], otherLines: 2 });
  assert.deepEqual(namesFromEnvText(text('K=`open', 'ZqxBacktick=1', '`', 'B=2')), { names: ['B', 'K'], otherLines: 2 });
});

test("a bash $'...' value that continues, and a continuation line after a backslash that opens a quote", () => {
  assert.deepEqual(namesFromEnvText(text("K=$'first", 'ZqxDollar=1', "'", 'B=2')), { names: ['B', 'K'], otherLines: 2 });
  assert.deepEqual(namesFromEnvText(text('K=a\\', '"open', 'ZqxAfterBackslash=1', '"', 'B=2')), { names: ['B', 'K'], otherLines: 3 });
});
