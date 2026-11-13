// Stop: blocks once when the lead ends with a list of decisions for the owner instead of asking them.
// Exports: DECISION_PATTERNS (EN_REQUEST_PATTERNS + FA_REQUEST_PATTERNS), HEADING_PATTERN, LABEL_PATTERN, REASON, listsDeferredDecisions(text), lastRealPromptIndex(entries),
// promptText(entry), askedSinceLastPrompt(entries), lastAssistantText(entries), parseTranscript(text), readTranscriptTail(path), decide(input, entries).
// Invariants: stop_hook_active true always allows (never block twice in a row); block only when the matcher hits AND no
// AskUserQuestion call happened since the last real user prompt (tool results, notifications, interrupts and image-only
// turns are not prompts); quoted text (code, `>` lines, "..." and curly quotes) and negated phrases ("no open questions", "decisions needed are none") never match; a request phrase counts only in the last 15 lines, at a sentence start, outside a sentence about the matcher and with an open choice (?, options, colon); any internal error is one stderr line and exit 0, so a
// session is never trapped. Env ASK_GATE_LOG appends one JSON line per run (debug and E2E evidence).
import { appendFileSync, closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024;
const MIN_ITEMS_ALONE = 3;
const MIN_ITEMS_AFTER_DECISION_WORD = 2;
const DECISION_WORD_LOOKBACK_LINES = 3;
const NEGATION_WINDOW_CHARS = 12;
const NEGATION_AFTER_CHARS = 30; // room for "earlier were" in "Decisions needed earlier were answered"
const ASK_TOOL = 'AskUserQuestion';
// Harness and agent envelopes are never the owner's words: a line starting with one is not a prompt, and a whole
// <tag>...</tag> envelope inside a typed prompt is cut out before the text is read.
const NON_PROMPT_PREFIXES = [
  '<task-notification', '<system-', '<agent-message', '<cross-session-message', '[SYSTEM NOTIFICATION', '[Request interrupted',
];
const ENVELOPE_TAGS = /<(system-reminder|agent-message|cross-session-message|task-notification)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/g;
const IMAGE_PLACEHOLDER = /^\s*\[Image[^\]]*\]\s*$/;

// Persian words are joined by a space or a zero-width non-joiner (U+200C).
const FA_SEP = '[\\s\\u200c]';
const TAIL_LINES = 15; // the request is the closing move: only the last non-empty lines can carry it
// An English request phrase must open a sentence or line (optionally bulleted, bold or after "please"): "the hook fires
// on text like needs your call" is a description, not a request.
const SENTENCE_START = '(?<=^|[.!?:;]\\s+)[ \\t>*#_-]*(?:(?:please|kindly|so|and|but|now|also)[ ,]+)?';
const anchored = (pattern) => new RegExp(`${SENTENCE_START}(?:${pattern.source})`, 'im');
// A sentence about the matcher itself (quotes were already stripped) is not a request.
const DESCRIBES_MATCHER = /\b(matcher|patterns?|regex|phrases?|wording|false positives?|ask-gate|fires? on|matches)\b/i;
const OPTION_LINE = /^[ \t]*(?:[-*][ \t]+)?\(?(?:[1-9]|[A-Ea-e])[.):][ \t]/;
const MIN_OPTION_LINES = 2;
// An explicit choice between named alternatives in the request's own sentence: "decide A or B", "X vs Y", "هم یا".
const NAMED_ALTERNATIVES = /\S+\s+(?:or|vs\.?|versus|یا)\s+\S+/i;

/**
 * English request phrases (anchored at a sentence start by listsDeferredDecisions) and Persian ones (matched anywhere in
 * the tail). Every pattern that marks a request for the owner's decision lives in one of these two lists.
 * Deliberately narrow: a false positive costs a wasted turn, so plain "decision", "open questions", "your call" and
 * "decisions for you" only count as a line-start label (LABEL_PATTERN) or a whole-line heading (HEADING_PATTERN).
 */
export const EN_REQUEST_PATTERNS = [
  /(?:(?:this|it|that|these|one thing) )?(needs?|waiting on|awaiting) your (call|decision|input|approval|answer)/i,
  /you (must|need to|have to) decide/i,
  /decisions? (needed|pending|required|to make)\b/i,
  /\bI need you to (decide|choose|pick|confirm)\b/i,
  /let me know which (you prefer|option|one)\b/i,
];
export const FA_REQUEST_PATTERNS = [
  new RegExp(`(نیاز${FA_SEP}+به|منتظر)${FA_SEP}+(تصمیم|تایید|تأیید|نظر)`),
  new RegExp(`تصمیم(ات|ها)?${FA_SEP}*(باز|معلق|لازم|منتظر)`),
  new RegExp(`تصمیم${FA_SEP}*هایی${FA_SEP}+که${FA_SEP}+(باید|لازم)`),
  new RegExp(`سو?ؤ?ال(ات|${FA_SEP}*های)?${FA_SEP}+باز`),
  new RegExp(`باید${FA_SEP}+.{0,20}تصمیم${FA_SEP}+بگیر`),
  new RegExp(`تصمیم${FA_SEP}*(بگیر|بگیرید)`),
  new RegExp(`لطفا.{0,20}(انتخاب${FA_SEP}+کن|تصمیم)`),
];
export const DECISION_PATTERNS = [...EN_REQUEST_PATTERNS, ...FA_REQUEST_PATTERNS];
/** A heading line on its own, e.g. "## Open questions" or "**Your call:**". */
export const HEADING_PATTERN = /^[#>*\-\s]*(open questions|decisions( needed| pending)?|your call)[\s*]*:?[\s*]*$/im;
/** A label at the start of a line, optionally bulleted or bold, with text allowed after the colon: "**Your call:** A or B?". */
export const LABEL_PATTERN =
  /^[ \t]*[#*-]*[ \t]*\**(your call|open questions?|questions? for you|decisions? (needed|pending|required|for you)|things i need from you)[ \t]*\**[ \t]*:/im;
// A match is not a request when a negation stands just before it ("no decisions needed") or just after it
// ("Decisions needed: none", "are none", "were answered", Persian "... ندارم").
const NEGATION_BEFORE = /(^|[^a-z])(no|none|zero|resolved|answered)([^a-z]|$)|ندارم|نیست/i;
const NEGATION_AFTER = new RegExp(
  `^[\\s:*\\-]*((are|is|were|was)\\s+)?(none|nothing)\\b|^[^.\\n]{0,${NEGATION_AFTER_CHARS}}?\\b(answered|resolved)\\b|^[^.\\n]{0,${NEGATION_WINDOW_CHARS}}?(ندارم|ندارد|نداریم|نیست)`,
  'i',
);
// A "D12:" item at the start of a line (optionally bulleted or bold), and the words that make a short list a decision list.
const DECISION_ITEM = /^[ \t]*(?:[-*][ \t]+)?(?:\*\*)?D\d+(?:\*\*)?[ \t]*:/;
const DECISION_WORD = /decision|decide|تصمیم/i;

export const REASON =
  'You ended with decisions for the owner but did not ask them. Ask now with AskUserQuestion (max 4 per call; plain words, ' +
  'one decision per question, each option says what happens; recommended option first). Keep background work running. ' +
  'If the owner already answered them, say so with the answers instead of listing them as open.';

// Fenced code, inline code, quoted lines and "..." or curly-quoted text are someone else's words: they never count.
const CURLY_QUOTED = new RegExp('\\u201c[^\\u201d\\n]*\\u201d', 'g');
const stripQuoted = (text) =>
  text
    .replace(/```[\s\S]*?(```|$)/g, '\n')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^[ \t]*>.*$/gm, '')
    .replace(/"[^"\n]*"/g, ' ')
    .replace(CURLY_QUOTED, ' ');

// Does `pattern` match somewhere, without a negation next to the match, for a match that `accept(match)` also takes?
function hasRequest(text, pattern, accept = () => true) {
  const global = new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g');
  return [...text.matchAll(global)].some((m) => {
    const before = text.slice(Math.max(0, m.index - NEGATION_WINDOW_CHARS), m.index).split(/[\n.!?]/).pop(); // this sentence only
    const after = text.slice(m.index + m[0].length);
    return !NEGATION_BEFORE.test(before) && !NEGATION_AFTER.test(after) && accept(m);
  });
}

// A request needs an open choice in the tail: a question mark, an option list, or a colon right after the phrase.
const hasOpenChoice = (tail) => /[?؟]/.test(tail) || tail.split('\n').filter((l) => OPTION_LINE.test(l)).length >= MIN_OPTION_LINES;

// Accept a phrase match inside `tail` only when its sentence is not about the matcher and the tail offers a choice.
function isOpenRequest(tail, m) {
  const sentence = tail.slice(0, m.index).split(/[.!?\n]/).pop() + m[0] + tail.slice(m.index + m[0].length).split(/[.!?\n]/)[0];
  if (DESCRIBES_MATCHER.test(sentence)) return false;
  const rest = tail.slice(m.index + m[0].length);
  return hasOpenChoice(tail) || /^[\s*]*:/.test(rest) || NAMED_ALTERNATIVES.test(rest.split(/[.!?\n]/)[0]);
}

// 3+ "D<n>:" items, or 2+ when a decision word stands in the 3 lines before the first one.
function hasDecisionItems(text) {
  const lines = text.split('\n');
  const items = lines.flatMap((line, i) => (DECISION_ITEM.test(line) ? [i] : []));
  if (items.length >= MIN_ITEMS_ALONE) return true;
  if (items.length < MIN_ITEMS_AFTER_DECISION_WORD) return false;
  return lines.slice(Math.max(0, items[0] - DECISION_WORD_LOOKBACK_LINES), items[0]).some((l) => DECISION_WORD.test(l));
}

/**
 * Does the text hand decisions to the owner? A request phrase counts only in the last TAIL_LINES lines, at a sentence
 * start, outside a sentence about the matcher, and with an open choice (?, options, a colon, or named alternatives "A or B"); a heading, label or D-list
 * counts anywhere.
 * @param {string} text the assistant's last message
 * @returns {boolean} false for non-strings, negated phrases ("no open questions") and quoted or code text
 */
export function listsDeferredDecisions(text) {
  if (typeof text !== 'string' || !text) return false;
  const plain = stripQuoted(text);
  const tail = plain.split('\n').filter((line) => line.trim()).slice(-TAIL_LINES).join('\n');
  const phrases = [...EN_REQUEST_PATTERNS.map(anchored), ...FA_REQUEST_PATTERNS];
  if (phrases.some((p) => hasRequest(tail, p, (m) => isOpenRequest(tail, m)))) return true;
  return hasRequest(plain, HEADING_PATTERN) || hasRequest(plain, LABEL_PATTERN) || hasDecisionItems(plain);
}

/**
 * Parse transcript JSONL; lines that are not JSON objects are skipped.
 * @param {string} text transcript file text
 * @returns {object[]}
 */
export function parseTranscript(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object') entries.push(entry);
    } catch {
      // partial or corrupt line (e.g. the cut at the start of a tail read): not evidence either way
    }
  }
  return entries;
}

/**
 * Last `max` bytes of a file, cut at a line start.
 * @param {string} path transcript file
 * @param {number} [max] byte cap
 * @returns {string}
 */
export function readTranscriptTail(path, max = MAX_TRANSCRIPT_BYTES) {
  const size = statSync(path).size;
  const start = Math.max(0, size - max);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString('utf8');
  return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
}

const blocksOf = (entry) => (Array.isArray(entry?.message?.content) ? entry.message.content : []);

/**
 * The text of a user entry when it is a real prompt typed by the owner, else null (tool results, task notifications,
 * agent and cross-session messages, system reminders, meta and sub-agent lines are not prompts). Envelopes inside a
 * typed prompt are removed, so only the owner's own text is returned.
 */
export function promptText(entry) {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain) return null;
  const content = entry.message?.content;
  let text = null;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content) && !content.some((b) => b?.type === 'tool_result')) {
    const texts = content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text);
    text = texts.filter((t) => !IMAGE_PLACEHOLDER.test(t)).join('\n') || null; // an image-only prompt has no text
  }
  if (text === null) return null;
  const typed = text.replace(ENVELOPE_TAGS, '');
  const head = typed.trimStart();
  return !head || NON_PROMPT_PREFIXES.some((p) => head.startsWith(p)) ? null : typed;
}

/**
 * Index of the last real user prompt.
 * @param {object[]} entries parsed transcript
 * @returns {number} -1 when none
 */
export function lastRealPromptIndex(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) if (promptText(entries[i]) !== null) return i;
  return -1;
}

/**
 * Was AskUserQuestion called after the last real user prompt?
 * @param {object[]} entries parsed transcript
 * @returns {boolean}
 */
export function askedSinceLastPrompt(entries) {
  return entries
    .slice(lastRealPromptIndex(entries) + 1)
    .some((e) => e.type === 'assistant' && blocksOf(e).some((b) => b?.type === 'tool_use' && b.name === ASK_TOOL));
}

/**
 * Text of the last assistant message that has any.
 * @param {object[]} entries parsed transcript
 * @returns {string} empty when there is none
 */
export function lastAssistantText(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].type !== 'assistant') continue;
    const text = blocksOf(entries[i]).filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
    if (text.trim()) return text;
  }
  return '';
}

/**
 * The gate decision.
 * @param {{stop_hook_active?: boolean, last_assistant_message?: string}} input Stop hook JSON
 * @param {object[]} entries parsed transcript (may be empty)
 * @returns {{block: boolean, matched: boolean, asked: boolean}}
 */
export function decide(input, entries) {
  if (input?.stop_hook_active === true) return { block: false, matched: false, asked: false };
  const message = typeof input?.last_assistant_message === 'string' && input.last_assistant_message
    ? input.last_assistant_message
    : lastAssistantText(entries);
  const matched = listsDeferredDecisions(message);
  const asked = askedSinceLastPrompt(entries);
  return { block: matched && !asked, matched, asked };
}

function debugLog(record) {
  const path = process.env.ASK_GATE_LOG;
  if (path) appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const input = JSON.parse(await readStdin());
  let entries = [];
  if (typeof input?.transcript_path === 'string' && input.transcript_path) {
    try {
      entries = parseTranscript(readTranscriptTail(input.transcript_path));
    } catch (err) {
      process.stderr.write(`ask-gate: transcript unreadable (${err.message}); using the message only\n`);
    }
  }
  const result = decide(input, entries);
  debugLog({
    stop_hook_active: input?.stop_hook_active === true,
    has_last_assistant_message: typeof input?.last_assistant_message === 'string' && input.last_assistant_message.length > 0,
    ...result,
  });
  if (result.block) process.stdout.write(`${JSON.stringify({ decision: 'block', reason: REASON })}\n`);
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch (err) {
    process.stderr.write(`ask-gate: ${err.message}\n`); // never trap a session
  }
}
