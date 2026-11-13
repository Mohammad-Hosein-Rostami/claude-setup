// Purpose: registry of the embedding models recall knows: the short key vectors are stored under, the name Ollama is
// called with, and the prefix a model needs in front of a search query (never in front of a document).
// Exports: EMBED_MODELS, ollamaName, queryPrefix.
// Invariants: pure; an unknown model name is its own Ollama name and takes no prefix, so any Ollama model still works
// and vectors of different models never mix (they are keyed by the short name).
const QWEN3_QUERY_PREFIX = 'Instruct: Given a search query, retrieve relevant passages from past developer chat sessions\nQuery: ';

export const EMBED_MODELS = {
  'bge-m3': { ollama: 'bge-m3', queryPrefix: '' },
  'qwen3-embedding-4b': { ollama: 'hf.co/Qwen/Qwen3-Embedding-4B-GGUF:Q4_K_M', queryPrefix: QWEN3_QUERY_PREFIX },
};

/** The model name to send to Ollama for a stored-vector key (identity for unknown names). */
export const ollamaName = (model) => EMBED_MODELS[model]?.ollama ?? model;

/** The text to put before a query for `model` ('' when it needs none). */
export const queryPrefix = (model) => EMBED_MODELS[model]?.queryPrefix ?? '';
