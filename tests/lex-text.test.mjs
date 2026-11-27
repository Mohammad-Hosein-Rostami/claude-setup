// Text checks of lex and its planning files (plan lex-best, Appendix D): line caps, the plan-writing skill's sections, its
// test-rule, contact-check, pre-mortem and pieces.json clauses, lex.md's use of them, and the lex helpers' wording.
// Each pin quotes a whole clause of its file, so a reworded rule fails here instead of drifting silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const flat = (text) => text.replace(/\s+/g, ' ');
/** The number of `\n`-ended lines, as `wc -l` counts them. */
const lineCount = (text) => (text.match(/\n/g) ?? []).length;

const LEX = 'home/agents/lex.md';
const PLAN_WRITING = 'home/skills/plan-writing/SKILL.md';
const LEX_SCOUT = 'home/agents/lex-scout.md';
const LEX_WEB = 'home/agents/lex-web.md';
const LEX_CODEX = 'home/agents/lex-codex.md';
const TRADEOFF = 'home/skills/tradeoff-analysis/SKILL.md';
const TECH_RESEARCH = 'home/skills/tech-research/SKILL.md';

/** Asserts that the flattened text of `path` holds every clause. */
function assertIncludes(path, clauses) {
  const text = flat(read(path));
  for (const clause of clauses) assert.ok(text.includes(clause), `${path} says: ${clause}`);
}

test("lex's files stay short", () => {
  const caps = { [LEX]: 145, [PLAN_WRITING]: 90, [LEX_SCOUT]: 40, [LEX_WEB]: 40, [LEX_CODEX]: 70, [TRADEOFF]: 20, [TECH_RESEARCH]: 20 };
  for (const [path, cap] of Object.entries(caps)) {
    const lines = lineCount(read(path));
    assert.ok(lines <= cap, `${path} has ${lines} lines, cap ${cap}`);
  }
});

test("plan-writing is lex's plan format", () => {
  const text = read(PLAN_WRITING);
  assert.match(text, /^---\nname: plan-writing\n/);
  assert.match(text, /^description: .*Preloaded by lex\.$/m);
  const headings = text.split('\n').filter((line) => line.startsWith('## ')).map((line) => line.slice(3));
  assert.deepEqual(headings, ['The plan file', 'A piece', 'pieces.json', 'Contact check', 'Pre-mortem']);
});

test('plan-writing adds no tests and lists the ones that pin an old rule', () => {
  assertIncludes(PLAN_WRITING, [
    'A plan adds no tests: no new test case or file, no test-first piece and no `test/<topic>` branch, unless the owner asks for them.',
    'so dev updates it by reading, without running it',
    'with the exit it must return, never a test run',
  ]);
});

test('the contact check uses ground truth', () => {
  assertIncludes(PLAN_WRITING, [
    'grep its old form in code, tests, docs, agent and skill text, READMEs and comments',
    'evaluate each new rule or predicate on every existing test case of its area, first the cases it must not match',
    'A line the base already passes, or a broken change would pass, is rewritten.',
    'no two pieces with no `after` path between them share a file',
    'env -u CLAUDE_CODE_SESSION_ID',
    'read the base sha again last, also after any Codex or owner change',
  ]);
});

test('the pre-mortem assumes the build failed', () => {
  assertIncludes(PLAN_WRITING, [
    'Assume dev stopped on this plan, or tess found a must-fix after a land',
    'the first run on existing state',
  ]);
});

test('pieces.json fields', () => {
  assertIncludes(PLAN_WRITING, [
    "`waits`: another job's branches that must land first",
    '`base`: the sha the plan was first written on (a re-plan keeps it)',
    'No other field.',
  ]);
});

test('lex runs the checks and counts its reply', () => {
  assertIncludes(LEX, [
    'the `plan-writing` contact check',
    'count it with `wc -w` before you send it',
    'at most 4 at once',
    'The recommended one is safe if nobody answers',
  ]);
  assert.ok(!read(LEX).includes('--base <main sha>'), 'lex.md passes no --base to a claim');
});

test('the helpers', () => {
  assertIncludes(LEX_SCOUT, ['An impact brief', '`truncated: <what is not listed>`']);
  assertIncludes(LEX_CODEX, ["with the Bash tool's `timeout` parameter at 60000", 'an acceptance line that cannot fail', '-C "<repo>"']);
  assertIncludes(LEX_WEB, ['mark each fact `verified`']);
  assertIncludes(TRADEOFF, ['Confirmation (the check or signal that shows the decision holds)', 'a new one supersedes it']);
  assert.ok(!read(TRADEOFF).includes('(X3)'), 'tradeoff-analysis drops the (X3) tag');
  assertIncludes(TECH_RESEARCH, ['A tool installed here', 'a fact you only remember is an assumption']);
});
