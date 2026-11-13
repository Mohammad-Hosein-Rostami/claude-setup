// Purpose: the checkpoint job: summarise the new slice of a session transcript with Haiku into structured notes, store
// them in the recall DB as chunks of kind `note` (linked to the session id and the transcript line range), embed them
// with every default embedder, and move the session's checkpoint offset forward.
// Exports: runCheckpoint, runJob, MAX_SLICE_BYTES.
// Invariants: the model only ever sees redacted text; a reply that is not valid notes JSON is retried once, then a
// `[note:pointer]` chunk records the unsummarised line range (the raw transcript chunks stay searchable; pointers are
// stored only when the offset advances, so a retry never leaves stale ones behind); `instructions` items are kept only when they quote what the
// owner typed (not a pasted or quoted block) in the cited user message; notes are
// stored with source `note:<session>` so re-indexing a transcript never deletes them; when every window failed the
// offset is NOT advanced and the error is saved (the hook backs off), otherwise it advances and failures are a `warn`;
// embedding failures never lose notes (they stay lexically searchable and `recall embed` fills the vectors later);
// the caller holds the session lock; `runJob` owns it from there on: it runs again for a PreCompact that arrived while it
// was busy and releases the lock only when no request is left.
import { statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { callHaiku } from './claude-call.mjs';
import { acquireLock, hasPending, readCheckpoint, releaseLock, takePending, writeCheckpoint } from './checkpoint-state.mjs';
import { redact } from './extract.mjs';
import { stackModels } from './models.mjs';
import { SUMMARY_SYSTEM, keepInstruction, parseNotes, windowsOf } from './notes.mjs';
import { readSlice } from './slice.mjs';
import { openStore, defaultDbPath } from './store.mjs';
import { embedTexts, ollamaReason } from './vectors.mjs';

export const MAX_SLICE_BYTES = 600000; // a first checkpoint of a huge existing session summarises only its newest part (the rest is `recall backfill`)
const EMBED_BATCH = 32;
const RETRY_NOTE = '\n\n(Your previous reply was not valid JSON in the requested shape. Reply with ONLY the JSON object.)';

async function summarizeWindow(window, { session, env, summarize }) {
  let reason = 'no reply';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const reply = await summarize({ system: SUMMARY_SYSTEM, prompt: attempt ? window.text + RETRY_NOTE : window.text, session, attempt, env });
      const items = parseNotes(reply.text);
      if (items) return { items };
      reason = 'reply was not valid notes JSON';
    } catch (error) {
      reason = error.message;
    }
  }
  return { reason };
}

const nearestLine = (lines, wanted, fallback) => (Number.isFinite(wanted) && lines.length ? lines.reduce((best, l) => (Math.abs(l - wanted) < Math.abs(best - wanted) ? l : best), lines[0]) : fallback);

function noteChunks(window, outcome, base) {
  const lines = Object.keys(window.ts).map(Number);
  const range = `L${window.from}-${window.to}`;
  const make = (line, text) => ({ ...base, kind: 'note', line, ts: window.ts[line] ?? window.ts[window.from] ?? null, role: range, text: redact(text) });
  if (!outcome.items) return [make(window.from, `[note:pointer] transcript lines ${window.from}-${window.to} were not summarised (${outcome.reason}); search the session's raw messages.`)];
  // `instructions` is the owner's voice: keep one only when it is a quote of what the owner typed in a cited user message.
  const kept = outcome.items.filter((item) => item.section !== 'instructions' || keepInstruction(window, item));
  return kept.map((item) => {
    const line = lines.includes(item.l) ? item.l : nearestLine(lines, item.l, window.from);
    return make(line, `[note:${item.section}@${window.roles[line]}] ${item.t}`); // @U/@A/@S: who said it, shown by the digest
  });
}

async function embedNotes(store, source, env) {
  const unembedded = store.db.prepare('SELECT c.id, c.text FROM chunks c WHERE c.source = ? AND NOT EXISTS (SELECT 1 FROM vecs v WHERE v.chunk_id = c.id AND v.model = ?)');
  for (const model of stackModels(env)) {
    const rows = unembedded.all(source, model);
    for (let i = 0; i < rows.length; i += EMBED_BATCH) {
      const batch = rows.slice(i, i + EMBED_BATCH);
      const vectors = await embedTexts(model, batch.map((r) => r.text));
      store.putVectors(model, batch.map((r, j) => ({ id: r.id, vec: vectors[j] })));
    }
  }
}

/**
 * Summarise the unsummarised tail of one session transcript and store the notes.
 * @param {{session: string, transcript: string, reason?: string, env?: object, maxBytes?: number, summarize?: Function}} job
 *   `summarize` replaces the Haiku call (tests); `maxBytes` caps how much of the tail is read (Infinity for backfill).
 * @returns {Promise<{notes: number, windows: number, failed: number, embedError: string | null, lines: number[] | null}>}
 * @throws after saving the error in the session's state when every window failed or the store cannot be written.
 */
export async function runCheckpoint({ session, transcript, reason = 'growth', env = process.env, maxBytes = MAX_SLICE_BYTES, summarize = callHaiku }) {
  const previous = readCheckpoint(session, env) ?? { session, transcript, offset: 0, notes: 0 };
  const size = statSync(transcript).size;
  const { messages, endOffset, startLine, endLine } = readSlice(transcript, Math.max(previous.offset, size - maxBytes), size);
  const windows = windowsOf(messages);
  const base = { project: basename(dirname(transcript)), session, source: `note:${session}` };
  const outcomes = [];
  for (const window of windows) outcomes.push(await summarizeWindow(window, { session, env, summarize })); // sequential: one Haiku call at a time
  const failed = outcomes.filter((o) => !o.items).length;
  const allFailed = windows.length > 0 && failed === windows.length;
  const store = openStore(defaultDbPath(env));
  let stored = 0;
  let embedError = null;
  try {
    store.transaction(() => {
      if (!allFailed) windows.forEach((w, i) => { for (const chunk of noteChunks(w, outcomes[i], base)) if (store.addChunk(chunk)) stored += 1; });
    });
    try { await embedNotes(store, base.source, env); } catch (error) { embedError = ollamaReason(error, 'embedder'); }
  } finally {
    store.close();
  }
  const ts = new Date().toISOString();
  if (allFailed) {
    writeCheckpoint(session, { ...previous, transcript, error: { ts, message: outcomes[0].reason } }, env);
    throw new Error(`checkpoint failed: ${outcomes[0].reason}`);
  }
  const warn = [failed ? `${failed} of ${windows.length} windows not summarised` : '', embedError ? `notes not embedded (${embedError})` : ''].filter(Boolean).join('; ') || null;
  writeCheckpoint(session, { session, transcript, offset: endOffset, ts, notes: (previous.notes ?? 0) + stored, lines: [startLine, endLine], reason, error: null, warn }, env);
  return { notes: stored, windows: windows.length, failed, embedError, lines: [startLine, endLine] };
}

/**
 * The whole detached job: run a checkpoint, run once more while a PreCompact left a pending flag (its tail would
 * otherwise never be summarised), then release the lock. The flag is checked before the release and again after it, so a
 * request written at any moment is either seen here or (the hook retries the lock itself) starts a new job.
 * @param {{session: string, transcript: string, reason?: string, env?: object, run?: Function}} job `run` replaces `runCheckpoint` (tests).
 * @throws the first checkpoint error (pending requests are dropped then: a broken `claude` would only fail again).
 */
export async function runJob({ session, transcript, reason = 'growth', env = process.env, run = runCheckpoint }) {
  let why = reason;
  try {
    do {
      await run({ session, transcript, reason: why, env });
      why = 'PreCompact';
    } while (takePending(session, env));
  } catch (error) {
    takePending(session, env);
    throw error;
  } finally {
    releaseLock(session, env);
  }
  const setPid = hasPending(session, env) ? acquireLock(session, env) : null;
  if (!setPid) return;
  setPid(process.pid);
  takePending(session, env);
  await runJob({ session, transcript, reason: 'PreCompact', env, run });
}
