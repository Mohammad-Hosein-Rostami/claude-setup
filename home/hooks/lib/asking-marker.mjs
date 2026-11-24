// The asking marker: while a question or permission prompt waits for the owner, a small file says so, so the board and the status
// line can lead with "needs you" (spec-p5 `r9-ask`, R03; display design 7.10 and 7.11).
// Exports: askingDir(env), markAsking(entry, env) -> boolean, clearAsking(session, env, kind?) -> boolean, readAsking(session, env, now?) -> marker | null,
// markerExpiresAt(openedAt, waitS, count) -> epoch ms, cleanHeader(value) -> string, STALE_MARGIN_S, MAX_HEADER_CHARS, UNSAFE_TEXT.
// File: ~/.claude/state/asking/<session>.json = { session, kind: 'question'|'permission', tool, count, openedAt, expiresAt, header } (epoch ms;
// `header` is the first question's short label, '' when there is none; a marker written before it existed has no `header` and reads as '').
// Cleared when the question popups answered every question (question-reply.mjs), when a permission dialog ends, and by age (an
// answer typed in the terminal fires no hook of ours since the PostToolUse hook was removed): a manual deny of a permission prompt fires no hook event outside auto mode (ALIGN-1 A121), so a marker
// past expiresAt (the question's wait plus STALE_MARGIN_S) reads as none. Probe P5-12 (owed) confirms which events close a prompt.
// Invariants: no session id, no file; written and read through session-store.mjs (no links, 0600, temp file and rename); holds no
// question text, only the short header label, which is untrusted too: the writer and readAsking both pass it through cleanHeader (control, format and
// line-separator characters and `;` dropped, MAX_HEADER_CHARS), so the status line, notify and board each get the same capped text; nothing here throws.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isSessionId, readSessionFile, writeSessionFile } from './session-store.mjs';

/** A marker is stale this long after the planned end of its wait (spec-p5 `r9-ask`: the question's wait plus 60 s). */
export const STALE_MARGIN_S = 60;
const MAX_MARKER_BYTES = 1024;
const MS_PER_S = 1000;
const KINDS = ['question', 'permission'];
/** The longest header kept: AskUserQuestion's header is a short label (12 characters in Claude Code's own form); one cap for the writer and every reader. */
export const MAX_HEADER_CHARS = 24;
/**
 * Characters no note text may carry: control characters, line and paragraph separators (U+2028/2029), and format characters (the bidi
 * overrides, isolates and marks that reorder text, zero-width and tag characters), except ZWNJ and ZWJ, which Persian words and emoji
 * need and which move nothing. One rule for every note text (notify-note.mjs) and the header.
 */
export const UNSAFE_TEXT = /[\p{Cc}\p{Zl}\p{Zp}]|(?![\u200c\u200d])\p{Cf}/gu;
const HEADER_SEPARATOR = /;/g; // the Ghostty note is `777;notify;<title>;<body>`: a `;` in the header would read as a field break

/** @returns {string} `value` as a header: unsafe characters (UNSAFE_TEXT) and `;` dropped, trimmed, cut at MAX_HEADER_CHARS (whole characters); '' when it is not a string */
export const cleanHeader = (value) => (typeof value === 'string' ? [...value.replace(UNSAFE_TEXT, '').replace(HEADER_SEPARATOR, '').trim()].slice(0, MAX_HEADER_CHARS).join('') : '');

/** @returns {string} the folder of the asking markers (HOME from env, so tests run under a temp home) */
export const askingDir = (env = process.env) => join(env.HOME || homedir(), '.claude', 'state', 'asking');

/** @returns {number} when a marker for `count` popups of `waitS` seconds each, opened at openedAt, is stale */
export const markerExpiresAt = (openedAt, waitS, count) => openedAt + (waitS * Math.max(1, count) + STALE_MARGIN_S) * MS_PER_S;

/**
 * @param {{ session: string, kind: 'question'|'permission', tool: string, count: number, openedAt: number, waitS: number, header?: string }} entry
 *   `header` is the first question's short label (optional)
 * @param {Record<string, string | undefined>} [env] process environment (HOME)
 * @returns {boolean} true when the marker was stored
 */
export function markAsking({ session, kind, tool, count, openedAt, waitS, header }, env = process.env) {
  if (!isSessionId(session) || !KINDS.includes(kind)) return false;
  const marker = { session, kind, tool: String(tool).slice(0, 64), count, openedAt, expiresAt: markerExpiresAt(openedAt, waitS, count), header: cleanHeader(header) };
  return writeSessionFile(askingDir(env), session, JSON.stringify(marker));
}

/**
 * @param {unknown} session the session id
 * @param {Record<string, string | undefined>} [env] process environment (HOME)
 * @param {number} [now] epoch ms (tests)
 * @returns {{ session: string, kind: string, tool: string, count: number, openedAt: number, expiresAt: number, header: string } | null} the
 *   open marker (`header` is '' for a marker written without one); null when none, unusable or past its age
 */
export function readAsking(session, env = process.env, now = Date.now()) {
  try {
    const text = readSessionFile(askingDir(env), session, MAX_MARKER_BYTES);
    if (typeof text !== 'string') return null;
    const marker = JSON.parse(text);
    const valid = marker?.session === session && KINDS.includes(marker.kind) && Number.isFinite(marker.openedAt) && Number.isFinite(marker.expiresAt);
    return valid && now <= marker.expiresAt ? { ...marker, header: cleanHeader(marker.header) } : null;
  } catch {
    return null; // a half-written file reads as no marker
  }
}

/**
 * Clears the session's marker (an empty marker replaces it: the store has no delete, and an empty file reads as none). With `kind`,
 * only a marker of that kind is cleared, so a closing permission dialog never clears an open question.
 * @returns {boolean} true when a marker was cleared
 */
export function clearAsking(session, env = process.env, kind = undefined) {
  if (!isSessionId(session)) return false;
  const open = readAsking(session, env, Number.NEGATIVE_INFINITY);
  if (open === null || (kind !== undefined && open.kind !== kind)) return false;
  return writeSessionFile(askingDir(env), session, '{}');
}
