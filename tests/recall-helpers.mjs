// Shared helpers for the recall CLI tests (fix round 2): temp project builder, async CLI runner and a fake loopback
// Ollama that records requests. Not a test file (no .test suffix), so `node --test tests/*.test.mjs` does not run it.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI = fileURLToPath(new URL('../home/tools/recall/recall.mjs', import.meta.url));
export const SESSION = 'cccccccc-1111-2222-3333-444444444444';
export const DEAD_OLLAMA = 'http://127.0.0.1:9';
export const j = (o) => `${JSON.stringify(o)}\n`;
export const user = (text) => j({ type: 'user', timestamp: '2026-01-05T10:00:00Z', message: { content: text } });
export const assistant = (id, text) => j({ type: 'assistant', timestamp: '2026-01-05T10:01:00Z', message: { id, content: [{ type: 'text', text }] } });

export function setup(lines = [user('a kitten story'), user('a feline friend slept all day')]) {
  const dir = mkdtempSync(join(tmpdir(), 'recall-fix2-'));
  const root = join(dir, 'projects');
  mkdirSync(join(root, '-p'), { recursive: true });
  const file = join(root, '-p', `${SESSION}.jsonl`);
  writeFileSync(file, lines.join(''));
  const db = join(dir, 'db', 'index.db');
  const env = { ...process.env, RECALL_DB: db, RECALL_ROOT: root, RECALL_HOME: dir, RECALL_OLLAMA_URL: DEAD_OLLAMA, RECALL_EMBED_MODEL: 'fake', RECALL_RERANK: 'off' };
  return { dir, root, file, db, env };
}

/** Run the CLI without blocking this process's event loop (the fake Ollama lives in it). */
export function run(env, ...args) {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  return new Promise((resolve) => child.once('exit', (status) => resolve({ status, stdout, stderr })));
}

/** Fake Ollama: feline/kitten texts map to [1,0,0], dog to [0,1,0], the rest to [0,0,1]. Records every request body. */
export async function fakeOllama({ status = 200 } = {}) {
  const calls = [];
  const topic = (t) => (/kitten|feline/.test(t) ? [1, 0, 0] : /dog/.test(t) ? [0, 1, 0] : [0, 0, 1]);
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      calls.push(parsed);
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(status === 200 ? JSON.stringify({ embeddings: parsed.input.map(topic) }) : JSON.stringify({ error: 'model not found' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { calls, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

export async function withFake(options, fn) {
  const fake = await fakeOllama(options);
  try {
    await fn(fake);
  } finally {
    fake.close();
  }
}

export const unwrap = (out) => out.replace(/^<recall-results[^>]*>\n/, '').replace(/\n<\/recall-results>\s*$/, '');
export const insertedInputs = (calls) => calls.flatMap((c) => c.input);
