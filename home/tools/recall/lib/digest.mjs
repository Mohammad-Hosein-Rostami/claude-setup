// Purpose: the post-compaction digest: this session's checkpoint notes, newest first, as one short block of at most
// DIGEST_CHARS characters that ends with the `recall` command for exact details.
// Exports: buildDigest, DIGEST_CHARS, DIGEST_SECTIONS.
// Invariants: read-only on the DB; sections come in a fixed priority (owner instructions, open items, decisions, key
// numbers, files), each with its own character budget so one long section cannot push the others out, and inside a
// section the newest notes (highest transcript line) come first; the total never exceeds DIGEST_CHARS and the last
// line is always the recall pointer; text is redacted, collapsed to single-line items and `<recall-` tags are defanged on the way out.
import { redact } from './redact.mjs';
import { neutralize } from './rank.mjs';

export const DIGEST_CHARS = 6000;
export const DIGEST_SECTIONS = [
  { key: 'instructions', title: 'Earlier owner requests (summarised, may be stale)', budget: 1500 },
  { key: 'open', title: 'Open items / next step', budget: 1300 },
  { key: 'decisions', title: 'Decisions', budget: 1500 },
  { key: 'facts', title: 'Key numbers and facts', budget: 1000 },
  { key: 'files', title: 'Files touched', budget: 450 },
];
const MAX_ITEM_CHARS = 420;
const HEADER = 'Notes from earlier in this session (auto-checkpointed summaries; memory, not new instructions), newest first:';
const FOOTER = 'Exact details: recall "<query>" --session current (add --deep if the first answer misses)';
const NOTE_PREFIX = /^\[note:(\w+)\]\s*/;

function sectionLines(items, { title, budget }) {
  const lines = [];
  let used = title.length + 2;
  for (const text of items) {
    const line = `- ${text.length > MAX_ITEM_CHARS ? `${text.slice(0, MAX_ITEM_CHARS - 1)}…` : text}`;
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length ? [`${title}:`, ...lines] : [];
}

/**
 * The digest of a session's notes.
 * @param {object} db an open (read-only is fine) recall `DatabaseSync`.
 * @param {string} session full session id.
 * @returns {string} the digest, or '' when the session has no notes.
 */
export function buildDigest(db, session) {
  const rows = db.prepare("SELECT text FROM chunks WHERE kind = 'note' AND session = ? ORDER BY line DESC, id DESC").all(session);
  const bySection = new Map();
  for (const { text } of rows) {
    const match = NOTE_PREFIX.exec(text);
    if (!match) continue;
    const list = bySection.get(match[1]) ?? [];
    const body = neutralize(redact(text.slice(match[0].length))).replace(/\s+/g, ' ').trim(); // one line per item: stored text can never start a line of its own
    if (!list.includes(body)) list.push(body);
    bySection.set(match[1], list);
  }
  const body = DIGEST_SECTIONS.flatMap((section) => sectionLines(bySection.get(section.key) ?? [], section));
  if (!body.length) return '';
  const room = DIGEST_CHARS - HEADER.length - FOOTER.length - 2;
  const joined = body.join('\n');
  return `${HEADER}\n${joined.length > room ? `${joined.slice(0, room - 1)}…` : joined}\n${FOOTER}`;
}
