// Tests for the question header in the "needs you" note: the asking marker carries the first question's short header label
// (home/hooks/lib/asking-marker.mjs), the note shows it as "a question (Scope)" (home/hooks/lib/notify-note.mjs, home/hooks/notify.mjs).
// One cap (MAX_HEADER_CHARS) and one cleaning rule (cleanHeader) serve the writer and every reader; a marker written before the header
// existed reads with an empty header and gives the old note.
// Each test has a private HOME.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askingDir, cleanHeader, markAsking, MAX_HEADER_CHARS, readAsking } from '../home/hooks/lib/asking-marker.mjs';
import { noteSequence } from '../home/hooks/lib/notify-note.mjs';
import { noteFor } from '../home/hooks/notify.mjs';
import { writeSessionFile } from '../home/hooks/lib/session-store.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const OPENED_AT = 1_000_000;
const WAIT_S = 60;
const NOW = OPENED_AT + 15_000; // 15 s into the wait: the default is 45 s away
const privateEnv = () => {
  const home = makeTempDir('notify-scope-home-');
  return { HOME: home, USERPROFILE: home };
};
const entry = (session, extra = {}) => ({ session, kind: 'question', tool: 'AskUserQuestion', count: 1, openedAt: OPENED_AT, waitS: WAIT_S, ...extra });
const questionNote = (session, env) => noteFor({ hook_event_name: 'Notification', notification_type: 'elicitation_dialog', session_id: session }, env, NOW);

test('a one-question marker with a header gives "a question (Scope)" and the time to the default', () => {
  const env = privateEnv();
  markAsking(entry('scope-1', { header: 'Scope' }), env);
  assert.equal(questionNote('scope-1', env), 'Needs you: a question (Scope) · default in 0:45');
});

test('a several-question marker names the first question\'s header', () => {
  const env = privateEnv();
  markAsking(entry('scope-2', { count: 3, header: 'Auth method' }), env);
  assert.equal(questionNote('scope-2', env), 'Needs you: question 1 of 3 (Auth method) · default in 2:45');
});

test('a marker written before the header existed reads with an empty header and gives the old note', () => {
  const env = privateEnv();
  const old = { session: 'scope-3', kind: 'question', tool: 'AskUserQuestion', count: 1, openedAt: OPENED_AT, expiresAt: OPENED_AT + 120_000 };
  assert.equal(writeSessionFile(askingDir(env), 'scope-3', JSON.stringify(old)), true);
  assert.equal(readAsking('scope-3', env, NOW).header, '');
  assert.equal(questionNote('scope-3', env), 'Needs you: a question · default in 0:45');
});

test('no header, an empty one or a header that is not text give no parentheses', () => {
  const env = privateEnv();
  for (const [index, header] of [undefined, '', '   ', 42, { a: 1 }, null].entries()) {
    const session = `scope-none-${index}`;
    markAsking(entry(session, { header }), env);
    assert.equal(readAsking(session, env, NOW).header, '', `header ${JSON.stringify(header)}`);
    assert.equal(questionNote(session, env), 'Needs you: a question · default in 0:45');
  }
});

test('the writer and the readers cut at the same length: a long header is kept at MAX_HEADER_CHARS characters, also when hand-written', () => {
  const env = privateEnv();
  const long = 'x'.repeat(MAX_HEADER_CHARS * 4);
  markAsking(entry('scope-5', { header: long }), env);
  assert.equal(readAsking('scope-5', env, NOW).header, 'x'.repeat(MAX_HEADER_CHARS));
  const handWritten = { session: 'scope-6', kind: 'question', tool: 't', count: 1, openedAt: OPENED_AT, expiresAt: OPENED_AT + 120_000, header: long };
  writeSessionFile(askingDir(env), 'scope-6', JSON.stringify(handWritten));
  assert.equal(readAsking('scope-6', env, NOW).header, 'x'.repeat(MAX_HEADER_CHARS));
  assert.equal(cleanHeader('é'.repeat(MAX_HEADER_CHARS + 5)).length, MAX_HEADER_CHARS);
});

test('control characters in a header never reach the terminal sequence', () => {
  const env = privateEnv();
  markAsking(entry('scope-7', { header: 'Sco\u001b]0;pwn\u0007pe\n' }), env);
  const note = questionNote('scope-7', env);
  assert.equal(note, 'Needs you: a question (Sco]0pwnpe) · default in 0:45');
  const sequence = noteSequence(note, 'iterm2');
  assert.equal(sequence, `\u001b]9;Claude: ${note}\u0007`, 'only the sequence\'s own ESC and BEL remain');
});

const BIDI_AND_SEPARATORS = ['\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069', '\u2028', '\u2029',
  '\u200e', '\u200f', '\u061c', '\u200b', '\u2060', '\ufeff', '\u00ad'];

test('a header cannot reorder or split the note: bidi overrides and isolates, line and paragraph separators and other format characters are dropped', () => {
  const env = privateEnv();
  for (const [index, character] of BIDI_AND_SEPARATORS.entries()) {
    const session = `scope-format-${index}`;
    markAsking(entry(session, { header: `Sc${character}op${character}e` }), env);
    assert.equal(readAsking(session, env, NOW).header, 'Scope', `U+${character.codePointAt(0).toString(16)} in the marker`);
    assert.equal(questionNote(session, env), 'Needs you: a question (Scope) · default in 0:45');
  }
  assert.equal(cleanHeader(`${BIDI_AND_SEPARATORS.join('')}Scope`), 'Scope');
});

test('a hand-written marker header with a bidi override is cleaned by the reader too', () => {
  const env = privateEnv();
  const handWritten = { session: 'scope-bidi', kind: 'question', tool: 't', count: 1, openedAt: OPENED_AT, expiresAt: OPENED_AT + 120_000, header: '\u202eecoS' };
  writeSessionFile(askingDir(env), 'scope-bidi', JSON.stringify(handWritten));
  assert.equal(questionNote('scope-bidi', env), 'Needs you: a question (ecoS) · default in 0:45');
});

test('a semicolon in a header is dropped, so the Ghostty note keeps its fields; zero-width joiners of Persian words stay', () => {
  const env = privateEnv();
  markAsking(entry('scope-semicolon', { header: 'a;b;c' }), env);
  const note = questionNote('scope-semicolon', env);
  assert.equal(note, 'Needs you: a question (abc) · default in 0:45');
  assert.equal(noteSequence(note, 'ghostty'), `\u001b]777;notify;Claude;${note}\u0007`);
  assert.equal(cleanHeader('می\u200cخواهم'), 'می\u200cخواهم');
});

test('no note text carries a bidi override or a separator: a tool name with one is cleaned in the sequence too', () => {
  const env = privateEnv();
  const tool = `Ba\u202esh\u2028`;
  markAsking(entry('scope-tool', { kind: 'permission', tool }), env);
  const note = noteFor({ hook_event_name: 'Notification', notification_type: 'permission_prompt', session_id: 'scope-tool' }, env, NOW);
  assert.equal(note, 'Needs you: permission for Bash · default in 0:45');
  assert.equal(noteSequence(`Failed: a\u202eb\u2029c`, 'iterm2'), '\u001b]9;Claude: Failed: abc\u0007');
});

test('a permission marker keeps its tool text and shows no header', () => {
  const env = privateEnv();
  markAsking(entry('scope-8', { kind: 'permission', tool: 'Bash', header: 'Scope' }), env);
  const note = noteFor({ hook_event_name: 'Notification', notification_type: 'permission_prompt', session_id: 'scope-8' }, env, NOW);
  assert.equal(note, 'Needs you: permission for Bash · default in 0:45');
});
