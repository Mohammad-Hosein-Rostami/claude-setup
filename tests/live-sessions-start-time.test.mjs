// Unit tests for startTimeOf in home/tools/disk-free/lib/live-sessions.mjs: the `ps -o lstart=` text in UTC with LC_ALL=C (what Claude
// Code writes as a session record's procStart on macOS) is read field by field into epoch ms; any other shape is null, so the caller keeps
// the pid-only answer. The record and ps side is in live-sessions-reused-pid.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTimeOf } from '../home/tools/disk-free/lib/live-sessions.mjs';

test('startTimeOf reads an lstart text as a UTC instant', () => {
  assert.equal(startTimeOf('Tue Nov 24 15:37:01 2026'), Date.UTC(2026, 10, 24, 15, 37, 1));
  assert.equal(startTimeOf('Wed Jan 07 00:00:59 2026'), Date.UTC(2026, 0, 7, 0, 0, 59));
});

test('startTimeOf takes a space-padded day and the blanks ps puts around the text', () => {
  assert.equal(startTimeOf('Sun Nov  1 08:05:09 2026'), Date.UTC(2026, 10, 1, 8, 5, 9));
  assert.equal(startTimeOf('  Sun Nov  1 08:05:09 2026   '), Date.UTC(2026, 10, 1, 8, 5, 9));
});

test('startTimeOf is null for anything that is not an lstart text: garbage, a number, null, epoch ms, Linux ticks, localized text', () => {
  const notLstart = [
    'garbage', '', 12345678, 1795406066578, null, undefined, {}, ['Tue Nov 24 15:37:01 2026'],
    '1795406066578', '12345678',
    'mar. 24 nov. 15:37:01 2026', // French ps output
    'Di 24 Nov 15:37:01 2026', // German ps output
    'Tue Foo 24 15:37:01 2026', // no such month
    'Tue Nov 24 15:37 2026', // no seconds
    '2026-11-24T15:37:01Z', // ISO text: Date would parse it, startTimeOf must not
    'Tue Nov 24 15:37:01 2026 extra',
  ];
  for (const text of notLstart) assert.equal(startTimeOf(text), null, JSON.stringify(text) ?? String(text));
});
