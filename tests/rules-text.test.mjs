// The short rules from the PC sessions are in the files sessions load (seen live: the owner was asked 3 times on which
// machine to run a command; a runner kept a background loop alive).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

// The owner's own machine names live in personal/CLAUDE.md; the shared text keeps the rule without them.
test('home/CLAUDE.md: a command the owner must run names the machine and the folder', () => {
  const text = read('home/CLAUDE.md');
  assert.match(text, /command the owner must run is given with the machine and the folder it runs in\./);
  assert.doesNotMatch(text, /MacBook/i, 'machine names are personal');
});

test('dev-run never starts background loops or watchers', () => {
  assert.match(read('home/agents/dev-run.md'), /Never start a watcher, a poller or a dev server/);
});

// one-home-rules (R16 items 13, 16, 19): one home per rule. home/rules/core.md and the lead rule files that pointed to the list
// were removed (lex-dev-tess plan), so home/CLAUDE.md is the one always-loaded file left.
test('the owner-decision list is written once among the always-loaded files', () => {
  const files = ['home/CLAUDE.md'];
  const copies = files.flatMap((path) => read(path).match(/scope, money, irreversible/g) ?? []);
  assert.equal(copies.length, 1);
});

test('questions wait 2 minutes (RC3)', () => {
  assert.doesNotMatch(read('home/CLAUDE.md'), /60 s wait|No answer in 60 s/);
  assert.match(read('home/CLAUDE.md'), /its own popup and its own 2-minute wait/);
});

// The lead-only "Project config layers" text left home/CLAUDE.md (it went to lead-rules.md, since removed with the lex-dev-tess plan).
test('home/CLAUDE.md holds no Project config layers section', () => {
  assert.doesNotMatch(read('home/CLAUDE.md'), /Project config layers/);
});
