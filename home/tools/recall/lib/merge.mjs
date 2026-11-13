// Purpose: merge lexical (BM25) hits with vector-only candidates.
// Exports: mergeSemantic, rankedLists, MERGE_MODES, LEXICAL_WINDOW.
// Invariants: pure; `add` keeps the two best lexical hits first, then alternates vector-only candidates (by similarity)
// with the next lexical hits, so the lexical ranking is only ever interleaved with, never reordered; `rrf` is plain
// reciprocal-rank fusion (k=60) of the lexical ranking and any number of vector rankings (one per embedding model).
export const MERGE_MODES = ['add', 'rrf'];
export const LEXICAL_WINDOW = 10; // in `add` mode a vector hit already in the lexical top 10 is not re-added
const RRF_K = 60;
const LEXICAL_HEAD = 2;

function mergeAdd(allLexical, extra) {
  const pulled = new Set(extra.map((r) => r.id));
  const lexical = allLexical.filter((r) => !pulled.has(r.id)); // a vector hit beyond the lexical head moves up
  const out = lexical.slice(0, LEXICAL_HEAD);
  let l = LEXICAL_HEAD;
  let v = 0;
  while (l < lexical.length || v < extra.length) {
    if (v < extra.length) out.push(extra[v++]);
    if (l < lexical.length) out.push(lexical[l++]);
  }
  return out;
}

/** The vector rankings of a `semantic` value: `lists` (several models) or the single `ranked`. */
export const rankedLists = (semantic) => semantic.lists ?? [semantic.ranked];

function mergeRrf(lexical, extra, lists) {
  const rankMaps = lists.map((ranked) => new Map(ranked.map((s, i) => [s.id, i])));
  const scored = [...lexical.map((row, i) => ({ row, lex: i })), ...extra.map((row) => ({ row, lex: -1 }))].map(({ row, lex }) => {
    let score = lex >= 0 ? 1 / (RRF_K + lex) : 0;
    for (const rankOf of rankMaps) {
      const rank = rankOf.get(row.id);
      if (rank !== undefined) score += 1 / (RRF_K + rank);
    }
    return { ...row, score };
  });
  return scored.sort((a, b) => b.score - a.score);
}

/**
 * @param {object[]} lexical ranked lexical rows.
 * @param {object[]} extra rows found only by vectors, in similarity order.
 * @param {{ranked?: {id:number, sim:number}[], lists?: {id:number, sim:number}[][], mode: 'add'|'rrf'}} semantic vector
 *   candidates (one ranking, or `lists`: one ranking per embedding model) and merge mode. `add` uses the first ranking only.
 * @returns {object[]} merged ranking; rrf adds 1/(60+rank) over the lexical list and every vector list.
 */
export function mergeSemantic(lexical, extra, semantic) {
  return semantic.mode === 'rrf' ? mergeRrf(lexical, extra, rankedLists(semantic)) : mergeAdd(lexical, extra);
}
