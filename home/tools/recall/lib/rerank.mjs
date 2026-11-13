// Purpose: reorder the top fused candidates with a local cross-encoder reranker (llama.cpp `llama-server --reranking`).
// Exports: rerankScored, rerankHits, rerankBase, failureReason, RERANK_TIMEOUT_MS, MAX_DOC_CHARS, DEFAULT_RERANK_URL.
// Invariants: the reranker URL (RECALL_RERANK_URL) must be loopback, checked before any byte is sent, redirects are
// refused; only redacted text is sent (hit.text is already redacted, the query is redacted here) and each document is
// cut to MAX_DOC_CHARS; any failure (server down, slow past RERANK_TIMEOUT_MS, bad answer) returns the hits in their
// fused order and reports one reason through `onOff`, so search never fails because of the reranker (`rerankScored`
// is the strict form that throws, used by the pipeline's fallback chain).
import { redact } from './redact.mjs';
import { loopbackOrigin } from './vectors.mjs';

const REASON_CHARS = 120;
export const DEFAULT_RERANK_URL = 'http://127.0.0.1:8012';
export const RERANK_TIMEOUT_MS = 10000;
export const MAX_DOC_CHARS = 1500;

/**
 * The reranker origin from RECALL_RERANK_URL (default http://127.0.0.1:8012).
 * @throws when the URL is invalid or not loopback.
 */
export const rerankBase = (env = process.env) => loopbackOrigin(env.RECALL_RERANK_URL || DEFAULT_RERANK_URL, 'RECALL_RERANK_URL');

/** A short human reason for a failed reranker call (used in `recall: rerank off (<reason>)`). */
export function failureReason(error) {
  if (error?.name === 'TimeoutError') return 'reranker timed out';
  if (error?.message === 'fetch failed') return `reranker is not reachable (${error.cause?.code ?? 'network error'})`;
  return String(error?.message ?? error).slice(0, REASON_CHARS);
}

async function scoreDocuments(base, query, documents, timeoutMs) {
  const response = await fetch(`${base}/v1/rerank`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: redact(query), documents, top_n: documents.length }),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`reranker ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const { results } = await response.json();
  const scores = new Map((Array.isArray(results) ? results : []).map((r) => [r.index, r.relevance_score]));
  if (scores.size !== documents.length || [...scores.values()].some((s) => !Number.isFinite(s))) throw new Error('reranker returned a wrong result list');
  return documents.map((_, i) => scores.get(i));
}

/**
 * Reorder `hits` by reranker score at `base` (a loopback origin), best first; each hit's `score` becomes the reranker
 * score and ties keep the fused order.
 * @throws when the server is down, slow past `timeoutMs`, or answers badly.
 */
export async function rerankScored(base, query, hits, timeoutMs = RERANK_TIMEOUT_MS) {
  if (hits.length < 2) return hits;
  const scores = await scoreDocuments(base, query, hits.map((h) => h.text.slice(0, MAX_DOC_CHARS)), timeoutMs);
  return hits.map((hit, i) => ({ ...hit, score: scores[i], fused: i })).sort((a, b) => b.score - a.score || a.fused - b.fused).map(({ fused: _fused, ...hit }) => hit);
}

/**
 * Like `rerankScored` against the RECALL_RERANK_URL server (default http://127.0.0.1:8012), but soft: a failure
 * returns `hits` unchanged and sends one reason to `onOff`.
 * @param {string} query the search query.
 * @param {object[]} hits fused candidates (`text` already redacted).
 * @param {{timeoutMs?: number, onOff?: (reason: string) => void, env?: object}} [options]
 * @throws when RECALL_RERANK_URL is not loopback.
 */
export async function rerankHits(query, hits, { timeoutMs = RERANK_TIMEOUT_MS, onOff = () => {}, env = process.env } = {}) {
  const base = rerankBase(env);
  try {
    return await rerankScored(base, query, hits, timeoutMs);
  } catch (error) {
    onOff(failureReason(error));
    return hits;
  }
}
