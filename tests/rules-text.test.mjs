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

test('home/CLAUDE.md names the status tool for STATUS.md row edits', () => {
  assert.match(read('home/CLAUDE.md'), /tools\/status\/status\.mjs add\|start\|done\|deliver\|rule\|decision` only/);
});

test('runner agent never starts background loops or watchers', () => {
  assert.match(read('home/agents/runner.md'), /Never start a background loop, watcher, poller or dev server/);
});

// one-home-rules (R16 items 13, 16, 19): one home per rule, the three contradictions gone, lead-only text out of CLAUDE.md.
test('the owner-decision list is written once, in home/CLAUDE.md "Token discipline"; the other always-loaded files point there', () => {
  const files = ['home/CLAUDE.md', 'home/rules/core.md', 'home/lead-rules.md', 'home/lead.md'];
  const copies = files.flatMap((path) => read(path).match(/scope, money, irreversible/g) ?? []);
  assert.equal(copies.length, 1);
  assert.match(read('home/lead.md'), /Owner decisions \(the list in CLAUDE\.md "Token discipline"\)/);
});

test('questions wait 2 minutes (RC3); routing has no per-call model rule and no "Opus writes only a spec"', () => {
  for (const path of ['home/CLAUDE.md', 'home/lead-rules.md']) assert.doesNotMatch(read(path), /60 s wait|No answer in 60 s/, path);
  assert.match(read('home/CLAUDE.md'), /its own popup and its own 2-minute wait/);
  assert.doesNotMatch(read('home/lead.md'), /Every Agent call names a model/);
  assert.doesNotMatch(read('home/lead-rules.md'), /Opus writes only a/);
  assert.match(read('home/lead-rules.md'), /the guard gives Explore and general-purpose `sonnet`, Plan `opus`/);
});

test('Project config layers moved to lead-rules.md, which tells the lead to quote it in such a brief', () => {
  assert.doesNotMatch(read('home/CLAUDE.md'), /Project config layers/);
  assert.match(read('home/lead-rules.md'), /## Project AI config \(quote it in full in a brief that sets up or changes a project's AI config\)/);
});
