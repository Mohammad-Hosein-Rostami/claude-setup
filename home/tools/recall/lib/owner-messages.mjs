// Purpose: `recall --owner`: list what the owner typed in one session, oldest first, one masked line each, so a
// Standing rules backfill uses the owner's own words and not a compaction retelling.
// Exports: ownerMessages (async generator), findSession, maskForOwnerList, OWNER_TEXT_CHARS.
// Invariants: reads the transcript line by line (never the whole file) and writes nothing; a message is masked with
// redact() plus the chat-style credential mask BEFORE it is cut, so a cut can never leave half a secret; when in
// doubt a word is masked. Harness text is told apart with extract.mjs's isHarnessText/hasBashCapture, as the indexer does.
import { createReadStream, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { hasBashCapture, isHarnessText, redact } from './extract.mjs';

export const OWNER_TEXT_CHARS = 300;
const MASKED = '[masked]';
const COMPACTION_OPENING = 'This session is being continued from a previous conversation';
// Chat-style credentials: a label, then `:` or `=`, then the value and a second part when "a / b" or "a and b" follows.
const CREDENTIAL_LABEL = /(?<![\p{L}\d])(?:user(?:name)?\s*[/&+,]\s*pass(?:word|wd)?|creds?|credentials?|logins?|passcode)\s*[:=]\s*\S+(?:\s+(?:[/&,]|and)\s+\S+)?/giu;
// A token-shaped word: 24 or more letters, digits, _ or - with at least one of each kind (a hash, a key, a random id).
const TOKEN_SHAPED = /(?<![\w-])(?=[\w-]{24,}(?![\w-]))(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]+/g;

/** The text with secrets removed: redact(), then chat-style credential labels and token-shaped words. */
export function maskForOwnerList(text) {
  return redact(text).replace(CREDENTIAL_LABEL, MASKED).replace(TOKEN_SHAPED, MASKED);
}

/**
 * The transcript file of a session: `<root>/<project>/<id>*.jsonl` (an id may be given by its leading characters).
 * @returns {string} the path.
 * @throws {Error} when no session, or more than one, starts with the id.
 */
export function findSession(root, id) {
  const matches = [];
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    for (const name of readdirSync(join(root, project.name))) {
      if (name.endsWith('.jsonl') && name.startsWith(id)) matches.push(join(root, project.name, name));
    }
  }
  if (matches.length === 0) throw new Error(`no session starts with ${id}`);
  if (matches.length > 1) throw new Error(`${matches.length} sessions start with ${id}; give more characters`);
  return matches[0];
}

/** What the owner typed in a user record: its text blocks minus harness blocks and `!` shell captures; '' for tool results and summaries. */
function typedText(entry) {
  if (entry.type !== 'user' || entry.isMeta === true || entry.isCompactSummary === true || entry.isSidechain === true) return '';
  const content = entry.message?.content;
  const blocks = typeof content === 'string' ? [content]
    : Array.isArray(content) ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text) : [];
  return blocks
    .filter((text) => !isHarnessText(text) && !hasBashCapture(text) && !text.trimStart().startsWith(COMPACTION_OPENING))
    .join('\n');
}

/**
 * Owner messages of one transcript, oldest first.
 * @param {string} file transcript path.
 * @param {{since?: string}} [filter] since: YYYY-MM-DD; a message without a time is left out when it is set.
 * @yields {{index: number, time: string, text: string}} text is masked, on one line, at most OWNER_TEXT_CHARS long.
 */
export async function* ownerMessages(file, { since } = {}) {
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let index = 0;
  for await (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a half-written last line
    }
    const raw = entry && typeof entry === 'object' ? typedText(entry) : '';
    if (!raw.trim()) continue;
    index += 1; // counted before --since, so a message keeps its number
    const time = typeof entry.timestamp === 'string' ? entry.timestamp : '';
    if (since && (!time || time.slice(0, 10) < since)) continue;
    yield { index, time, text: maskForOwnerList(raw).replace(/\s+/g, ' ').trim().slice(0, OWNER_TEXT_CHARS) };
  }
}
