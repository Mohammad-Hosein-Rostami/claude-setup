// Tests for home/tools/recall/lib/extract.mjs: normalisation, redaction (every pattern), chunking, parser skip rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CHUNK_CHARS, OVERLAP_CHARS, chunkText, createTranscriptParser, normalize, redact } from '../home/tools/recall/lib/extract.mjs';

test('normalize maps Arabic ي/ك, drops ZWNJ and tatweel, applies NFKC', () => {
  assert.equal(normalize('كي‌مـي'), 'کیمی');
  assert.equal(normalize('ﬁx'), 'fix');
  assert.equal(normalize(undefined), '');
});

const SECRET = 'S3cr3tValue99';
const REDACTION_CASES = {
  'password=': [`password=${SECRET}`, SECRET],
  'token: quoted': [`token: "${SECRET}"`, SECRET],
  'api_key': [`API_KEY='${SECRET}'`, SECRET],
  'apikey': [`apikey=${SECRET}`, SECRET],
  'passwd': [`passwd: ${SECRET}`, SECRET],
  'pwd': [`pwd=${SECRET}`, SECRET],
  'secret': [`client_secret=${SECRET}`, SECRET],
  'authorization': [`authorization: ${SECRET}`, SECRET],
  'sshpass -p': [`sshpass -p ${SECRET} ssh host`, SECRET],
  'sshpass -p quoted': [`sshpass -p '${SECRET}' ssh host`, SECRET],
  'sk- key': ['use sk-abcdefghijklmnopqrstuv now', 'sk-abcdefghijklmnopqrstuv'],
  'ghp_ key': ['ghp_abcdefghijklmnopqrstuvwxyz0123', 'ghp_abcdefghijklmnopqrstuvwxyz0123'],
  'github_pat_': ['github_pat_11ABCDEFG0123456789_abcdefghij', 'github_pat_11ABCDEFG0123456789_abcdefghij'],
  'xox key': ['xoxb-1234567890-abcdefghij', 'xoxb-1234567890-abcdefghij'],
  'AKIA key': ['id AKIAABCDEFGHIJKLMNOP end', 'AKIAABCDEFGHIJKLMNOP'],
  'PEM block': ['-----BEGIN RSA PRIVATE KEY-----\nMIIabc\ndef\n-----END RSA PRIVATE KEY-----', 'MIIabc'],
  'Bearer': ['Authorization header Bearer abc.def-ghi_123', 'abc.def-ghi_123'],
  'URL creds': ['clone https://bob:hunter2@example.com/x.git', 'hunter2'],
  'long run after key word': ['key 0123456789abcdef0123456789abcdef0123', '0123456789abcdef0123456789abcdef0123'],
  'long run before key word': ['0123456789abcdef0123456789abcdef0123 key', '0123456789abcdef0123456789abcdef0123'],
};

for (const [name, [input, leaked]] of Object.entries(REDACTION_CASES)) {
  test(`redact: ${name}`, () => {
    const out = redact(input);
    assert.ok(out.includes('[REDACTED]'), out);
    assert.ok(!out.includes(leaked), out);
  });
}

test('redact leaves ordinary text and short hex alone', () => {
  const text = 'commit abc1234 fixed the tokenizer, max_tokens: 5';
  assert.equal(redact(text), text);
});

test('chunkText: short text is one chunk; long text splits on paragraphs with the configured overlap', () => {
  assert.deepEqual(chunkText('hello'), ['hello']);
  const paragraphs = Array.from({ length: 8 }, (_, i) => `${i}`.repeat(MAX_CHUNK_CHARS / 2));
  const chunks = chunkText(paragraphs.join('\n\n'));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= MAX_CHUNK_CHARS));
  assert.ok(chunks[1].startsWith(chunks[0].slice(-OVERLAP_CHARS)));
  assert.equal(chunkText('x'.repeat(5000)).every((c) => c.length <= MAX_CHUNK_CHARS), true);
});

const line = (obj) => JSON.stringify(obj);

test('parser: skips tool results, harness events, thinking and tool_use; keeps prompts', () => {
  const p = createTranscriptParser();
  const feed = (obj, n) => p.feed(line(obj), n);
  assert.equal(feed({ type: 'user', message: { content: 'plain prompt' }, timestamp: 't1' }, 1)[0].kind, 'user');
  assert.equal(feed({ type: 'user', message: { content: [{ type: 'text', text: 'block prompt' }] } }, 2).length, 1);
  assert.equal(feed({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }, 3).length, 0);
  for (const [i, text] of ['<task-notification>', '<agent-message>', '[SYSTEM NOTIFICATION] x', '<system-reminder>x', '<local-command-stdout>', '<command-name>x', 'Caveat: x'].entries()) {
    assert.equal(feed({ type: 'user', message: { content: text } }, 10 + i).length, 0, text);
  }
  const mixed = feed({ type: 'assistant', message: { id: 'm1', content: [{ type: 'thinking', thinking: 'h' }, { type: 'tool_use', name: 'x' }, { type: 'text', text: 'answer' }] } }, 20);
  assert.deepEqual(mixed.map((c) => c.kind), ['assistant']);
});

test('parser: one message.id over several lines is deduped, malformed lines are counted', () => {
  const p = createTranscriptParser();
  const msg = { type: 'assistant', message: { id: 'm9', content: [{ type: 'text', text: 'same text' }] } };
  assert.equal(p.feed(line(msg), 1).length, 1);
  assert.equal(p.feed(line(msg), 2).length, 0);
  assert.deepEqual(p.feed('{not json', 3), []);
  assert.deepEqual(p.feed('42', 4), []);
  assert.equal(p.bad, 2);
});

test('parser: compact summary becomes kind summary and records cwd', () => {
  const p = createTranscriptParser();
  const out = p.feed(line({ type: 'user', isCompactSummary: true, cwd: '/proj', message: { content: 'Summary: we chose sqlite' } }), 5);
  assert.equal(out[0].kind, 'summary');
  assert.ok(p.cwds.has('/proj'));
});

test('parser: agent mode keeps the brief and the last report only', () => {
  const p = createTranscriptParser({ mode: 'agent', agentType: 'scout' });
  p.feed(line({ type: 'user', message: { content: 'the brief' } }), 1);
  p.feed(line({ type: 'assistant', message: { id: 'a', content: [{ type: 'text', text: 'draft' }] } }), 2);
  p.feed(line({ type: 'assistant', message: { id: 'b', content: [{ type: 'text', text: 'final report' }] } }), 3);
  const out = p.finish();
  assert.deepEqual(out.map((c) => [c.kind, c.role, c.line]), [['agent', 'scout:brief', 1], ['agent', 'scout:report', 3]]);
  assert.equal(out[1].text, 'final report');
});

test('parser redacts before storing', () => {
  const p = createTranscriptParser();
  const out = p.feed(line({ type: 'user', message: { content: 'deploy with password=hunter22' } }), 1);
  assert.ok(!out[0].text.includes('hunter22'));
});
