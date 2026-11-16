// The short rules from the PC sessions are in the files sessions load (seen live: the owner was asked 3 times on which
// machine to run a command; a runner kept a background loop alive).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

test('home/CLAUDE.md: a command the owner must run names the machine and the folder', () => {
  assert.match(read('home/CLAUDE.md'), /command the owner must run is given with the machine \(MacBook, PC or server\) and the folder/);
});

test('home/CLAUDE.md names the status tool for STATUS.md row edits', () => {
  assert.match(read('home/CLAUDE.md'), /tools\/status\/status\.mjs add\|done\|rule\|decision/);
});

test('runner agent never starts background loops or watchers', () => {
  assert.match(read('home/agents/runner.md'), /Never start a background loop, watcher, poller or dev server/);
});
