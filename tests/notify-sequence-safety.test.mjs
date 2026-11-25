// Tests for the cleaning of a note text before it goes into a terminal sequence (home/hooks/lib/notify-note.mjs noteSequence): no
// control, bidi or separator character reaches the terminal, and a note keeps its own fields.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { noteSequence } from '../home/hooks/lib/notify-note.mjs';

const ESC = '\u001b';
const BEL = '\u0007';
const BIDI_AND_SEPARATORS = ['‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩', ' ', ' ',
  '‎', '‏', '؜', '​', '⁠', '﻿', '­'];

test('control characters in a note text never reach the terminal sequence', () => {
  const note = noteSequence(`Needs you: Sco${ESC}]0;pwn${BEL}pe\n`, 'iterm2');
  assert.equal(note, `${ESC}]9;Claude: Needs you: Sco]0;pwnpe${BEL}`, 'only the sequence\'s own ESC and BEL remain');
});

test('a text cannot reorder or split the note: bidi overrides and isolates, line and paragraph separators and other format characters are dropped', () => {
  for (const character of BIDI_AND_SEPARATORS) {
    assert.equal(noteSequence(`Sc${character}op${character}e`, 'iterm2'), `${ESC}]9;Claude: Scope${BEL}`, `U+${character.codePointAt(0).toString(16)}`);
  }
  assert.equal(noteSequence(`${BIDI_AND_SEPARATORS.join('')}Scope`, 'iterm2'), `${ESC}]9;Claude: Scope${BEL}`);
});

test('the Ghostty sequence carries the title and the text as its two fields', () => {
  assert.equal(noteSequence('Needs you', 'ghostty'), `${ESC}]777;notify;Claude;Needs you${BEL}`);
});

test('zero-width joiners of Persian words stay in the sequence', () => {
  assert.equal(noteSequence('می‌خواهم', 'iterm2'), `${ESC}]9;Claude: می‌خواهم${BEL}`);
});

test('a text with a bidi override and a separator is cleaned in the sequence', () => {
  assert.equal(noteSequence('Failed: a‮b c', 'iterm2'), `${ESC}]9;Claude: Failed: abc${BEL}`);
});

test('a text that is only unsafe characters gives no sequence', () => {
  assert.equal(noteSequence('‮ \n', 'iterm2'), '');
});
