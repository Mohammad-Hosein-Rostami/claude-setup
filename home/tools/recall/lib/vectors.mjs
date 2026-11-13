// Purpose: semantic layer: embed chunks with a local Ollama model, store Float32 vectors, rank by cosine.
// Exports: embedTexts, embedQuery, embedStore, semanticFor, semanticForModels, cosineTop, defaultModel, ollamaBase,
// loopbackOrigin, ollamaReason, DEFAULT_MODEL, QUERY_TIMEOUT_MS.
// Invariants: Ollama is only ever called on a loopback URL (anything else throws before a byte is sent, redirects are
// refused) and only with redacted text; every other failure on the search path (down, slow, no vectors, model not
// pulled) makes semanticFor report a reason through `onOff` and return null, so search is exactly the lexical one;
// vectors are L2-normalised so cosine is a dot product; scoring streams the vectors and keeps only the top K.
import { redact } from './redact.mjs';
import { ollamaName, queryPrefix } from './models.mjs';

export const DEFAULT_MODEL = 'bge-m3';
export const QUERY_TIMEOUT_MS = 8000; // covers a cold model load; a refused connection still fails at once
const EMBED_TIMEOUT_MS = 120000;
const KEEP_ALIVE = '30m';
const BATCH_SIZE = 32;
const MAX_EMBED_CHARS = 2000;
const TOP_K = 50;
const DEFAULT_URL = 'http://localhost:11434';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const REASON_CHARS = 120;

/** RECALL_EMBED_MODEL, else bge-m3. */
export const defaultModel = (env = process.env) => env.RECALL_EMBED_MODEL || DEFAULT_MODEL;

/**
 * The Ollama origin from RECALL_OLLAMA_URL (default http://localhost:11434).
 * @returns {string} origin without a path.
 * @throws when the URL is invalid or not loopback (localhost, 127.0.0.1, ::1): chunk text never leaves the machine.
 */
export function ollamaBase(env = process.env) {
  return loopbackOrigin(env.RECALL_OLLAMA_URL || DEFAULT_URL, 'RECALL_OLLAMA_URL');
}

/**
 * The origin of a URL that must be loopback (localhost, 127.0.0.1, ::1); `name` is the setting shown in errors.
 * @throws when the URL is invalid or not loopback: chunk text never leaves the machine.
 */
export function loopbackOrigin(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`${name} must be a loopback address (localhost, 127.0.0.1 or ::1); recall never sends text elsewhere`);
  }
  return url.origin;
}

/** A short human reason for a failed Ollama call (used in `recall: semantic off (<reason>)`). */
export function ollamaReason(error, model) {
  if (error?.name === 'TimeoutError') return 'Ollama timed out';
  if (/^ollama 404/.test(error?.message ?? '')) return `model ${model} is not pulled (ollama pull ${ollamaName(model)})`;
  if (error?.message === 'fetch failed') return `Ollama is not reachable (${error.cause?.code ?? error.cause?.message ?? 'network error'})`;
  return String(error?.message ?? error).slice(0, REASON_CHARS);
}

function unit(values) {
  const v = Float32Array.from(values);
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

/**
 * Embed texts through Ollama /api/embed. Every text is redacted again first, then cut to 2000 chars.
 * @param {string} model stored-vector key (see lib/models.mjs; unknown names go to Ollama as they are).
 * @param {string[]} texts inputs.
 * @param {{timeoutMs?: number, query?: boolean}} [options] `query: true` puts the model's query prefix (if any) in front.
 * @returns {Promise<Float32Array[]>} unit vectors, one per text.
 * @throws when the URL is not loopback, Ollama is unreachable, answers an error, or returns the wrong number of vectors.
 */
export async function embedTexts(model, texts, { timeoutMs = EMBED_TIMEOUT_MS, query = false } = {}) {
  const base = ollamaBase();
  const prefix = query ? queryPrefix(model) : '';
  const input = texts.map((t) => prefix + redact(t).slice(0, MAX_EMBED_CHARS));
  const response = await fetch(`${base}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: ollamaName(model), input, keep_alive: KEEP_ALIVE }),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`ollama ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const { embeddings } = await response.json();
  if (!Array.isArray(embeddings) || embeddings.length !== texts.length) throw new Error('ollama returned a wrong embedding count');
  return embeddings.map(unit);
}

/** One query vector as { vec }, or { reason } when Ollama is down, slow, or lacks the model (never throws on those). */
export async function embedQuery(model, query, timeoutMs = QUERY_TIMEOUT_MS) {
  try {
    return { vec: (await embedTexts(model, [query], { timeoutMs, query: true }))[0] };
  } catch (error) {
    return { reason: ollamaReason(error, model) };
  }
}

/**
 * Embed every chunk that has no vector for `model`, in batches; incremental and committed per batch, so an
 * interrupted run loses at most one batch and a rerun only does the rest.
 * @returns {Promise<number>} chunks embedded in this run.
 */
export async function embedStore(store, model, { batchSize = BATCH_SIZE, onProgress = () => {} } = {}) {
  let done = 0;
  for (let rows = store.chunksWithoutVector(model, batchSize); rows.length; rows = store.chunksWithoutVector(model, batchSize)) {
    const vectors = await embedTexts(model, rows.map((r) => r.text));
    store.putVectors(model, rows.map((r, i) => ({ id: r.id, vec: vectors[i] })));
    done += rows.length;
    onProgress(done);
  }
  return done;
}

// Min-heap on similarity (ties: the higher id is "worse"), so the root is the first candidate to be replaced.
const worse = (a, b) => a.sim < b.sim || (a.sim === b.sim && a.id > b.id);

function siftUp(heap, from) {
  for (let i = from, parent = (i - 1) >> 1; i > 0 && worse(heap[i], heap[parent]); i = parent, parent = (i - 1) >> 1) {
    [heap[i], heap[parent]] = [heap[parent], heap[i]];
  }
}

function siftDown(heap) {
  for (let i = 0; ;) {
    let low = i;
    for (const child of [2 * i + 1, 2 * i + 2]) if (child < heap.length && worse(heap[child], heap[low])) low = child;
    if (low === i) return;
    [heap[i], heap[low]] = [heap[low], heap[i]];
    i = low;
  }
}

/**
 * Top `k` chunk ids by cosine similarity to `queryVec`, best first: [{id, sim}].
 * @param {Iterable<{id:number, vec:Float32Array}>} vectors any iterable (a generator keeps memory flat).
 */
export function cosineTop(vectors, queryVec, k = TOP_K) {
  const heap = [];
  for (const { id, vec } of vectors) {
    if (vec.length !== queryVec.length) continue; // vectors of another model/dimension
    let dot = 0;
    for (let i = 0; i < vec.length; i += 1) dot += vec[i] * queryVec[i];
    const item = { id, sim: dot };
    if (heap.length < k) { heap.push(item); siftUp(heap, heap.length - 1); } else if (worse(heap[0], item)) { heap[0] = item; siftDown(heap); }
  }
  return heap.sort((a, b) => b.sim - a.sim || a.id - b.id);
}

/**
 * Semantic candidates for a query: { ranked, mode } or null. null means no vectors for the model, or Ollama is
 * down, slower than `timeoutMs`, or lacks the model; the reason goes to `onOff`. The caller passes the result to
 * searchChunks as `semantic`.
 * @throws when RECALL_OLLAMA_URL is not loopback.
 */
export async function semanticFor(store, query, { model = defaultModel(), mode = 'rrf', timeoutMs = QUERY_TIMEOUT_MS, onOff = () => {} } = {}) {
  ollamaBase();
  if (!store.vectorCount(model)) {
    onOff(`no ${model} vectors yet; run \`recall index\``);
    return null;
  }
  const { vec, reason } = await embedQuery(model, query, timeoutMs);
  if (!vec) {
    onOff(reason);
    return null;
  }
  return { ranked: cosineTop(store.iterateVectors(model), vec), mode };
}

/**
 * Semantic candidates from several models at once (their rankings are fused by rrf): { lists, mode } or null.
 * A model that is unusable (no vectors, Ollama down or slow, not pulled) is dropped and reported through `onOff`;
 * null means none was usable. Models are queried in parallel.
 * @param {string[]} models stored-vector keys, e.g. ['bge-m3', 'qwen3-embedding-4b'].
 * @throws when RECALL_OLLAMA_URL is not loopback.
 */
export async function semanticForModels(store, query, models, { mode = 'rrf', timeoutMs = QUERY_TIMEOUT_MS, onOff = () => {} } = {}) {
  const found = await Promise.all(models.map((model) => semanticFor(store, query, { model, mode, timeoutMs, onOff })));
  const lists = found.filter(Boolean).map((s) => s.ranked);
  return lists.length ? { lists, mode } : null;
}
