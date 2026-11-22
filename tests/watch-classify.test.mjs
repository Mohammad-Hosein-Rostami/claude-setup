// Tests for home/tools/watch/lib/classify.mjs and actions.mjs: transcript line -> verbose event -> action-only line.
// Uses synthetic transcript lines only (no real prompts). Expected strings come from the live-watch.sh / watch.sh behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClassifier } from '../home/tools/watch/lib/classify.mjs';
import { actionFor } from '../home/tools/watch/lib/actions.mjs';

const T = '2026-11-14T10:00:00.000Z';
const feed = (entry, classifier = createClassifier()) => classifier.feed(typeof entry === 'string' ? entry : JSON.stringify(entry));
const user = (content, extra = {}) => ({ type: 'user', timestamp: T, message: { content }, ...extra });
const actions = (entry) => feed(entry).map((event) => actionFor(event)).filter(Boolean);

test('owner prompt: first 200 chars, newlines to spaces', () => {
  const [event] = feed(user(`line one\nline two ${'x'.repeat(300)}`));
  assert.equal(event.kind, 'PROMPT');
  assert.equal(event.line, `${T} PROMPT line one line two ${'x'.repeat(200 - 'line one line two '.length)}`);
  const action = actionFor(event);
  assert.equal(action.cls, 'OWNER');
  assert.equal(action.text, `OWNER line one line two ${'x'.repeat(200 - 'line one line two '.length)}`);
});

test('prompt starting with < is not a prompt at all', () => {
  assert.deepEqual(feed(user('<task-notification>done</task-notification>')), []);
});

test('meta, sidechain and compaction-summary entries are verbose PROMPT lines but never OWNER', () => {
  for (const extra of [{ isMeta: true }, { isSidechain: true }, { isCompactSummary: true }]) {
    const events = feed(user('plain looking text', extra));
    assert.equal(events.length, 1);
    assert.equal(actionFor(events[0]), undefined, JSON.stringify(extra));
  }
  assert.equal(actions(user('This session is being continued from a previous conversation')).length, 0);
});

test('prompt text naming a cross-session message or a Stop hook is not OWNER', () => {
  assert.equal(actions(user('cross-session-message from peer')).length, 0);
});

test('compact boundary prints trigger and tokens', () => {
  const entry = { type: 'system', subtype: 'compact_boundary', timestamp: T, compactMetadata: { trigger: 'auto', preTokens: 170000, postTokens: 28000 } };
  const [event] = feed(entry);
  assert.equal(event.line, `${T} COMPACT auto 170000->28000`);
  assert.deepEqual(actionFor(event), { cls: 'COMPACT', text: `${T} COMPACT auto 170000->28000` });
});

test('tool error result becomes ERR (first 160 chars) and is an action only when it matches the alert words', () => {
  const failing = user([{ type: 'tool_result', is_error: true, content: 'ERROR: build failed\nline two' }]);
  const [event] = feed(failing);
  assert.equal(event.line, `${T} ERR ERROR: build failed line two`);
  assert.deepEqual(actionFor(event), { cls: 'ERROR', text: `${T} ERR ERROR: build failed line two` });
  const quiet = feed(user([{ type: 'tool_result', is_error: true, content: 'no such file' }]));
  assert.equal(actionFor(quiet[0]), undefined);
  assert.deepEqual(feed(user([{ type: 'tool_result', is_error: false, content: 'ERROR fine' }])), []);
});

test('usage limit, rate limit and API_ERROR text are actions', () => {
  for (const content of ['hit the usage limit', 'API_ERROR 529', 'RATE exceeded', 'daily LIMIT reached']) {
    const [action] = actions(user([{ type: 'tool_result', is_error: true, content }]));
    assert.equal(action?.cls, 'ERROR', content);
  }
});

test('error content that is an array is stringified like jq tostring', () => {
  const [event] = feed(user([{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'ERROR x' }] }]));
  assert.equal(event.line, `${T} ERR [{"type":"text","text":"ERROR x"}]`);
});

test('Stop hook feedback is its own class and wins over OWNER', () => {
  const [action] = actions(user('Stop hook feedback: keep going'));
  assert.equal(action.cls, 'STOP_HOOK');
  assert.match(action.text, /^2026-11-14T10:00:00.000Z PROMPT Stop hook feedback/);
});

test('verbose events: tools, agents, skills, usage', () => {
  const entry = {
    type: 'assistant', timestamp: T,
    message: {
      model: 'claude-opus-5-5',
      content: [
        { type: 'tool_use', name: 'Bash', input: {} },
        { type: 'tool_use', name: 'Agent', input: { subagent_type: 'reviewer', model: 'sonnet', description: 'check it' } },
        { type: 'tool_use', name: 'Task', input: {} },
        { type: 'tool_use', name: 'Workflow', input: { script: 'agent(a); agent(b)', scriptPath: 'w.js' } },
        { type: 'tool_use', name: 'Skill', input: { skill: 'verify-done' } },
        { type: 'text', text: 'hi' },
      ],
      usage: { input_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, output_tokens: 5 },
    },
  };
  assert.deepEqual(feed(entry).map((event) => event.line), [
    `${T} TOOL Bash`,
    `${T} AGENT type=reviewer model=sonnet effort=- bg=false desc=check it`,
    `${T} AGENT type=general-purpose model=- effort=- bg=false desc=`,
    `${T} TOOL Workflow`,
    `${T} SKILL verify-done`,
    `${T} USAGE model=claude-opus-5-5 ctx=240 create=30 out=5`,
  ]);
  assert.deepEqual(actions(entry), []);
});

test('INPUT_MODE prints only when the value changes', () => {
  const classifier = createClassifier();
  const mode = (value) => ({ type: 'mode', timestamp: T, mode: value });
  assert.equal(feed(mode('normal'), classifier).length, 1);
  assert.equal(feed(mode('normal'), classifier).length, 0);
  assert.equal(feed(mode('plan'), classifier)[0].line, `${T} INPUT_MODE plan`);
});

test('malformed, empty and unknown lines yield nothing', () => {
  for (const text of ['', '{"type":"user","message":', 'not json', '{"type":"queue-operation"}', '42']) assert.deepEqual(feed(text), [], text);
});
