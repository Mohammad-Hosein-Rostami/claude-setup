// Purpose: turn transcript JSONL lines and doc text into normalised, redacted, chunked records.
// Exports: normalize, redact (from redact.mjs), chunkText, sha1, isHarnessText, stripBashBlocks, createTranscriptParser, extractDoc, REDACTED.
// Invariants: pure (no I/O); a malformed JSONL line is counted in parser.bad and skipped, never thrown;
// redaction runs on the whole text before chunking so a split can never cut a secret in half.
import { createHash } from 'node:crypto';
import { redact, REDACTED } from './redact.mjs';

export const MAX_CHUNK_CHARS = 700; // measured: 700/100 beat 500, 800, 1000 and 1800 on hit@5 (see README)
export const OVERLAP_CHARS = 100;
const HARD_SPLIT_CHARS = MAX_CHUNK_CHARS - OVERLAP_CHARS - 2; // room for the overlap and its \n\n joiner

const HARNESS_PREFIXES = [
  '<task-notification', '<agent-message', '[SYSTEM NOTIFICATION', '<system-reminder>',
  '<local-command', '<command-', '<cross-session-message', 'Caveat:',
];

/** NFKC, Arabic ي/ك to Persian ی/ک, drop ZWNJ and tatweel. Applied to stored text and to queries. */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/\u064A/g, '\u06CC')
    .replace(/\u0643/g, '\u06A9')
    .replace(/[\u200C\u0640]/g, '');
}

export { redact, REDACTED };

/** sha1 hex of the trimmed, normalised text (the per-session dedupe key). */
export function sha1(text) {
  return createHash('sha1').update(normalize(text).trim()).digest('hex');
}

// Commands typed with `!` are logged in these tags and often carry passwords, so such text is never indexed.
const BASH_TAG = /<bash-(?:input|stdout|stderr)>/;
const BASH_BLOCK = /<bash-(input|stdout|stderr)>[\s\S]*?(?:<\/bash-\1>|$)/g;
/** Remove `<bash-input|stdout|stderr>` shell captures (an unclosed one runs to the end), as the indexer does. */
export const stripBashBlocks = (text) => text.replace(BASH_BLOCK, '');

/** True for user text that holds a `!` shell command or its output. */
export const hasBashCapture = (text) => BASH_TAG.test(String(text));

/** True for harness-generated user text that is not a human prompt. */
export function isHarnessText(text) {
  const head = String(text).trimStart();
  return HARNESS_PREFIXES.some((prefix) => head.startsWith(prefix));
}

function hardSplit(paragraph) {
  const parts = [];
  for (let i = 0; i < paragraph.length; i += HARD_SPLIT_CHARS) parts.push(paragraph.slice(i, i + HARD_SPLIT_CHARS));
  return parts;
}

/** Split text over MAX_CHUNK_CHARS on paragraph boundaries; each chunk after the first starts with an OVERLAP_CHARS (100) overlap; chunks are at most MAX_CHUNK_CHARS (700). */
export function chunkText(text) {
  const clean = String(text ?? '').trim();
  if (!clean) return [];
  if (clean.length <= MAX_CHUNK_CHARS) return [clean];
  const pieces = clean.split(/\n{2,}/).flatMap((p) => (p.length > HARD_SPLIT_CHARS ? hardSplit(p) : [p]));
  const chunks = [];
  let current = '';
  let fresh = true; // true while `current` holds only overlap, so a piece is always appended (no empty loop)
  for (const piece of pieces) {
    const joined = current ? `${current}\n\n${piece}` : piece;
    if (joined.length > MAX_CHUNK_CHARS && !fresh) {
      chunks.push(current);
      current = `${current.slice(-OVERLAP_CHARS)}\n\n${piece}`;
    } else current = joined;
    fresh = false;
  }
  if (current) chunks.push(current);
  return chunks;
}

function blockTexts(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
}

function toChunks(text, base) {
  return chunkText(redact(normalize(text))).map((t) => ({ ...base, text: t }));
}

/**
 * Stateful parser for one transcript file.
 * mode 'main': feed() returns chunks for user / assistant / summary lines.
 * mode 'agent': feed() returns [] and finish() returns the brief (first user) and report (last assistant).
 * Counts unreadable lines in `bad`; collects working directories in `cwds`.
 */
export function createTranscriptParser({ mode = 'main', agentType = 'agent' } = {}) {
  const seen = new Set();
  const cwds = new Set();
  const state = { bad: 0, brief: null, report: null };

  function userChunks(entry, line) {
    const texts = blockTexts(entry.message?.content).join('\n\n');
    if (!texts.trim()) return [];
    const base = { line, ts: entry.timestamp ?? null, role: 'user' };
    if (entry.isCompactSummary === true) return toChunks(texts.replace(BASH_BLOCK, ''), { ...base, kind: 'summary' });
    if (isHarnessText(texts) || hasBashCapture(texts) || entry.isMeta === true) return [];
    return toChunks(texts, { ...base, kind: 'user' });
  }

  function assistantChunks(entry, line) {
    const id = entry.message?.id ?? `line${line}`;
    const out = [];
    blockTexts(entry.message?.content).forEach((text, index) => {
      const key = `${id}:${index}:${sha1(text)}`;
      if (!text.trim() || seen.has(key)) return;
      seen.add(key);
      out.push(...toChunks(text, { kind: 'assistant', role: 'assistant', line, ts: entry.timestamp ?? null }));
    });
    return out;
  }

  function feedMain(entry, line) {
    if (entry.type === 'user') return userChunks(entry, line);
    if (entry.type === 'assistant') return assistantChunks(entry, line);
    return [];
  }

  function feedAgent(entry, line) {
    // `!` shell captures can sit inside a brief or report too (they may carry passwords): strip those blocks.
    const text = blockTexts(entry.message?.content).join('\n\n').replace(BASH_BLOCK, '');
    if (entry.type === 'user' && !state.brief) {
      if (text.trim()) state.brief = { text, line, ts: entry.timestamp ?? null };
    } else if (entry.type === 'assistant') {
      if (text.trim()) state.report = { text, line, ts: entry.timestamp ?? null };
    }
    return [];
  }

  return {
    get bad() { return state.bad; },
    cwds,
    feed(rawLine, line) {
      let entry;
      try {
        entry = JSON.parse(rawLine);
      } catch {
        state.bad += 1;
        return [];
      }
      if (!entry || typeof entry !== 'object') {
        state.bad += 1;
        return [];
      }
      if (typeof entry.cwd === 'string') cwds.add(entry.cwd);
      return mode === 'agent' ? feedAgent(entry, line) : feedMain(entry, line);
    },
    finish() {
      const out = [];
      for (const [part, role] of [[state.brief, 'brief'], [state.report, 'report']]) {
        if (part) out.push(...toChunks(part.text, { kind: 'agent', role: `${agentType}:${role}`, line: part.line, ts: part.ts }));
      }
      return out;
    },
  };
}

/** Chunks for a markdown doc. line is 0 and ts is the file mtime (ISO) because docs have no JSONL position. */
export function extractDoc(text, mtimeMs) {
  const ts = new Date(mtimeMs).toISOString();
  return toChunks(text, { kind: 'doc', role: 'doc', line: 0, ts });
}
