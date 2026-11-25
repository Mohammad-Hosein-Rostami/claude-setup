// Text pins for the Codex second-opinion helpers (lex-codex, dev-codex, tess-codex): each is read-only and runs one fixed Codex
// command, and its parent starts it only when the boss's brief has `codex: yes`. Each case asserts the rule, not the sentence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
/** The text with every run of whitespace (line breaks included) as one space, so a rule survives re-wrapping. */
const flat = (text) => text.replace(/\s+/g, ' ');
const frontmatter = (text) => text.split('---')[1];
const field = (text, key) => new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(frontmatter(text))?.[1] ?? '';
const listed = (text, key) => field(text, key).split(',').map((item) => item.trim()).filter(Boolean);
/** The text of the `## ` section whose heading line contains `heading`, up to the next `## ` heading. */
function section(text, heading) {
  const start = text.split('\n').findIndex((line) => line.startsWith('## ') && line.includes(heading));
  assert.notEqual(start, -1, `no section "${heading}"`);
  const rest = text.split('\n').slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return rest.slice(0, end === -1 ? rest.length : end).join('\n');
}

const MODEL = 'gpt-6.2-sol';
const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit'];
const PARENTS = [
  { helper: 'lex-codex', parent: 'lex', heading: 'Codex second opinion' },
  { helper: 'dev-codex', parent: 'dev', heading: 'Build' },
  { helper: 'tess-codex', parent: 'tess', heading: 'Plan' },
];

for (const { helper } of PARENTS) {
  const text = read(`home/agents/${helper}.md`);
  const body = text.split('---').slice(2).join('---');

  test(`${helper}: has no write tool and disallows Write and Edit`, () => {
    const tools = listed(text, 'tools');
    assert.ok(tools.length > 0, 'tools list is empty');
    for (const tool of WRITE_TOOLS) assert.ok(!tools.includes(tool), `tools lists ${tool}`);
    const disallowed = listed(text, 'disallowedTools');
    for (const tool of ['Write', 'Edit']) assert.ok(disallowed.includes(tool), `disallowedTools lacks ${tool}`);
  });

  test(`${helper}: runs codex exec with the fixed model, max effort and a read-only sandbox`, () => {
    // the command spans lines joined by a trailing backslash
    const command = /^\s*codex exec\b.*(?:\\\n.*)*/m.exec(body)?.[0];
    assert.ok(command, 'no codex exec command in the body');
    const line = flat(command.replace(/\\\n/g, ' '));
    assert.match(line, new RegExp(`-m ${MODEL}\\b`));
    assert.match(line, /model_reasoning_effort="max"/);
    assert.match(line, /--sandbox read-only\b/);
    assert.doesNotMatch(line, /--dangerously/);
  });

  test(`${helper}: forbids --dangerously flags and an API-key login, and never retries`, () => {
    const rules = flat(body);
    assert.match(rules, /never add a `--dangerously-\*` flag/);
    assert.match(rules, /never log in with an API key/);
    assert.match(rules, /never retry/i);
  });
}

for (const { helper, parent, heading } of PARENTS) {
  test(`${parent}.md: starts ${helper} only when the brief has codex: yes`, () => {
    const text = read(`home/agents/${parent}.md`);
    const rule = flat(section(text, heading));
    assert.match(rule, new RegExp(`\`codex: yes\``), `no codex: yes in the "${heading}" section`);
    assert.match(rule, new RegExp(`\`${helper}\``), `${helper} is not named in the "${heading}" section`);
    // without the line the helper is not started and no Codex is used
    assert.match(rule, new RegExp(`without it you never start \`${helper}\` and use no Codex`));
  });
}

test('tess.md: tess-codex starts once the plan is in the detail file and before any other helper', () => {
  const text = read('home/agents/tess.md');
  const plan = flat(section(text, 'Plan'));
  assert.match(plan, /write the plan into the detail file before the first check runs/i);
  assert.match(plan, /once the plan is in the detail file[^.]*before any other helper starts[^.]*start one `tess-codex`/);
  // the plan section, where tess-codex starts, comes before the section that starts every other helper
  const headings = text.split('\n').filter((line) => line.startsWith('## '));
  assert.ok(headings.findIndex((h) => h.includes('Plan')) < headings.findIndex((h) => h.includes('Helpers, in one message')));
});

test('home/CLAUDE.md: Codex is only on the owner asking in chat, and the boss adds codex: yes to the lex, dev or tess brief', () => {
  const rule = flat(read('home/CLAUDE.md'));
  assert.match(rule, /Only when the owner asks in chat:[^.]*Codex[^.]*the boss adds `codex: yes` to [^.]*lex, dev or tess brief/);
});

// rules-1: tess-write's folder is created locked and freed with unlock before remove; tess's brief names the tick's commits line.
test('tess.md: a tess-write folder is created with --lock and unlocked before it is removed', () => {
  const text = read('home/agents/tess.md');
  const start = text.indexOf('- `tess-write`');
  assert.notEqual(start, -1, 'no tess-write bullet');
  const paragraph = flat(text.slice(start).split(/\n(?=- |## )/)[0]);
  assert.match(paragraph, /git worktree add --lock\b/);
  const unlock = paragraph.indexOf('worktree unlock');
  const remove = paragraph.indexOf('worktree remove');
  assert.notEqual(unlock, -1, 'no worktree unlock');
  assert.notEqual(remove, -1, 'no worktree remove');
  assert.ok(unlock < remove, 'worktree unlock must come before worktree remove');
});

test('tess.md: worktree remove is written on exactly one line', () => {
  const lines = read('home/agents/tess.md').split('\n').filter((line) => line.includes('worktree remove'));
  assert.equal(lines.length, 1, lines.join('\n'));
});

test('tess.md and the qa-plan skill both name the tick\'s `commits <feature>:` line', () => {
  for (const path of ['home/agents/tess.md', 'home/skills/qa-plan/SKILL.md']) {
    assert.match(read(path), /commits <feature>:/, path);
  }
});
