#!/usr/bin/env node
// Purpose: CLI for recall, a local search over past Claude Code sessions, their live checkpoint notes and project
// notes: lexical + bge-m3 + qwen3-embedding-4b fused, then reranked by qwen3-reranker (0.6b, or 4b with --deep).
// Commands: `recall "<query>"` (= search), `--owner` (the owner's own messages of a session), index, search, show, stats, embed, eval, status, backfill (see README.md).
// Exports: none. Env: RECALL_DB (index file), RECALL_ROOT (transcripts dir), RECALL_HOME (project-notes/ and
// recall.json), RECALL_OLLAMA_URL and RECALL_RERANK_URL (loopback only), RECALL_EMBED_MODEL (pins one model, no reranker).
// Exit codes: 0 ok, 2 usage or runtime error. Never prints stack traces for expected errors. Every stage that is
// unusable prints one stderr line (`recall: semantic off (<reason>)`, `recall: skipped <stage> (<reason>)`) and the
// answer comes from the next cheaper stage.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { indexAll, resolveRoot } from './lib/indexer.mjs';
import { isBusyError, openStore } from './lib/store.mjs';
import { formatHits, formatJson, formatShow } from './lib/search.mjs';
import { formatReport, parseQuestions, scoreEval, sessionFileOf } from './lib/eval.mjs';
import { embedStore, ollamaBase, ollamaReason } from './lib/vectors.mjs';
import { stackModels } from './lib/models.mjs';
import { cmdBackfill, cmdStatus } from './lib/cli-admin.mjs';
import { parseLists, runSearch } from './lib/pipeline.mjs';
import { rerankBase } from './lib/rerank.mjs';
import { MERGE_MODES } from './lib/merge.mjs';
import { findSession, NON_INTERACTIVE_NOTE, OWNER_HEADER, ownerMessages } from './lib/owner-messages.mjs';

const USAGE = 'usage: recall "<query>" [--session current|<id>] [--deep] [--k 8] | recall --owner [--session current|<id>] [--since YYYY-MM-DD] | recall <index [--full] [--model m] | search "<query>" [--project s] [--since YYYY-MM-DD] [--kind k] [--limit N] [--json] | show <id> [--around N] | stats | status | backfill [--min-messages 20] [--yes] | embed [--model m] | eval <questions.jsonl> [--session-file <path>] [--k 1,5,10]>; search/eval also take [--no-semantic] [--merge add|rrf] [--model m] [--lists lex,bge,qwen] [--rerank N] (semantic and the reranker are automatic when Ollama, vectors and the reranker files exist)';
const SEARCH_INDEX_BUDGET_MS = 3000;
const DEFAULT_LIMIT = 8;
const DEFAULT_AROUND = 2;
// Measured (bge-m3 + rrf vs lexical on holdout questions): hit@1 15 to 65, hit@5 45 to 70. See README "Semantic layer".
const DEFAULT_MERGE = 'rrf';
const PROGRESS_EVERY = 640;
const EVAL_QUERY_TIMEOUT_MS = 30000; // a cold model needs seconds to load; the 500 ms search cap would skip every query
const KINDS = ['user', 'assistant', 'summary', 'agent', 'doc', 'note'];
const DEFAULT_MIN_MESSAGES = 20;
const DEFAULT_RERANK = 30; // measured: top-30 of the fused list is what the reranker reorders (study S1)
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const OPTIONS = {
  full: { type: 'boolean' }, json: { type: 'boolean' }, project: { type: 'string' }, since: { type: 'string' },
  kind: { type: 'string' }, limit: { type: 'string' }, around: { type: 'string' }, k: { type: 'string' },
  'session-file': { type: 'string' }, semantic: { type: 'boolean' }, 'no-semantic': { type: 'boolean' },
  merge: { type: 'string' }, model: { type: 'string' }, lists: { type: 'string' }, rerank: { type: 'string' },
  session: { type: 'string' }, owner: { type: 'boolean' }, deep: { type: 'boolean' }, 'min-messages': { type: 'string' }, yes: { type: 'boolean' },
};

class UsageError extends Error {}

function intOption(value, fallback, name, min) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new UsageError(`--${name} must be an integer >= ${min}`);
  return n;
}

const positiveInt = (value, fallback, name) => intOption(value, fallback, name, 1);
const nonNegativeInt = (value, fallback, name) => intOption(value, fallback, name, 0);

/** The session filter: `current` is this session (CLAUDE_CODE_SESSION_ID), else an id or its leading characters. */
function sessionFilter(value, env = process.env) {
  if (value === undefined) return undefined;
  if (value !== 'current') return value;
  if (!env.CLAUDE_CODE_SESSION_ID) throw new UsageError('--session current needs CLAUDE_CODE_SESSION_ID (set inside Claude Code); pass --session <id> instead');
  return env.CLAUDE_CODE_SESSION_ID;
}

function readFilters(values) {
  if (values.kind && !KINDS.includes(values.kind)) throw new UsageError(`--kind must be one of ${KINDS.join('|')}`);
  if (values.since && !DATE_PATTERN.test(values.since)) throw new UsageError('--since must be YYYY-MM-DD');
  return { kind: values.kind, project: values.project, since: values.since, session: sessionFilter(values.session) };
}

function quickIndex(store) {
  try {
    const result = indexAll(store, { root: resolveRoot(), deadline: Date.now() + SEARCH_INDEX_BUDGET_MS });
    if (result.capped) console.error('index catching up, run `recall index`');
  } catch (error) {
    if (!isBusyError(error)) throw error;
    console.error('index is busy (another recall process is writing); searching the existing index');
  }
}

/**
 * Search options from the flags. Semantic is on unless --no-semantic; the vector models are the default stack (bge-m3 +
 * qwen3-embedding-4b), one --model / RECALL_EMBED_MODEL, or `--lists lex,bge,qwen`. The reranker reorders the top
 * DEFAULT_RERANK fused hits by default on the default stack, always with --deep, or the top N of `--rerank N` (0 = off).
 * A non-loopback RECALL_OLLAMA_URL / RECALL_RERANK_URL is refused here, before any indexing.
 */
function searchOptions(values) {
  const mode = values.merge ?? DEFAULT_MERGE;
  if (!MERGE_MODES.includes(mode)) throw new UsageError(`--merge must be one of ${MERGE_MODES.join('|')}`);
  const on = !values['no-semantic'];
  const stackDefault = on && !values.model && !process.env.RECALL_EMBED_MODEL;
  const rerank = nonNegativeInt(values.rerank, values.deep || stackDefault ? DEFAULT_RERANK : 0, 'rerank');
  if (rerank) rerankBase();
  if (on) ollamaBase();
  let models = values.model ? [values.model] : stackModels();
  if (values.lists) {
    try {
      models = parseLists(values.lists);
    } catch (error) {
      throw new UsageError(error.message);
    }
  }
  return { models: on ? models : [], mode, rerank, deep: Boolean(values.deep) };
}

const semanticOff = (reason) => console.error(`recall: semantic off (${reason})`);
const stageSkipped = (stage, reason, next) => console.error(`recall: skipped ${stage} (${reason}); ${next ? `using ${next}` : 'keeping the fused order'}`);

/** After the lexical pass: embed the chunks that have no vector yet. Stops softly (stderr) when Ollama is unusable. */
async function embedPending(store, model) {
  const missing = store.stats().total - store.vectorCount(model);
  if (missing <= 0) return;
  const started = Date.now();
  let done = 0;
  try {
    await embedStore(store, model, {
      onProgress: (n) => {
        done = n;
        if (n % PROGRESS_EVERY === 0) console.error(`embedded ${n} of ${missing} chunks`);
      },
    });
    console.log(`embedded ${done} chunks with ${model} in ${Date.now() - started}ms`);
  } catch (error) {
    const reason = ollamaReason(error, model);
    console.error(done === 0 ? `recall: semantic off (${reason})` : `recall: embedding stopped after ${done} of ${missing} chunks (${reason}); run \`recall index\` again to resume`);
  }
}

const embedModels = (values) => (values.model ? [values.model] : stackModels());

async function cmdIndex(store, { values }) {
  ollamaBase(); // refuse a non-loopback URL before doing any work
  const started = Date.now();
  const r = indexAll(store, { root: resolveRoot(), full: Boolean(values.full) });
  console.log(`indexed ${r.files} files, added ${r.added} chunks, skipped ${r.bad} unreadable lines in ${Date.now() - started}ms`);
  for (const model of embedModels(values)) await embedPending(store, model);
}

async function cmdSearch(store, { values, positionals }) {
  const query = positionals.slice(1).join(' ');
  if (!query.trim()) throw new UsageError('search needs a query');
  const limit = positiveInt(values.limit ?? values.k, DEFAULT_LIMIT, 'limit');
  const filters = readFilters(values);
  const options = searchOptions(values);
  quickIndex(store);
  const hits = await runSearch(store, query, { limit, filters, ...options, onOff: semanticOff, onSkip: stageSkipped });
  console.log(values.json ? formatJson(hits) : formatHits(hits));
}

function cmdShow(store, { values, positionals }) {
  const id = Number(positionals[1]);
  if (!Number.isInteger(id)) throw new UsageError('show needs a numeric chunk id');
  const rows = store.neighbours(id, nonNegativeInt(values.around, DEFAULT_AROUND, 'around'));
  if (!rows) throw new UsageError(`no chunk with id ${id}`);
  console.log(formatShow(rows, id));
}

async function cmdEmbed(store, { values }) {
  ollamaBase(); // refuse a non-loopback URL even when there is nothing to embed
  const total = store.stats().total;
  for (const model of embedModels(values)) {
    const started = Date.now();
    const done = await embedStore(store, model, {
      onProgress: (n) => { if (n % PROGRESS_EVERY === 0) console.error(`embedded ${n} of ${total} chunks`); },
    });
    console.log(`embedded ${done} new chunks with ${model} in ${Date.now() - started}ms`);
  }
}

function cmdStats(store) {
  const s = store.stats();
  console.log(`chunks ${s.total}, sessions ${s.sessions}, files ${s.files}`);
  for (const k of s.kinds) console.log(`  ${k.kind}: ${k.n}`);
  for (const v of s.vectors) console.log(`  vectors ${v.model}: ${v.n}`);
}

async function cmdEval(store, { values, positionals }) {
  const file = positionals[1];
  if (!file) throw new UsageError('eval needs <questions.jsonl>');
  const text = readFileSync(file, 'utf8');
  const sessionFile = values['session-file'] ?? sessionFileOf(text);
  if (!sessionFile) throw new UsageError('eval needs --session-file <path> (or a {"session_file": ...} first line in the file)');
  const ks = (values.k ?? '1,5,10').split(',').map(Number);
  if (ks.some((k) => !Number.isInteger(k) || k < 1)) throw new UsageError('--k must be positive integers, e.g. 1,5,10');
  const questions = parseQuestions(text);
  const options = searchOptions(values);
  quickIndex(store);
  const reasons = new Set(); // each distinct "off" reason is said once, not once per question
  const once = (say) => (reason) => { if (!reasons.has(reason)) { reasons.add(reason); say(reason); } };
  const hitsById = new Map();
  for (const q of questions) {
    const run = { limit: Math.max(...ks), ...options, timeoutMs: EVAL_QUERY_TIMEOUT_MS, onOff: once(semanticOff), onSkip: (stage, reason, next) => once(() => stageSkipped(stage, reason, next))(`${stage}:${reason}`) };
    hitsById.set(q.id, await runSearch(store, q.question, run));
  }
  console.log(formatReport(scoreEval(questions, (q) => hitsById.get(q.id), { sessionFile: resolve(sessionFile), ks })));
}

/** `recall --owner`: what the owner typed in one session (default: this one), oldest first, masked. Needs no index. */
async function cmdOwner({ values }) {
  const session = sessionFilter(values.session ?? 'current');
  if (values.since && !DATE_PATTERN.test(values.since)) throw new UsageError('--since must be YYYY-MM-DD');
  let file;
  try {
    file = findSession(resolveRoot(), session);
  } catch (error) {
    throw new UsageError(error.message);
  }
  let headerPrinted = false;
  for await (const { index, time, text, nonInteractive } of ownerMessages(file, { since: values.since })) {
    if (!headerPrinted) console.log(OWNER_HEADER + (nonInteractive ? NON_INTERACTIVE_NOTE : ''));
    headerPrinted = true;
    console.log(`> ${index}\t${time}\t${text}`);
  }
}

const COMMANDS = {
  index: cmdIndex, search: cmdSearch, show: cmdShow, stats: cmdStats, embed: cmdEmbed, eval: cmdEval,
  status: (store) => cmdStatus(store),
  backfill: (store, { values }) => cmdBackfill(store, { minMessages: positiveInt(values['min-messages'], DEFAULT_MIN_MESSAGES, 'min-messages'), yes: Boolean(values.yes) }),
};

async function main(argv) {
  const parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  if (parsed.values.owner) return cmdOwner(parsed);
  const first = parsed.positionals[0];
  if (first === undefined) throw new UsageError(USAGE);
  const named = Object.hasOwn(COMMANDS, first);
  const handler = named ? COMMANDS[first] : cmdSearch;
  if (!named) parsed.positionals.unshift('search'); // `recall "<query>"` is `recall search "<query>"`
  const store = openStore();
  try {
    await handler(store, parsed);
  } finally {
    store.close();
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`${error instanceof UsageError ? 'usage error' : 'error'}: ${error.message}`);
  process.exitCode = 2;
}
