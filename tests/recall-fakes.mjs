// Fakes for the checkpoint / reranker tests (not a test file): a `claude`, a `llama-server` and an Ollama-free env
// builder, all installed on a private PATH so nothing real (Haiku, GPU, the owner's DB) is ever touched.
// `claude` behaviour is chosen per call with FAKE_CLAUDE_MODE (ok | bad-then-ok | bad | error | slow-ok); every call is
// appended to $FAKE_CLAUDE_LOG as one JSON line {args, stdin}. `llama-server` serves /health and /v1/rerank on --port
// and scores a document by how many query words it contains; FAKE_LLAMA_LOG records start lines {model, port}.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const FAKE_CLAUDE = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args: process.argv.slice(2), stdin }) + '\\n');
const mode = process.env.FAKE_CLAUDE_MODE || 'ok';
const counter = process.env.FAKE_CLAUDE_LOG + '.count';
const n = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1;
writeFileSync(counter, String(n));
const reply = (result, extra = {}) => console.log(JSON.stringify({ type: 'result', is_error: false, result, usage: { input_tokens: 400, output_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, modelUsage: { 'claude-haiku-fake': {} }, total_cost_usd: 0.001, ...extra }));
if (mode === 'error') { reply('boom', { is_error: true }); process.exit(0); }
if (mode === 'bad' || (mode === 'bad-then-ok' && n === 1)) { reply('Sure! here are your notes (not JSON)'); process.exit(0); }
const lines = [...stdin.matchAll(/\\[L(\\d+) /g)].map((m) => Number(m[1]));
const first = lines[0] ?? 1;
const last = lines.at(-1) ?? 1;
reply(JSON.stringify({
  instructions: [{ t: 'question', l: first }],
  decisions: [{ t: 'Chose qwen3-reranker-0.6b because it answers in 1.1 s.', l: last }],
  facts: [{ t: 'The reranker port is 8012 and the pool size is 30.', l: last }],
  files: [{ t: 'home/hooks/checkpoint.mjs created.', l: first }],
  errors: [], open: [{ t: 'Next step: wire the doctor check.', l: last }],
}));
`;

const FAKE_LLAMA = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const port = Number(arg('--port'));
if (process.env.FAKE_LLAMA_LOG) appendFileSync(process.env.FAKE_LLAMA_LOG, JSON.stringify({ model: arg('-m'), port }) + '\\n');
const server = createServer((req, res) => {
  if (req.url === '/health') { res.end('{"status":"ok"}'); return; }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const { query, documents } = JSON.parse(body);
    const words = query.toLowerCase().split(/\\W+/).filter(Boolean);
    const results = documents.map((d, index) => ({ index, relevance_score: words.filter((w) => d.toLowerCase().includes(w)).length }));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ results }));
  });
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`;

/**
 * A sandbox: fake claude and llama-server on a private PATH, a state dir, DB path and model dir with both reranker files.
 * The reranker port is random in 20000-29999: wide enough that suites running at once in several worktrees rarely pick the same
 * one, and clear of the fixed 18998/18999 stand-ins in recall-rerank-chain.test.mjs.
 * @returns {{dir: string, bin: string, env: object, claudeCalls: () => object[], llamaStarts: () => object[], dbPath: string}}
 */
export function fakeStack({ claudeMode = 'ok', port = 20000 + Math.floor(Math.random() * 10000) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'recall-stack-'));
  const bin = join(dir, 'bin');
  const models = join(dir, 'models');
  mkdirSync(bin);
  mkdirSync(models);
  for (const [name, text] of [['claude', FAKE_CLAUDE], ['llama-server', FAKE_LLAMA]]) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  for (const file of ['qwen3-reranker-0.6b-q8_0.gguf', 'qwen3-reranker-4b-q8_0.gguf']) writeFileSync(join(models, file), 'x');
  const claudeLog = join(dir, 'claude.log');
  const llamaLog = join(dir, 'llama.log');
  writeFileSync(claudeLog, '');
  writeFileSync(llamaLog, '');
  const dbPath = join(dir, 'db', 'index.db');
  const env = {
    ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, RECALL_DB: dbPath, RECALL_STATE_DIR: join(dir, 'state'),
    RECALL_ROOT: join(dir, 'projects'), RECALL_HOME: dir, RECALL_OLLAMA_URL: 'http://127.0.0.1:9', RECALL_RERANK_MODEL_DIR: models,
    RECALL_RERANK_PORT: String(port), RECALL_RERANK_FOREIGN_CHECK: 'off', FAKE_CLAUDE_LOG: claudeLog, FAKE_CLAUDE_MODE: claudeMode, FAKE_LLAMA_LOG: llamaLog,
  };
  const lines = (path) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { dir, bin, env, dbPath, claudeCalls: () => lines(claudeLog), llamaStarts: () => lines(llamaLog) };
}

/** A transcript of `count` user/assistant message pairs, each `size` characters (about count*size*2 bytes). */
export function bigTranscript(dir, { count, size = 2000, name = 'dddddddd-1111-2222-3333-444444444444' } = {}) {
  const folder = join(dir, 'projects', '-p');
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${name}.jsonl`);
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push(JSON.stringify({ type: 'user', timestamp: '2026-02-01T10:00:00Z', message: { content: `question ${i}: ${'x'.repeat(size)}` } }));
    rows.push(JSON.stringify({ type: 'assistant', timestamp: '2026-02-01T10:01:00Z', message: { id: `m${i}`, content: [{ type: 'text', text: `answer ${i}: ${'y'.repeat(size)}` }] } }));
  }
  writeFileSync(path, `${rows.join('\n')}\n`);
  return { path, session: name };
}
