// Text checks for the lessons folded in from the old reviewer and security-auditor notes (2026-11-22): the size caps of
// home/rules/principles.md and home/agents/reviewer.md, the `from:` defect class on every sharpened principle, the key clauses
// that carry each lesson, and that no part of the setup reads the old note folders any more. The checked project facts the old notes
// held live in the owner's project notes, which leave core (R22): their case moved with them to personal/tests/project-notes-facts.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(REPO, path), 'utf8');

const PRINCIPLES_MAX_BYTES = 6000; // the rule file loads into every session that edits a matching file
const REVIEWER_MAX_LINES = 110;
const SHARPENED = ['P1', 'P2', 'P3', 'P6', 'P7', 'P8', 'P9', 'P11', 'P12', 'P14', 'P15', 'P16'];

/** Principle rows keyed by id: `[id, areas, principle, question]`. */
function principleRows() {
  const rows = read('home/rules/principles.md')
    .split('\n')
    .filter((line) => /^P\d+ \|/.test(line))
    .map((line) => line.split(' | '));
  return Object.fromEntries(rows.map((row) => [row[0], row]));
}

test('principles.md stays within its byte cap', () => {
  assert.ok(Buffer.byteLength(read('home/rules/principles.md')) <= PRINCIPLES_MAX_BYTES);
});

test('every sharpened principle names the past defect class it comes from', () => {
  const rows = principleRows();
  for (const id of SHARPENED) assert.match(rows[id][2], /\(from: [^)]+\)$/, `${id} principle ends with its from: class`);
});

test('the folded lessons keep their whole clauses', () => {
  const rows = principleRows();
  const clauses = {
    P1: 'a timed-out hook is cancelled, not blocked',
    P2: "only in repos with provenance (a planted repo's config runs)",
    P3: 'an error is never read as empty, absent or passed',
    P7: 'a release checks it still owns the lock, a stale break never takes a live holder',
    P8: 'an installer, hook or `claude -p` under test gets a temp HOME, USERPROFILE, TMPDIR and session id',
    P9: 'a timed job longer than its tick never overlaps itself',
    P11: 'leads start in ~ (cwd proves no containment)',
    P12: 'each test fails without its fix: fakes act like the real dependency',
    P14: 'a child gets a minimal env, no secret in argv',
    P15: 'a removal touches only what lstat shows is ours, else backs up',
    P16: 'a pid alone is no identity',
  };
  for (const [id, clause] of Object.entries(clauses)) assert.ok(rows[id][2].includes(clause), `${id}: ${clause}`);
});

test('reviewer.md stays within its line cap and carries the proof rules', () => {
  const text = read('home/agents/reviewer.md');
  assert.ok(text.split('\n').length - 1 <= REVIEWER_MAX_LINES);
  for (const clause of [
    'run the same repro on a base copy',
    'needs an armed control (same fixture, the hazard left on) that fires',
    'A mutant counts as killed only by a named failing test',
    'base and tip side by side under the same load',
    'every other route, tool, CLI or hook that does the same action check it too',
    'Kinder fakes: a test double that forgives what the real dependency does not',
    "with a made-up `CLAUDE_CODE_SESSION_ID` (you share the lead's)",
  ]) assert.ok(text.replace(/\n\s*/g, ' ').includes(clause), clause);
});

/** Every file below `dir`, as paths relative to the repo. */
function filesBelow(dir) {
  return readdirSync(join(REPO, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules') return [];
    return statSync(join(REPO, path)).isDirectory() ? filesBelow(path) : [path];
  });
}

test('no part of the setup reads the old reviewer or security-auditor note folders', () => {
  const oldFolders = ['reviewer', 'security-auditor'].map((agent) => `agent-memory/${agent}`); // built, so this file does not match
  const hits = ['home', 'docs', 'scripts', 'tests']
    .flatMap(filesBelow)
    .filter((path) => oldFolders.some((folder) => readFileSync(join(REPO, path), 'latin1').includes(folder)));
  assert.deepEqual(hits, []);
});
