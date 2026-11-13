// Reply-size caps named in a prompt ("report <= 250 words", "final reply max 25 lines") and the size of a reply.
// Exports: DEFAULT_WORD_CAP, parseCap(prompt), measure(text, unit), overCap(text, cap).
// Invariants: pure, no I/O; a cap counts only when its sentence is about a reply (so "keep files under 300 lines" is
// not a cap); only English caps are read; lines count non-empty lines, words count whitespace-separated tokens.
export const DEFAULT_WORD_CAP = 300; // core rule C24: delegated work returns at most 300 words

const MAX_CAP_DIGITS = 4;
const AMOUNT = `(\\d{1,${MAX_CAP_DIGITS}})\\s*(words?|lines?)\\b`;
const CAP_FORMS = [
  new RegExp(`(?:≤|<=|=<|max(?:imum)?(?: of)?|at most|under|below|within|up to|no more than|not more than|limit(?:ed)? to|cap(?:ped)?(?: of| at)?)\\s*:?\\s*${AMOUNT}`, 'i'),
  new RegExp(`(\\d{1,${MAX_CAP_DIGITS}})[- ](words?|lines?)\\s+(?:cap|limit|max(?:imum)?)\\b`, 'i'),
  new RegExp(`\\b(words?|lines?)\\s+(?:cap|limit|max(?:imum)?)\\s*[:=]?\\s*(\\d{1,${MAX_CAP_DIGITS}})\\b`, 'i'),
];
const ABOUT_A_REPLY = /\b(repl(y|ies)|answers?|responses?|reports?|summary|summaries|status|return|final|output|message)\b/i;
const SENTENCE_END = /[.!?\n]/;

/**
 * The first reply-size cap a prompt names.
 * @param {unknown} prompt prompt text
 * @returns {{limit: number, unit: 'words' | 'lines'} | null} null when no cap sentence is found
 */
export function parseCap(prompt) {
  if (typeof prompt !== 'string') return null;
  for (const sentence of prompt.split(SENTENCE_END)) {
    if (!ABOUT_A_REPLY.test(sentence)) continue;
    for (const form of CAP_FORMS) {
      const m = form.exec(sentence);
      if (!m) continue;
      const [amount, unit] = /^\d/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
      const limit = Number(amount);
      if (limit > 0) return { limit, unit: unit.toLowerCase().startsWith('w') ? 'words' : 'lines' };
    }
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
