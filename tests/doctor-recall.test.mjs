// Tests for the doctor check check_recall (scripts/doctor.sh, DOCTOR_ONLY mode): hook registration, reranker files,
// Ollama models and the last checkpoint error (no WARN once a later checkpoint succeeded). Ollama is a loopback port that nothing
// listens on, or a fake. Also the doctor accepted list (owner FR8): ollama-off and apple-terminal-notes print INFO, the production
// host list WARN stays, and a missing, empty, linked or unknown-id list changes no WARN. HOME is a temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';

const DOCTOR = fileURLToPath(new URL('../scripts/doctor.sh', import.meta.url));
const skip = spawnSync('jq', ['--version']).status !== 0 && 'jq not installed';
const skipLink = skip || (process.platform === 'win32' && 'needs symlinks'); // Windows may refuse a symlink (EPERM)
const entry = (script) => [{ hooks: [{ type: 'command', command: `node "{{HOME}}/hooks/${script}"` }] }];
const REGISTERED = { PostToolUse: entry('checkpoint.mjs'), PreCompact: entry('checkpoint.mjs'), SessionStart: entry('recall-digest.mjs') };
// The parent's own accepted-list path and tmux would leak into the runs: every run reads only its temp HOME.
const parentEnv = { ...process.env };
delete parentEnv.CLAUDE_DOCTOR_ACCEPTED_FILE;
delete parentEnv.TMUX;

/**
 * A temp HOME with recall's state. `checkpoints` are `{ name, state }` files; `accepted` is the text of
 * ~/.claude/private/doctor-accepted (left out when undefined).
 */
async function sandbox({ hooks = REGISTERED, rerankers = true, checkpointError, checkpoints = [], accepted } = {}) {
  const home = makeTempDir('doctor-recall-');
  const state = join(home, 'state');
  const models = join(home, 'models');
  await mkdir(join(home, '.claude', 'private'), { recursive: true });
  await mkdir(join(state, 'checkpoints'), { recursive: true });
  await mkdir(models);
  await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks }));
  if (rerankers) for (const f of ['qwen3-reranker-0.6b-q8_0.gguf', 'qwen3-reranker-4b-q8_0.gguf']) await writeFile(join(models, f), 'x');
  if (checkpointError) checkpoints = [...checkpoints, { name: 'abcdef12-0000', state: { session: 'abcdef12-0000', error: { ts: '2026-02-01T00:00:00Z', message: checkpointError } } }];
  for (const { name, state: saved } of checkpoints) await writeFile(join(state, 'checkpoints', `${name}.json`), JSON.stringify(saved));
  if (accepted !== undefined) await writeFile(join(home, '.claude', 'private', 'doctor-accepted'), accepted);
  return { HOME: home, USERPROFILE: home, RECALL_STATE_DIR: state, RECALL_RERANK_MODEL_DIR: models, RECALL_OLLAMA_URL: 'http://127.0.0.1:9' };
}
const doctor = (env) => spawnSync('bash', [DOCTOR], { env: { ...parentEnv, ...env, DOCTOR_ONLY: 'check_recall' }, encoding: 'utf8' });

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
    const env = { ...parentEnv, ...(await sandbox()), RECALL_OLLAMA_URL: `http://127.0.0.1:${server.address().port}`, DOCTOR_ONLY: 'check_recall' };
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

// A later successful checkpoint (any session's `ts`) shows the job works again: the older error is no WARN, still named on an ok line.
test('check_recall gives no WARN for a checkpoint error older than a later success, and warns for a newer one', { skip }, async () => {
  const failed = { name: 'abcdef12-0000', state: { session: 'abcdef12-0000', error: { ts: '2026-11-20T22:29:00.000Z', message: 'Not logged in' } } };
  const later = { name: '00000000-later', state: { session: '00000000-later', ts: '2026-11-21T08:00:00.000Z', notes: 3, error: null } };
  const old = doctor(await sandbox({ checkpoints: [failed, later] }));
  assert.doesNotMatch(old.stdout, /^WARN.*checkpoint error/m);
  assert.match(old.stdout, /^ok\s+recall: the last checkpoint error \(abcdef12: Not logged in \(2026-11-20T22:29:00\.000Z\)\) came before a later successful checkpoint \(2026-11-21T08:00:00\.000Z\)/m);
  const earlier = { ...later, state: { ...later.state, ts: '2026-11-19T08:00:00.000Z' } };
  const fresh = doctor(await sandbox({ checkpoints: [failed, earlier] }));
  assert.match(fresh.stdout, /^WARN\s+recall: last checkpoint error: abcdef12: Not logged in/m);
});

test('check_recall names the newest checkpoint error by its time, not by its file name', { skip }, async () => {
  const error = (session, ts, message) => ({ name: session, state: { session, error: { ts, message } } });
  const result = doctor(await sandbox({ checkpoints: [error('aaaaaaaa-new', '2026-11-21T00:00:00.000Z', 'newest'), error('zzzzzzzz-old', '2026-11-01T00:00:00.000Z', 'oldest')] }));
  assert.match(result.stdout, /^WARN\s+recall: last checkpoint error: aaaaaaaa: newest/m);
});

// The accepted list (owner FR8): ollama-off and apple-terminal-notes turn their WARN into INFO; the production host list WARN stays.
const notify = (env) => {
  const run = { ...parentEnv, ...env, TERM_PROGRAM: 'Apple_Terminal', DOCTOR_ONLY: 'check_notify' };
  return spawnSync('bash', [DOCTOR], { env: run, encoding: 'utf8' });
};
const OLLAMA_WARN = /^WARN\s+recall: Ollama not reachable/m;
const OLLAMA_INFO = /^INFO\s+recall: Ollama not reachable at http:\/\/127\.0\.0\.1:9 .*\(accepted: ollama-off in .*doctor-accepted\)$/m;
const NOTIFY_WARN = /^WARN\s+notify: Apple Terminal shows no desktop note/m;
const NOTIFY_INFO = /^INFO\s+notify: Apple Terminal shows no desktop note.*\(accepted: apple-terminal-notes in .*doctor-accepted\)$/m;

test('accepted ids ollama-off and apple-terminal-notes print INFO, read from ~/.claude/private/doctor-accepted', { skip }, async () => {
  const env = await sandbox({ accepted: '# seen and accepted\nollama-off\r\n  apple-terminal-notes  # Apple Terminal\n' });
  const recall = doctor(env);
  assert.match(recall.stdout, OLLAMA_INFO);
  assert.doesNotMatch(recall.stdout, OLLAMA_WARN);
  const note = notify(env);
  assert.match(note.stdout, NOTIFY_INFO);
  assert.doesNotMatch(note.stdout, /^WARN/m);
  const list = spawnSync('bash', [DOCTOR], { env: { ...parentEnv, ...env, DOCTOR_ONLY: 'check_doctor_accepted' }, encoding: 'utf8' });
  assert.equal(list.stdout.trim(), `ok    doctor accepted list: 2 ids (${join(env.HOME, '.claude', 'private', 'doctor-accepted')})`);
});

test('CLAUDE_DOCTOR_ACCEPTED_FILE names the accepted list instead of the one under ~/.claude', { skip }, async () => {
  const env = await sandbox({ accepted: '' });
  const file = join(env.HOME, 'elsewhere');
  await writeFile(file, 'ollama-off\n');
  const named = doctor({ ...env, CLAUDE_DOCTOR_ACCEPTED_FILE: file }).stdout;
  assert.ok(named.includes(`(search is lexical only; start it with: ollama serve) (accepted: ollama-off in ${file})\n`), named);
  assert.match(named, /^INFO\s+recall: Ollama not reachable/m);
  assert.match(doctor(env).stdout, OLLAMA_WARN); // the empty file under ~/.claude accepts nothing
});

test('a production host id in the accepted list changes nothing: that WARN stays, and the bad id is one WARN', { skip }, async () => {
  const env = await sandbox({ accepted: 'prod-hosts\nno-prod-hosts\n' });
  const hosts = spawnSync('bash', [DOCTOR], { env: { ...parentEnv, ...env, DOCTOR_ONLY: 'check_prod_hosts' }, encoding: 'utf8' });
  assert.match(hosts.stdout, /^WARN\s+no prod-hosts list/m);
  assert.doesNotMatch(hosts.stdout, /^INFO/m);
  const list = spawnSync('bash', [DOCTOR], { env: { ...parentEnv, ...env, DOCTOR_ONLY: 'check_doctor_accepted' }, encoding: 'utf8' });
  assert.equal(list.stdout.split('\n').filter((line) => line.startsWith('WARN')).length, 1, list.stdout);
  assert.match(list.stdout, /^WARN\s+doctor accepted list \(.*\) holds ids doctor cannot accept: prod-hosts no-prod-hosts \(known: ollama-off apple-terminal-notes; the production host list WARN is never accepted\)$/m);
  assert.match(doctor(env).stdout, OLLAMA_WARN);
});

test('a missing or empty accepted list keeps every WARN and adds none', { skip }, async () => {
  for (const accepted of [undefined, '', '# only a comment\n']) {
    const env = await sandbox({ accepted });
    assert.match(doctor(env).stdout, OLLAMA_WARN, String(accepted));
    assert.match(notify(env).stdout, NOTIFY_WARN, String(accepted));
    const list = spawnSync('bash', [DOCTOR], { env: { ...parentEnv, ...env, DOCTOR_ONLY: 'check_doctor_accepted' }, encoding: 'utf8' });
    assert.match(list.stdout, /^ok\s+(no doctor accepted list|doctor accepted list: 0 ids)/m, String(accepted));
    assert.doesNotMatch(list.stdout, /^WARN/m);
  }
});

test('an accepted list that is a link accepts nothing and is one WARN', { skip: skipLink }, async () => {
  const env = await sandbox({ accepted: '' });
  const real = join(env.HOME, 'real-accepted');
  await writeFile(real, 'ollama-off\napple-terminal-notes\n');
  const file = join(env.HOME, '.claude', 'private', 'doctor-accepted');
  await rm(file);
  await symlink(real, file);
  assert.match(doctor(env).stdout, OLLAMA_WARN);
  assert.match(notify(env).stdout, NOTIFY_WARN);
  const list = spawnSync('bash', [DOCTOR], { env: { ...parentEnv, ...env, DOCTOR_ONLY: 'check_doctor_accepted' }, encoding: 'utf8' });
  assert.match(list.stdout.trim(), /^WARN\s+doctor accepted list is a link or not a plain file \(.*doctor-accepted\): nothing is accepted/);
});
