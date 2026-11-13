// Tests for the doctor check check_recall (scripts/doctor.sh, DOCTOR_ONLY mode): hook registration, reranker files,
// Ollama models and the last checkpoint error. Ollama is a loopback port that nothing listens on, or a fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCTOR = fileURLToPath(new URL('../scripts/doctor.sh', import.meta.url));
const skip = spawnSync('jq', ['--version']).status !== 0 && 'jq not installed';
const entry = (script) => [{ hooks: [{ type: 'command', command: `node "{{HOME}}/hooks/${script}"` }] }];
const REGISTERED = { PostToolUse: entry('checkpoint.mjs'), PreCompact: entry('checkpoint.mjs'), SessionStart: entry('recall-digest.mjs') };

async function sandbox({ hooks = REGISTERED, rerankers = true, checkpointError } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'doctor-recall-'));
  const state = join(home, 'state');
  const models = join(home, 'models');
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(join(state, 'checkpoints'), { recursive: true });
  await mkdir(models);
  await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks }));
  if (rerankers) for (const f of ['qwen3-reranker-0.6b-q8_0.gguf', 'qwen3-reranker-4b-q8_0.gguf']) await writeFile(join(models, f), 'x');
  if (checkpointError) await writeFile(join(state, 'checkpoints', 'abcdef12-0000.json'), JSON.stringify({ session: 'abcdef12-0000', error: { ts: '2026-02-01T00:00:00Z', message: checkpointError } }));
  return { HOME: home, RECALL_STATE_DIR: state, RECALL_RERANK_MODEL_DIR: models, RECALL_OLLAMA_URL: 'http://127.0.0.1:9' };
}
const doctor = (env) => spawnSync('bash', [DOCTOR], { env: { ...process.env, ...env, DOCTOR_ONLY: 'check_recall' }, encoding: 'utf8' });

test('check_recall passes the hook check when checkpoint and digest hooks are registered', { skip }, async () => {
  const result = doctor(await sandbox());
  assert.match(result.stdout, /^ok\s+recall: checkpoint hook registered for PostToolUse and PreCompact/m);
  assert.match(result.stdout, /^ok\s+recall: reranker files present/m);
  assert.match(result.stdout, /^ok\s+recall: no checkpoint errors/m);
  assert.equal(result.status, 0);
});

test('check_recall fails and names the missing hook events', { skip }, async () => {
  const result = doctor(await sandbox({ hooks: { PostToolUse: entry('checkpoint.mjs') } }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL\s+recall: checkpoint hooks not registered.*PreCompact.*SessionStart\(recall-digest\)/);
  assert.doesNotMatch(result.stdout, /FAIL.*PostToolUse/);
});

test('check_recall warns about missing reranker files and an unreachable Ollama', { skip }, async () => {
  const result = doctor(await sandbox({ rerankers: false }));
  assert.match(result.stdout, /WARN\s+recall: reranker files missing.*qwen3-reranker-0\.6b-q8_0\.gguf qwen3-reranker-4b-q8_0\.gguf/);
  assert.match(result.stdout, /WARN\s+recall: Ollama not reachable/);
});

test('check_recall reports the last checkpoint error', { skip }, async () => {
  const result = doctor(await sandbox({ checkpointError: 'claude is not on PATH' }));
  assert.match(result.stdout, /WARN\s+recall: last checkpoint error: abcdef12: claude is not on PATH/);
  assert.equal(result.status, 0);
});

test('check_recall prints a checkpoint error without control characters (no terminal escapes from stored text)', { skip }, async () => {
  const result = doctor(await sandbox({ checkpointError: 'bad\u001b[2Jreply\nSECOND LINE' }));
  assert.doesNotMatch(result.stdout, /[\u0000-\u0008\u000b-\u001f\u007f]/);
  assert.match(result.stdout, /WARN\s+recall: last checkpoint error: abcdef12: bad\[2JreplySECOND LINE/);
});

test('check_recall names the Ollama models that are not pulled', { skip }, async () => {
  const server = createServer((_req, res) => res.end(JSON.stringify({ models: [{ name: 'bge-m3:latest' }] })));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const env = { ...process.env, ...(await sandbox()), RECALL_OLLAMA_URL: `http://127.0.0.1:${server.address().port}`, DOCTOR_ONLY: 'check_recall' };
    const stdout = await new Promise((resolve) => { // async: the fake server lives in this process
      let out = '';
      const child = spawn('bash', [DOCTOR], { env });
      child.stdout.on('data', (c) => { out += c; });
      child.once('close', () => resolve(out));
    });
    assert.match(stdout, /WARN\s+recall: Ollama models not pulled: hf\.co\/Qwen\/Qwen3-Embedding-4B-GGUF/);
    assert.doesNotMatch(stdout, /not pulled:.*bge-m3/);
  } finally {
    server.close();
  }
});
