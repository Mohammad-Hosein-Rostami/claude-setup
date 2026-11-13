// Reply-size caps named in a prompt ("report <= 250 words", "reply in 20 lines", "حداکثر ۳۰۰ کلمه") and the size of a reply.
// Exports: parseCap(prompt), measure(text, unit), overCap(text, cap).
// Invariants: pure, no I/O. A number is a cap only when it is tied to the reply itself: a reply noun (reply, report,
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
