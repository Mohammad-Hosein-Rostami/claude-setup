// Tests for the size refusal of review-tier: a whole-range `--landing` run over 400 changed lines or 15 files is exit 2 "split the lane"
// unless `--whole` is given; a fix round (`--delta`), a run without `--landing` and an empty range are never refused; `--whole` lifts only
// the size rule (the set and the tier stay those of the lane).
import test from 'node:test';
import assert from 'node:assert/strict';
import { git } from './git-tidy-helpers.mjs';
import { lane, priorFile } from './review-tier-helpers.mjs';

const MAX_LINES = 400;
const MAX_FILES = 15;
const linesOf = (count) => Array.from({ length: count }, (_, index) => `export const value${index} = ${index};\n`).join('');
const refusal = (lines, files) => `review-tier: split the lane: ${lines} changed lines in ${files} files (limit 400 / 15); --whole reviews it as one\n`;

test('size: a 401-line --landing range is exit 2 with the exact text, and --whole makes it exit 0', () => {
  const { raw, write } = lane();
  write('src/big.mjs', linesOf(MAX_LINES + 1));
  const refused = raw('--landing');
  assert.equal(refused.status, 2);
  assert.equal(refused.stderr, refusal(MAX_LINES + 1, 1));
  assert.equal(refused.stdout, '', 'a refused run prints no report');
  assert.equal(raw('--landing', '--whole').status, 0);
});

test('size: exactly 400 lines in 15 files is not refused; 16 files is', () => {
  const edge = lane();
  edge.write('src/edge.mjs', linesOf(MAX_LINES));
  assert.equal(edge.raw('--landing').status, 0, '400 lines');
  const many = lane();
  for (let index = 0; index < MAX_FILES; index++) many.write(`src/file${index}.mjs`, 'export const a = 1;\n');
  assert.equal(many.raw('--landing').status, 0, '15 files');
  many.write('src/file15.mjs', 'export const a = 1;\n');
  const refused = many.raw('--landing');
  assert.equal(refused.status, 2, '16 files');
  assert.equal(refused.stderr, refusal(MAX_FILES + 1, MAX_FILES + 1));
});

test('size F1: an empty range is not a size refusal', () => {
  const { raw } = lane();
  const empty = raw('--landing');
  assert.doesNotMatch(empty.stderr, /split the lane/);
  assert.equal(empty.status, raw('--landing', '--whole').status, '--whole changes nothing on an empty range');
});

test('size F2: a --delta over 400 lines is never refused', () => {
  const { json, tier, write, dir } = lane();
  const reviewed = write('src/a.mjs', 'export const a = 1;\n');
  write('src/big.mjs', linesOf(MAX_LINES + 1));
  const delta = tier('--delta', reviewed, '--prior', priorFile());
  assert.equal(delta.status, 0, delta.stderr);
  assert.equal(json('--delta', reviewed, '--prior', priorFile()).changedLines, MAX_LINES + 1);
  assert.equal(git(dir, 'status', '--short'), '', 'read-only');
});

test('size F3: a run without --landing (smart-check, the road gate) is never refused', () => {
  const { raw, write } = lane();
  write('src/big.mjs', linesOf(MAX_LINES + 1));
  assert.equal(raw().status, 0);
  assert.equal(raw('--base', 'main').status, 0);
});

test('size P3: --whole lifts only the size rule: the landing set and the classes stay the lane\'s', () => {
  const { json, write } = lane();
  write('src/big.mjs', linesOf(MAX_LINES + 1));
  const strength = (report) => report.reviews.map(({ agent, model, effort }) => [agent, model, effort]);
  const whole = json('--landing', '--whole');
  assert.deepEqual(strength(whole), [['reviewer', 'sonnet', 'high'], ['reviewer', 'opus', 'max'], ['security-auditor', 'opus', 'max']], 'the landing set of a logic lane');
  assert.ok(whole.classes.includes('logic') && whole.classes.includes('size'), `classes ${whole.classes}`);
  assert.deepEqual(json('--whole'), json(), '--whole without --landing changes nothing');
});
