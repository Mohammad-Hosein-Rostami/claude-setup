// Tests for home/hooks/lib/agent-ends.mjs agentEndTimes: the end times of background agents as the lead's transcript shows them
// (Claude Code's task notifications), read from at most the last 16 MB, with any line in another shape, any other status and any
// transcript that cannot be read showing no end. Each test writes its own transcript in a private temp folder.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentEndTimes } from '../home/hooks/lib/agent-ends.mjs';
import { TAIL_BYTES, junkText, noticeLine, writeTranscript } from './agent-ends-notices.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const ENDED = ['completed', 'failed', 'killed', 'stopped'];
const AGENT = 'agent-a2';
const OTHER_AGENT = 'agent-a9';
const ENDED_AT = Date.parse('2026-11-24T10:00:00.000Z');
const HEAD_BYTES = 1024 * 1024; // filler before the tail, so the file is bigger than TAIL_BYTES
const CUT_PREFIX = 'y'.repeat(100); // the part of a cut line that lies before the tail

const transcriptPath = () => join(makeTempDir('agent-ends-'), 'lead.jsonl');
const endsOf = (path, ids = [AGENT]) => agentEndTimes(path, ids);

test('each end status (completed, failed, killed, stopped) gives the agent its notice time', () => {
  for (const status of ENDED) {
    const path = writeTranscript(transcriptPath(), [noticeLine(AGENT, status, ENDED_AT)]);
    assert.deepEqual([...endsOf(path)], [[AGENT, ENDED_AT]], status);
  }
});

test('running, pending and an unknown status show no end', () => {
  for (const status of ['running', 'pending', 'paused']) {
    const path = writeTranscript(transcriptPath(), [noticeLine(AGENT, status, ENDED_AT)]);
    assert.equal(endsOf(path).size, 0, status);
  }
});

test('a notice for another id is not reported for the asked id', () => {
  const path = writeTranscript(transcriptPath(), [noticeLine(OTHER_AGENT, 'failed', ENDED_AT)]);
  assert.equal(endsOf(path).size, 0);
});

test('a malformed line, a notice with no task-id and the marker text on a line of another type are ignored; a whole notice after them counts', () => {
  const lines = [
    `{"type":"queue-operation" <task-notification> not json ${AGENT}`,
    noticeLine(AGENT, 'failed', ENDED_AT, { content: '<task-notification>\n<status>failed</status>\n</task-notification>' }),
    noticeLine(AGENT, 'failed', ENDED_AT, { type: 'user', note: 'queue-operation' }),
  ];
  assert.equal(endsOf(writeTranscript(transcriptPath(), lines)).size, 0, 'none of them is an end');
  const later = ENDED_AT + 1000;
  const path = writeTranscript(transcriptPath(), [...lines, noticeLine(AGENT, 'killed', later)]);
  assert.deepEqual([...endsOf(path)], [[AGENT, later]]);
});

test('a missing, non-string, folder or nonexistent transcript_path shows no end and does not throw', () => {
  const folder = makeTempDir('agent-ends-folder-');
  for (const path of [undefined, '', 42, null, { path: folder }, folder, join(folder, 'none.jsonl')]) {
    assert.equal(endsOf(path).size, 0, JSON.stringify(path));
  }
});

test('a transcript over 16 MB: a notice in the last 16 MB counts, after a first line the tail cuts', () => {
  const path = transcriptPath();
  const notice = `${noticeLine(AGENT, 'failed', ENDED_AT)}\n`;
  const text = junkText(HEAD_BYTES) + junkText(TAIL_BYTES) + notice;
  writeFileSync(path, text);
  const tailStart = Buffer.byteLength(text) - TAIL_BYTES;
  assert.notEqual(text[tailStart - 1], '\n', 'precondition: the tail starts inside a line');
  assert.deepEqual([...endsOf(path)], [[AGENT, ENDED_AT]]);
});

test('a transcript over 16 MB: a notice only before the last 16 MB is not read', () => {
  const path = transcriptPath();
  writeFileSync(path, `${noticeLine(AGENT, 'failed', ENDED_AT)}\n${junkText(TAIL_BYTES + HEAD_BYTES)}`);
  assert.equal(endsOf(path).size, 0);
});

test('a transcript over 16 MB: a line that starts before the tail is dropped, even when its cut end looks like a notice', () => {
  const path = transcriptPath();
  const notice = `${noticeLine(AGENT, 'failed', ENDED_AT)}\n`;
  const tail = notice + junkText(TAIL_BYTES - Buffer.byteLength(notice));
  writeFileSync(path, junkText(HEAD_BYTES) + CUT_PREFIX + tail); // the tail starts at the notice's `{`, inside the cut line
  assert.equal(endsOf(path).size, 0);
});

test('REPRO: a transcript over 16 MB whose last 16 MB start exactly at a notice line still reads that notice', () => {
  // Found on 0caeac89: transcriptTail drops the tail's first line even when the tail starts on a line boundary, so a whole
  // notice in the last 16 MB is skipped (agentEndTimes returns an empty Map; expected agent-a2 -> its notice time).
  const path = transcriptPath();
  const notice = `${noticeLine(AGENT, 'failed', ENDED_AT)}\n`;
  const text = junkText(HEAD_BYTES) + notice + junkText(TAIL_BYTES - Buffer.byteLength(notice));
  writeFileSync(path, text);
  assert.equal(text[Buffer.byteLength(text) - TAIL_BYTES - 1], '\n', 'precondition: the tail starts on a line boundary');
  assert.deepEqual([...endsOf(path)], [[AGENT, ENDED_AT]]);
});
