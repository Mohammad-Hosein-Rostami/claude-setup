// Reply-size caps named in a prompt ("report <= 250 words", "reply in 20 lines", "حداکثر ۳۰۰ کلمه") and the size of a reply.
// Exports: parseCap(prompt), measure(text, unit), overCap(text, cap), reportBody(text).
// Invariants: pure, no I/O. An agent report's cap counts its body only (reportBody): the Constraints, Not run and Caveats
// sections CLAUDE.md says are never trimmed are left out, but only when they come last and no heading of another name at
// their level or above follows (labels inside them never count). A number is a cap only when it is tied to the reply itself: a reply noun (reply, report,
// answer, summary, response, status, digest, return) followed by at most a few filler words and then the amount, or an
// amount that qualifies such a noun ("25-line reply"). Rule quotes ("C4 files <=300 lines") and per-file or per-function
// limits never match. Persian: "حداکثر N کلمه|خط" counts unless the sentence is about a file, function or code; Persian
// and Arabic-Indic digits are read. Lines count non-empty lines, words count whitespace-separated tokens.

const MAX_CAP_DIGITS = 4;
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const NOUN = '(?:repl(?:y|ies)|reports?|answers?|summary|summaries|responses?|status|digest|final message|return(?:s)?)';
// Words that may sit between the noun and the amount; anything else ("files", "functions") breaks the tie.
const FILLER = '(?:\\s+(?:in|of|at|to|is|are|has|have|with|a|an|the|must|be|should|stay|keep|within|under|max|maximum|limit|cap|capped))*';
const PREFIX = '(?:≤|<=|=<|max(?:imum)?(?: of)?|at most|under|below|up to|no more than|not more than|within)?';
const AMOUNT = `(\\d{1,${MAX_CAP_DIGITS}})\\s*(words?|lines?)\\b`;
const AFTER_NOUN = new RegExp(`\\b${NOUN}${FILLER}\\s*[:=]?\\s*${PREFIX}\\s*:?\\s*${AMOUNT}`, 'i');
const QUALIFYING_AMOUNT = new RegExp(`(\\d{1,${MAX_CAP_DIGITS}})[- ](words?|lines?)\\s+${NOUN}\\b`, 'i');
const CAP_THEN_NOUN = new RegExp(`${NOUN}${FILLER}\\s+(\\d{1,${MAX_CAP_DIGITS}})[- ](words?|lines?)\\s+(?:cap|limit|max(?:imum)?)\\b`, 'i');
const PERSIAN_CAP = new RegExp(`(?:حداکثر|حد\\u200cاکثر|نهایتا|نهایتاً)\\s*(\\d{1,${MAX_CAP_DIGITS}})\\s*(کلمه|واژه|لغت|خط|سطر)`);
const PERSIAN_NOUN_CAP = new RegExp(`(?:گزارش|پاسخ|جواب|خلاصه|وضعیت)[^.\\n\\d]{0,14}(\\d{1,${MAX_CAP_DIGITS}})\\s*(کلمه|واژه|لغت|خط|سطر)`);
const PERSIAN_NOT_A_REPLY = /فایل|تابع|ماژول|کد\b|کلاس/;
const SENTENCE_END = /[.!?\n]/;

const toAsciiDigits = (text) =>
  text.replace(/[۰-۹٠-٩]/g, (d) => String(PERSIAN_DIGITS.includes(d) ? PERSIAN_DIGITS.indexOf(d) : ARABIC_INDIC_DIGITS.indexOf(d)));
const unitOf = (word) => (/^(w|ک|و|ل)/i.test(word) ? 'words' : 'lines');

function capInSentence(sentence) {
  for (const form of [AFTER_NOUN, CAP_THEN_NOUN, QUALIFYING_AMOUNT]) {
    const m = form.exec(sentence);
    if (m) return { amount: m[1], unit: m[2] };
  }
  if (PERSIAN_NOT_A_REPLY.test(sentence)) return null;
  const fa = PERSIAN_CAP.exec(sentence) ?? PERSIAN_NOUN_CAP.exec(sentence);
  return fa ? { amount: fa[1], unit: fa[2] } : null;
}

/**
 * The first reply-size cap a prompt names.
 * @param {unknown} prompt prompt text
 * @returns {{limit: number, unit: 'words' | 'lines'} | null} null when no cap tied to the reply is found
 */
export function parseCap(prompt) {
  if (typeof prompt !== 'string') return null;
  for (const sentence of toAsciiDigits(prompt).split(SENTENCE_END)) {
    const found = capInSentence(sentence);
    const limit = found ? Number(found.amount) : 0;
    if (limit > 0) return { limit, unit: unitOf(found.unit) };
  }
  return null;
}

/**
 * Size of a reply in the cap's unit.
 * @param {string} text reply text
 * @param {'words' | 'lines'} unit
 * @returns {number}
 */
export function measure(text, unit) {
  if (typeof text !== 'string') return 0;
  return unit === 'lines' ? text.split('\n').filter((line) => line.trim()).length : text.split(/\s+/).filter(Boolean).length;
}

/**
 * Is the reply longer than the cap?
 * @param {string} text reply text
 * @param {{limit: number, unit: 'words' | 'lines'}} cap
 * @returns {{over: boolean, size: number}}
 */
export function overCap(text, cap) {
  const size = measure(text, cap.unit);
  return { over: size > cap.limit, size };
}

// The three sections every agent report carries (home/CLAUDE.md "Agents (workers)", Report): never trimmed, so never counted.
const REQUIRED_NAME = /^(?:constraints|not run|caveats)\b/i;
// "decisions needed" is a report part the briefs ask for too: a heading of that name never ends the sections, nor starts them.
const ALLOWED_NAME = /^decisions needed\b/i;
const ATX_HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/; // "## Caveats"; the level is the number of #
const BOLD_HEADING = /^\s*\*\*([^*\n]+)\*\*\s*:?\s*(.*)$/; // "**Not run**", "**Caveats:** none"; group 2 is the text after it
const PLAIN_NAME_ALONE = /^\s*(?:constraints|not run|caveats)\s*$/i; // "Caveats" on its own line
// "Constraints: none", "Not run (why):"; the label is at most 3 words, so a sentence ending in ':' is no heading.
const PLAIN_LABEL = /^\s*([A-Za-z][A-Za-z-]*(?: [A-Za-z-]+){0,2})\s*(?:\([^)\n]*\))?\s*:/;
const FENCE = /^\s{0,3}(?:```|~~~)/; // a "# comment" inside a code block is no heading
// Heading levels below every ATX level (1-6): a bold line, then a plain label. A smaller number is a higher heading.
const BOLD_LEVEL = 7;
const PLAIN_LEVEL = 8;
const REQUIRED = 'required';
const ALLOWED = 'allowed';
const OTHER = 'other';

const kindOfTitle = (title) => {
  const name = title.replace(/[*_]/g, '').trim();
  if (REQUIRED_NAME.test(name)) return REQUIRED;
  return ALLOWED_NAME.test(name) ? ALLOWED : OTHER;
};

/**
 * A line as a heading: its kind (REQUIRED: one of the three names, ALLOWED: decisions needed, OTHER: any other name) and its
 * level, or null. A plain label of another name ("Tests:", "decisions needed:") and a bold label with text after it
 * ("**Unproven:** x") are lines of the section they sit in, never a heading.
 */
function headingOf(line) {
  const atx = ATX_HEADING.exec(line);
  if (atx) return { kind: kindOfTitle(atx[2]), level: atx[1].length };
  const bold = BOLD_HEADING.exec(line);
  if (bold) {
    const kind = kindOfTitle(bold[1]);
    return kind !== OTHER || bold[2] === '' ? { kind, level: BOLD_LEVEL } : null;
  }
  const label = PLAIN_LABEL.exec(line)?.[1] ?? '';
  return PLAIN_NAME_ALONE.test(line) || REQUIRED_NAME.test(label) ? { kind: REQUIRED, level: PLAIN_LEVEL } : null;
}

/**
 * The part of an agent report that its size cap counts. The three required sections are exempt so that agents never trim them
 * to fit the cap. They start at the first heading named Constraints, Not run or Caveats (any order, as `## Name`, `**Name**`
 * or `Name:`); inside them any formatting is free, but a heading of another name at the level of that first heading or above
 * (a `##` beside `## Caveats`, any `#` heading or bold line of its own beside `**Caveats**`) ends the exemption, so a body moved
 * after the sections under a heading of its own is still counted.
 * @param {unknown} text the final report
 * @returns {string} the text before the first required section; the whole text when it has none or such a heading follows;
 *   '' for a non-string
 */
export function reportBody(text) {
  if (typeof text !== 'string') return '';
  const lines = text.split('\n');
  const headings = [];
  let inFence = false;
  lines.forEach((line, index) => {
    if (FENCE.test(line)) inFence = !inFence;
    const heading = inFence ? null : headingOf(line);
    if (heading !== null) headings.push({ index, ...heading });
  });
  const first = headings.find((heading) => heading.kind === REQUIRED);
  if (!first) return text;
  const ended = headings.some((heading) => heading.index > first.index && heading.kind === OTHER && heading.level <= first.level);
  return ended ? text : lines.slice(0, first.index).join('\n');
}
