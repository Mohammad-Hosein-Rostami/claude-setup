// Tests for the three quality skills tess and its helpers preload (home/skills/qa-plan, test-writing, review-checklist): each
// exists with its own name, stays short enough to preload on every launch, ends with a done-gate, and keeps the lines its agents
// rely on (the risk command, `not run`, fail-first, the forbidden test edits, and the review classes moved out of tess-review.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SKILLS_DIR = fileURLToPath(new URL('../home/skills/', import.meta.url));
const QA_SKILLS = ['qa-plan', 'test-writing', 'review-checklist'];
const MAX_SKILL_LINES = 70; // preloaded on every launch of its agent: about 1.5k tokens at most
const skillPath = (name) => `${SKILLS_DIR}${name}/SKILL.md`;
const skill = (name) => readFileSync(skillPath(name), 'utf8');

test('each quality skill exists with its own name, at most 70 lines and a Done-gate line', () => {
  for (const name of QA_SKILLS) {
    assert.ok(existsSync(skillPath(name)), `${name}: SKILL.md exists`);
    const text = skill(name);
    assert.match(text, new RegExp(`^---\\nname: ${name}\\ndescription: .{40,}\\n`), `${name}: frontmatter with its name`);
    assert.ok(text.trimEnd().split('\n').length <= MAX_SKILL_LINES, `${name}: at most ${MAX_SKILL_LINES} lines`);
    assert.match(text, /^Done-gate: /m, `${name}: a Done-gate line`);
    assert.doesNotMatch(text, /^paths:/m, `${name}: follows the work, not a file type`);
  }
});

test('test-writing asks for a failing repro before a fix, forbids .only, skip and -u, and names Windows', () => {
  const text = skill('test-writing');
  assert.match(text, /fail for the claimed reason before any fix/);
  assert.match(text, /`\.only`/);
  assert.match(text, /Never \(C13\): skip/);
  assert.match(text, /`-u` snapshot updates/);
  assert.match(text, /Windows/);
});

test('qa-plan runs the risk command and reports a check it cannot run as not run', () => {
  const text = skill('qa-plan');
  assert.match(text, /node ~\/\.claude\/tools\/risk\/risk\.mjs --base <base> --tip <tip>/);
  assert.match(text, /`not run \(no command\)`/);
  assert.match(text, /`risk: unknown` counts as risky/);
});

test('review-checklist holds the review classes once, moved from tess-review', () => {
  const text = skill('review-checklist');
  for (const phrase of ['second door', 'Kinder fakes', 'Errors read as absence']) {
    assert.equal(text.split('\n').filter((line) => line.includes(phrase)).length, 1, `review-checklist: "${phrase}" on one line`);
  }
});
