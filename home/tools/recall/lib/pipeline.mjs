// Purpose: one search from query to final hits: lexical + vector lists fused by rrf, then an optional reranker.
// Exports: parseLists, runSearch, LIST_ALIASES.
// Invariants: lexical is always one of the fused lists; a vector list or the reranker that is unusable is skipped with a
// reason through `onOff` / `onRerankOff` (the answer is then the plain fusion), never an error; only a non-loopback
// RECALL_OLLAMA_URL / RECALL_RERANK_URL throws.
import { searchChunks } from './search.mjs';
import { rerankHits } from './rerank.mjs';
import { semanticForModels } from './vectors.mjs';

export const LIST_ALIASES = { bge: 'bge-m3', qwen: 'qwen3-embedding-4b' };

/**
 * Parse `--lists lex,bge,qwen` into the vector models to fuse with the lexical list.
 * @param {string} text comma-separated list names: `lex` (required), `bge`, `qwen`.
 * @returns {string[]} stored-vector model keys (empty for `lex` alone).
 * @throws when `lex` is missing or a name is unknown.
 */
export function parseLists(text) {
  const names = text.split(',').map((n) => n.trim()).filter(Boolean);
  if (!names.includes('lex')) throw new Error('--lists must include lex (e.g. lex,bge,qwen)');
  const unknown = names.filter((n) => n !== 'lex' && !LIST_ALIASES[n]);
  if (unknown.length) throw new Error(`--lists: unknown list ${unknown.join(',')} (use lex, ${Object.keys(LIST_ALIASES).join(', ')})`);
  return [...new Set(names.filter((n) => n !== 'lex').map((n) => LIST_ALIASES[n]))];
}

/**
 * Hits for one query.
 * @param {object} store open recall store.
 * @param {string} query search text.
 * @param {{limit: number, filters?: object, models?: string[], mode?: 'add'|'rrf', rerank?: number, timeoutMs?: number,
 *   onOff?: (reason: string) => void, onRerankOff?: (reason: string) => void}} options `models` are the vector lists to
 *   fuse (none = lexical only); `rerank` is how many fused candidates the reranker reorders (0 = off).
 * @returns {Promise<object[]>} at most `limit` hits, best first.
 */
export async function runSearch(store, query, { limit, filters = {}, models = [], mode = 'rrf', rerank = 0, timeoutMs, onOff, onRerankOff }) {
  const semantic = models.length ? await semanticForModels(store, query, models, { mode, timeoutMs, onOff }) : null;
  const depth = Math.max(limit, rerank);
  const hits = searchChunks(store.db, query, { limit, depth, semantic, ...filters });
  if (rerank <= 0) return hits;
  const reordered = await rerankHits(query, hits.slice(0, rerank), { onOff: onRerankOff });
  return [...reordered, ...hits.slice(rerank)].slice(0, limit);
}
