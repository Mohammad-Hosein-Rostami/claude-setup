// Purpose: the `recall status` and `recall backfill` commands.
// Exports: cmdStatus, cmdBackfill, estimateBackfill, ollamaModelStatus.
// Invariants: `status` only reads (servers, Ollama tags, index counts, checkpoint state, usage log) and never starts
// anything; `backfill` prints its token estimate first and runs Haiku only with --yes; sessions that already have notes
// or a checkpoint state are skipped, so it is safe to repeat.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHARS_PER_TOKEN, acquireLock, listCheckpoints, readCheckpoint, releaseLock } from './checkpoint-state.mjs';
import { runCheckpoint } from './checkpoint.mjs';
import { discoverFiles, resolveHome, resolveRoot } from './indexer.mjs';
import { DEFAULT_IDLE_MS, idleLimitMs } from './rerank-watch.mjs';
import { RERANK_FILES, readServer, rerankModelPath } from './rerank-server.mjs';
import { EMBED_MODELS, stackModels } from './models.mjs';
import { windowsOf, WINDOW_CHARS } from './notes.mjs';
import { readSlice } from './slice.mjs';
import { usageTotals } from './usage.mjs';
import { ollamaBase } from './vectors.mjs';

const CALL_OVERHEAD_TOKENS = 1000; // system prompt + framing per Haiku call (measured 0.4k + the ~0.5k prompt)
const OUTPUT_TOKENS_PER_WINDOW = 1500;
const OLLAMA_TIMEOUT_MS = 1500;
const MS_PER_MINUTE = 60000;
const SESSION_SHORT = 8;
const k = (n) => `${(n / 1000).toFixed(1)}k`;

/** Which default embedding models Ollama has: { reachable, models: {key: boolean}, reason? }. */
export async function ollamaModelStatus(env = process.env) {
  const keys = stackModels(env);
  try {
    const response = await fetch(`${ollamaBase(env)}/api/tags`, { redirect: 'error', signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS) });
    const names = ((await response.json()).models ?? []).map((m) => m.name);
    return { reachable: true, models: Object.fromEntries(keys.map((key) => [key, names.some((n) => n === (EMBED_MODELS[key]?.ollama ?? key) || n.startsWith(`${EMBED_MODELS[key]?.ollama ?? key}:`))])) };
  } catch (error) {
    return { reachable: false, models: {}, reason: error.message };
  }
}

function serverLine(env) {
  const server = readServer(env);
  if (!server) return `reranker server: not running (starts on demand; stops after ${Math.round(idleLimitMs(env) / MS_PER_MINUTE)} idle min)`;
  const idle = Math.round((Date.now() - server.lastUsed) / MS_PER_MINUTE);
  return `reranker server: running ${RERANK_FILES[server.tier]} pid ${server.pid} port ${server.port}, idle ${idle} min (stops at ${Math.round(DEFAULT_IDLE_MS / MS_PER_MINUTE)})`;
}

/** `recall status`: servers, models, index size, last checkpoint per session, Haiku tokens today / 7 days. */
export async function cmdStatus(store, env = process.env) {
  console.log(serverLine(env));
  const files = Object.entries(RERANK_FILES).map(([tier, name]) => `${name} ${existsSync(rerankModelPath(tier, env)) ? 'ok' : 'MISSING'}`);
  console.log(`reranker files: ${files.join(', ')}`);
  const ollama = await ollamaModelStatus(env);
  console.log(ollama.reachable ? `ollama: reachable; ${Object.entries(ollama.models).map(([m, ok]) => `${m} ${ok ? 'ok' : 'NOT PULLED'}`).join(', ')}` : `ollama: not reachable (${ollama.reason})`);
  const s = store.stats();
  console.log(`index: ${s.total} chunks, ${s.sessions} sessions, ${s.kinds.find((x) => x.kind === 'note')?.n ?? 0} notes; vectors ${s.vectors.map((v) => `${v.model} ${v.n}`).join(', ') || 'none'}`);
  const states = listCheckpoints(env);
  if (!states.length) console.log('checkpoints: none yet');
  for (const c of states.slice(0, 8)) {
    console.log(`checkpoint ${String(c.session).slice(0, SESSION_SHORT)}: ${c.ts ?? 'never'}, ${c.notes ?? 0} notes, lines ${c.lines?.join('-') ?? '?'}${c.error ? `, ERROR ${c.error.message}` : ''}${c.warn ? `, warn ${c.warn}` : ''}`);
  }
  const u = usageTotals(env);
  console.log(`haiku tokens (counted): today ${k(u.today.tokens)} in ${u.today.calls} calls, last 7 days ${k(u.week.tokens)} in ${u.week.calls} calls`);
}

/** Token estimate for summarising one transcript: { messages, windows, input, output }. */
export function estimateBackfill(path) {
  const { messages } = readSlice(path);
  const windows = windowsOf(messages);
  const chars = windows.reduce((sum, w) => sum + Math.min(w.text.length, WINDOW_CHARS), 0);
  return { messages: messages.length, windows: windows.length, input: Math.round(chars / CHARS_PER_TOKEN) + windows.length * CALL_OVERHEAD_TOKENS, output: windows.length * OUTPUT_TOKENS_PER_WINDOW };
}

function candidates(store, minMessages, env) {
  const root = resolveRoot(env);
  const hasNotes = store.db.prepare("SELECT 1 FROM chunks WHERE kind = 'note' AND session = ? LIMIT 1");
  return discoverFiles({ root, home: resolveHome(root, env), cwds: [] })
    .filter((f) => f.type === 'main' && !readCheckpoint(f.session, env) && !hasNotes.get(f.session))
    .map((f) => ({ ...f, ...estimateBackfill(f.path) }))
    .filter((f) => f.messages >= minMessages);
}

/**
 * `recall backfill`: summarise old sessions that have no notes. Prints the estimate first; runs only with `yes`.
 * @param {object} store open store.
 * @param {{minMessages: number, yes: boolean}} options
 */
export async function cmdBackfill(store, { minMessages, yes }, env = process.env) {
  const found = candidates(store, minMessages, env);
  for (const f of found) console.log(`  ${f.session.slice(0, SESSION_SHORT)} ${f.project.slice(-24)}: ${f.messages} messages, ${f.windows} Haiku calls, ~${k(f.input + f.output)} tokens`);
  const input = found.reduce((s, f) => s + f.input, 0);
  const output = found.reduce((s, f) => s + f.output, 0);
  const calls = found.reduce((s, f) => s + f.windows, 0);
  console.log(`backfill: ${found.length} sessions with >= ${minMessages} messages and no notes; ${calls} Haiku calls, ~${k(input)} input + ~${k(output)} output tokens (subscription).`);
  if (!yes) return console.log('Nothing was run. Add --yes to summarise them (one call at a time).');
  for (const f of found) {
    const setPid = acquireLock(f.session, env);
    if (!setPid) { console.error(`  ${f.session.slice(0, SESSION_SHORT)}: a checkpoint is already running, skipped`); continue; }
    setPid(process.pid); // a live pid keeps the lock however long the backfill of this session runs
    try {
      const r = await runCheckpoint({ session: f.session, transcript: resolve(f.path), reason: 'backfill', env, maxBytes: Infinity });
      console.log(`  ${f.session.slice(0, SESSION_SHORT)}: ${r.notes} notes from ${r.windows} windows${r.failed ? `, ${r.failed} failed` : ''}`);
    } catch (error) {
      console.error(`  ${f.session.slice(0, SESSION_SHORT)}: ${error.message}`);
    } finally {
      releaseLock(f.session, env);
    }
  }
}
