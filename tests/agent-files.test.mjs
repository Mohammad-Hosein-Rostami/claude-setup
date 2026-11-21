// Tests for home/agents/*.md frontmatter and clauses: workers cannot spawn or message agents, implementer preloads the
// gate skills, every worker carries the call budget, reviewers carry the 300-word cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const agent = (name) => readFileSync(fileURLToPath(new URL(`../home/agents/${name}.md`, import.meta.url)), 'utf8');
const frontmatter = (name) => agent(name).split('---')[1];
const field = (name, key) => new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(frontmatter(name))?.[1] ?? '';

test('implementer, ui-implementer and test-writer disallow Agent and SendMessage', () => {
  for (const name of ['implementer', 'ui-implementer', 'test-writer']) {
    const denied = field(name, 'disallowedTools').split(',').map((tool) => tool.trim());
    assert.ok(denied.includes('Agent') && denied.includes('SendMessage'), name);
  }
});

test('implementer preloads verify-done, tdd-loop and root-cause-debug', () => {
  for (const skill of ['verify-done', 'tdd-loop', 'root-cause-debug']) assert.match(frontmatter('implementer'), new RegExp(`^\\s+- ${skill}$`, 'm'), skill);
});

test('worker agents return a status after ~120 calls or the 2nd compaction', () => {
  // r9-dedupe part 2: stated once in home/CLAUDE.md "Agents (workers)"; each worker points there.
  assert.match(readFileSync(fileURLToPath(new URL('../home/CLAUDE.md', import.meta.url)), 'utf8'), /120 tool calls or the 2nd compaction/);
  for (const name of ['implementer', 'ui-implementer', 'test-writer']) assert.match(agent(name), /CLAUDE\.md "Agents \(workers\)"/, name);
});

test('reviewer, security-auditor and architect cap the reply at 300 words with detail in a file', () => {
  for (const name of ['reviewer', 'security-auditor', 'architect']) assert.match(agent(name), /300 words[\s\S]*file/, name);
});

test('security-auditor final line has a race field between stress and mutants', () => {
  assert.match(agent('security-auditor'), /stress: [^\n]*or not asked; race: <violations> over <runs> runs, or not asked; mutants: <killed>\/<n>/);
});
