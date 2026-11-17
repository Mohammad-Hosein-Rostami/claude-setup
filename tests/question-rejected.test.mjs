// Tests for home/hooks/lib/question-rejected.mjs: noticing in the session transcript that the owner turned an AskUserQuestion down in the
// terminal ("Chat about this" or Esc), which never runs the tool and so never reaches the PostToolUse mark. Only lines written after the
// watch starts count; a line still being written is read once it is complete. Real files in a temp folder, no mocks.
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { watchTerminalRejection } from '../home/hooks/lib/question-rejected.mjs';

const line = (entry) => `${JSON.stringify(entry)}\n`;
const REJECTED = line({ type: 'user', toolDenialKind: 'user-rejected', message: { role: 'user', content: [{ type: 'tool_result', is_error: true, content: 'The user doesn\'t want to proceed with this tool use.' }] } });
const CLARIFY = line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'The user wants to clarify these questions.' }] } });
const ORDINARY = line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } });

const transcript = (text = '') => {
  const path = join(mkdtempSync(join(tmpdir(), 'transcript-')), 'session.jsonl');
  writeFileSync(path, text);
  return path;
};

test('a rejected tool call written after the watch started is seen, and stays seen', () => {
  const path = transcript(ORDINARY);
  const rejected = watchTerminalRejection(path);
  assert.equal(rejected(), false);
  appendFileSync(path, ORDINARY);
  assert.equal(rejected(), false, 'ordinary transcript growth is not a rejection');
  appendFileSync(path, REJECTED);
  assert.equal(rejected(), true);
  assert.equal(rejected(), true);
});

test('"Chat about this" (the questions are sent back for clarification) is seen', () => {
  const path = transcript();
  const rejected = watchTerminalRejection(path);
  appendFileSync(path, CLARIFY);
  assert.equal(rejected(), true);
});

test('a rejection already in the transcript before the watch started is an earlier question and does not count', () => {
  const path = transcript(REJECTED + CLARIFY);
  assert.equal(watchTerminalRejection(path)(), false);
});

test('a line still being written is read once it is complete', () => {
  const path = transcript();
  const rejected = watchTerminalRejection(path);
  appendFileSync(path, REJECTED.slice(0, 40));
  assert.equal(rejected(), false);
  appendFileSync(path, REJECTED.slice(40));
  assert.equal(rejected(), true);
});

test('no transcript path, a missing file or a damaged line never throws and never reports a rejection', () => {
  assert.equal(watchTerminalRejection(undefined)(), false);
  assert.equal(watchTerminalRejection('')(), false);
  assert.equal(watchTerminalRejection(join(tmpdir(), 'no-such-dir-question', 'missing.jsonl'))(), false);
  const path = transcript();
  const rejected = watchTerminalRejection(path);
  appendFileSync(path, 'not json at all\n');
  assert.equal(rejected(), false);
});
