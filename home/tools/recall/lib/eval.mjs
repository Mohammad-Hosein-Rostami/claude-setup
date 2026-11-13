// Purpose: score recall against a JSONL file of gold questions (hit@k overall and per question kind).
// Exports: parseQuestions, sessionFileOf, isHit, scoreEval, formatReport.
// Invariants: a hit is a top-k result from the gold transcript file with |line - gold| <= 3, or whose text contains the
// normalised quote; malformed question lines throw with their line number (the eval file is trusted input).
import { normalize } from './extract.mjs';
import { formatHits } from './search.mjs';

const LINE_TOLERANCE = 3;
const DEFAULT_KS = [1, 5, 10];

const isHeader = (q) => q && typeof q === 'object' && typeof q.session_file === 'string' && q.id === undefined;

/** The `session_file` of an optional first line `{"session_file": "..."}` (a holdout file), else null. */
export function sessionFileOf(text) {
  const first = text.split('\n').find((l) => l.trim());
  try {
    const q = first ? JSON.parse(first) : null;
    return isHeader(q) ? q.session_file : null;
  } catch {
    return null; // not a header line; parseQuestions reports malformed lines
  }
}

/** Parse questions.jsonl into [{id, kind, question, answer, goldLine, quote}]; a `session_file` header line is skipped. */
export function parseQuestions(text) {
  return text.split('\n').filter((l) => l.trim()).map((raw, index) => {
    let q;
    try {
      q = JSON.parse(raw);
    } catch (error) {
      throw new Error(`questions line ${index + 1}: ${error.message}`);
    }
    if (isHeader(q)) return null;
    const goldLine = Number(String(q.source ?? '').replace(/^transcript:/, ''));
    return { id: q.id, kind: q.kind ?? 'other', question: q.question, answer: q.answer, goldLine, quote: q.quote ?? '' };
  }).filter(Boolean);
}

const squash = (s) => normalize(s).toLowerCase().replace(/\s+/g, ' ').trim();

/** True when `hit` is from `sessionFile` and matches the gold line or contains the quote. */
export function isHit(hit, question, sessionFile) {
  if (hit.source !== sessionFile) return false;
  if (Number.isFinite(question.goldLine) && Math.abs(hit.line - question.goldLine) <= LINE_TOLERANCE) return true;
  const quote = squash(question.quote);
  return quote.length > 0 && squash(hit.text).includes(quote);
}

/**
 * Run every question through `search(question) -> hits` and tally hit@k. Returns
 * { total, ks, overall: {k: n}, byKind: {kind: {total, hits: {k: n}}}, avgChars }.
 */
export function scoreEval(questions, search, { sessionFile, ks = DEFAULT_KS }) {
  const overall = Object.fromEntries(ks.map((k) => [k, 0]));
  const byKind = {};
  let chars = 0;
  for (const q of questions) {
    const hits = search(q);
    chars += formatHits(hits).length;
    const bucket = (byKind[q.kind] ??= { total: 0, hits: Object.fromEntries(ks.map((k) => [k, 0])) });
    bucket.total += 1;
    for (const k of ks) {
      if (hits.slice(0, k).some((h) => isHit(h, q, sessionFile))) {
        overall[k] += 1;
        bucket.hits[k] += 1;
      }
    }
  }
  return { total: questions.length, ks, overall, byKind, avgChars: questions.length ? Math.round(chars / questions.length) : 0 };
}

const pct = (n, total) => (total ? `${((100 * n) / total).toFixed(1)}%` : 'n/a');

/** Human-readable report of a scoreEval result. */
export function formatReport(result) {
  const row = (label, hits, total) => `${label.padEnd(14)} n=${String(total).padEnd(4)} ${result.ks.map((k) => `hit@${k} ${pct(hits[k], total)}`).join('  ')}`;
  const lines = [row('overall', result.overall, result.total)];
  for (const [kind, b] of Object.entries(result.byKind)) lines.push(row(kind, b.hits, b.total));
  lines.push(`avg output chars per search: ${result.avgChars}`);
  return lines.join('\n');
}
