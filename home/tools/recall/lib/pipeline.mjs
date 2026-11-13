// Purpose: one search from query to final hits: lexical + vector lists fused by rrf, then the reranker chain.
// Exports: parseLists, runSearch, rerankChain, LIST_ALIASES, RERANK_STAGES.
// Invariants: lexical is always one of the fused lists; every other stage (a vector list, the 0.6B reranker, the 4B
// deep reranker) that is unusable is skipped with ONE line through `onOff` / `onSkip` and the answer comes from the next
// cheaper stage (deep -> fast reranker -> plain fusion -> lexical), never an error; the reranker only runs when at least
// one vector list was usable; only a non-loopback RECALL_OLLAMA_URL / RECALL_RERANK_URL throws.
import { searchChunks } from './search.mjs';
import { failureReason, rerankBase, rerankScored } from './rerank.mjs';
import { ensureServer } from './rerank-server.mjs';
import { semanticForModels } from './vectors.mjs';

export const LIST_ALIASES = { bge: 'bge-m3', qwen: 'qwen3-embedding-4b' };
export const RERANK_STAGES = {
  fast: { name: 'qwen3-reranker-0.6b', timeoutMs: 20000 }, // ~1.1 s warm; the cap covers the first request after a cold start
  deep: { name: 'qwen3-reranker-4b', timeoutMs: 90000 }, // ~8 s warm
};

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

/** The reranker stages to try, best first: a RECALL_RERANK_URL server (fixed, self-managed) or the managed 4B/0.6B. */
function stagesFor(deep, env) {
  if (env.RECALL_RERANK_URL) return [{ name: 'reranker (RECALL_RERANK_URL)', timeoutMs: RERANK_STAGES.fast.timeoutMs, base: rerankBase(env) }];
  return (deep ? ['deep', 'fast'] : ['fast']).map((tier) => ({ ...RERANK_STAGES[tier], tier }));
}

/**
 * Reorder `hits` with the best reranker that works. Each stage that fails (model or llama-server missing, another
 * server running, slow, bad answer) is reported once through `onSkip(stageName, reason, nextStageName | null)`.
 * @returns {Promise<object[]>} the reordered hits, or `hits` unchanged when every stage failed.
 * @throws when RECALL_RERANK_URL is not loopback.
 */
export async function rerankChain(query, hits, { deep = false, onSkip = () => {}, env = process.env } = {}) {
  const stages = stagesFor(deep, env);
  for (const [i, stage] of stages.entries()) {
    try {
      const base = stage.base ?? (await ensureServer({ deep: stage.tier === 'deep', env })).base;
      return await rerankScored(base, query, hits, stage.timeoutMs);
    } catch (error) {
      onSkip(stage.name, failureReason(error), stages[i + 1]?.name ?? null);
    }
  }
  return hits;
}

/**
 * Hits for one query.
 * @param {object} store open recall store.
 * @param {string} query search text.
 * @param {{limit: number, filters?: object, models?: string[], mode?: 'add'|'rrf', rerank?: number, deep?: boolean,
 *   timeoutMs?: number, env?: object, onOff?: (reason: string) => void,
 *   onSkip?: (stage: string, reason: string, next: string | null) => void}} options `models` are the vector lists to
 *   fuse (none = lexical only); `rerank` is how many fused candidates the reranker reorders (0 = off); `deep` puts the
 *   4B reranker first in the chain. RECALL_RERANK=off in `env` disables reranking (tests, no-GPU machines).
 * @returns {Promise<object[]>} at most `limit` hits, best first.
 */
export async function runSearch(store, query, { limit, filters = {}, models = [], mode = 'rrf', rerank = 0, deep = false, timeoutMs, env = process.env, onOff, onSkip }) {
  const semantic = models.length ? await semanticForModels(store, query, models, { mode, timeoutMs, onOff }) : null;
  const depth = Math.max(limit, rerank);
  const hits = searchChunks(store.db, query, { limit, depth, semantic, ...filters });
  if (rerank <= 0 || env.RECALL_RERANK === 'off' || hits.length < 2) return hits.slice(0, limit); // `depth` can exceed `limit`: only the reranker needs the extra candidates
  if (models.length && !semantic) {
    if (deep) onSkip?.(RERANK_STAGES.deep.name, 'semantic search is off, so there is nothing to rerank', null);
    return hits.slice(0, limit);
  }
  const reordered = await rerankChain(query, hits.slice(0, rerank), { deep, onSkip, env });
  return [...reordered, ...hits.slice(rerank)].slice(0, limit);
}
