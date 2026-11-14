// Purpose: pure decisions for the three text hints of a right-to-left or translated page: `ltr-run-in-rtl?` (a phone number, an email or a URL written inside
// rtl text without isolation, where its symbols can land at the wrong end), `untranslated?` (text a user sees or hears that is entirely English on an rtl page)
// and `same-as-default?` (the same words in the first locale and in another one, `batch` only). They are hints: reported, never part of a verdict.
// Exports: ltrRunInRtlHints, untranslatedHints, sameAsDefaultHints, comparableTexts, parseAllowList. Invariants: pure; each takes plain facts gathered in the
// page (lib/audit.mjs); a hidden text never produces a hint; `untranslated?` and `same-as-default?` give ONE row per call (a count and the first few texts),
// so a long English list cannot push the other hints out of report.md.

const EXCERPT_LENGTH = 60;
const LISTED_TEXTS = 5; // how many different texts one grouped hint names
const LISTED_TEXT_LENGTH = 40; // each named text is cut to this many characters, "..." included
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const URL = /\b(?:https?:\/\/|www\.)\S+/gi;
const TRAILING_SENTENCE_PUNCTUATION = /[.,;:!?)\]}'"\u00bb\u060c\u061b\u061f]+$/u; // a full stop after a URL belongs to the sentence, not to the URL
const PHONE = /\+?\p{Nd}[\p{Nd}\s().-]{5,}\p{Nd}/u;
const MIN_DIGITS_WITHOUT_PLUS = 9; // "912 345 6789" is a phone number, "12 03 2024" is a date
const LETTER = /\p{L}/u;
const LATIN_WORD = /\p{Script=Latin}{3,}/u;
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;
const SHORT_ACRONYM = /^\p{Lu}{1,5}$/u; // PDF, SMS, ICE
const INNER_CAPITAL = /\p{Ll}\p{Lu}/u; // iOS, macOS, YouTube: brand-shaped, never a translatable word
const MIN_WORDS_TO_COMPARE = 2;
const MAX_COMPARABLE_TEXTS = 1000; // per page and width: enough for a full screen, small enough to keep next to the report

const cut = (text, length) => (text.length > length ? `${text.slice(0, length - 3)}...` : text);
const excerpt = (text) => (text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH)}...` : text);
const squash = (text) => text.replace(/\s+/g, ' ').trim();
const escapeRegExp = (term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Turn the `--same-in-all-locales` text (comma separated) or the states-file array into a clean list of terms.
 * @param {string|string[]|undefined} input
 * @returns {string[]} trimmed, non-empty terms
 */
export function parseAllowList(input) {
  const items = typeof input === 'string' ? input.split(',') : (input ?? []);
  return items.map((item) => item.trim()).filter(Boolean);
}

/** The text with every allow-listed term replaced by a space. A term matches whole words or a whole phrase in any letter case, never a part of a word ("ICE" does not hide "Notice"). */
function withoutAllowed(text, allowList) {
  return allowList.reduce((rest, term) => rest.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(squash(term))}(?![\\p{L}\\p{N}])`, 'giu'), ' '), squash(text));
}

/**
 * The one row of a grouped check: how many texts matched, what is wrong with them, the first few different ones and what to do.
 * @param {string} check
 * @param {{element: string, text: string}[]} matches in page order, at least one
 * @param {string} problem says what is wrong with the texts, e.g. "in English on a right-to-left page"
 * @param {string} advice what to do, ends the detail
 */
function groupedHint(check, matches, problem, advice) {
  const different = [...new Set(matches.map((m) => squash(m.text)))];
  const named = different.slice(0, LISTED_TEXTS).map((text) => `"${cut(text, LISTED_TEXT_LENGTH)}"`).join(', ');
  const more = different.length > LISTED_TEXTS ? ` and ${different.length - LISTED_TEXTS} more` : '';
  const elements = [...new Set(matches.map((m) => m.element))];
  const element = elements.length > 1 ? `${elements[0]} and ${elements.length - 1} more` : elements[0];
  return { check, element, detail: `${matches.length} text${matches.length > 1 ? 's' : ''} ${problem}: ${named}${more}. ${advice}` };
}

const endsAreLetters = (run) => LETTER.test(run[0]) && LETTER.test(run.at(-1));

/** The first run in the text that the bidi algorithm can scramble, or null. */
function scramblableRun(text) {
  const phone = text.match(PHONE)?.[0];
  const digits = phone?.replace(/\P{Nd}/gu, '').length ?? 0;
  if (phone && (phone.startsWith('+') || (digits >= MIN_DIGITS_WITHOUT_PLUS && /[\s()]/.test(phone)))) return { kind: 'phone number', run: phone };
  // Letters at both ends keep their order inside rtl text; a digit or a symbol at an end is what moves to the wrong side.
  const email = text.match(EMAIL)?.[0];
  if (email && !endsAreLetters(email)) return { kind: 'email address', run: email };
  const url = text.match(URL)?.[0].replace(TRAILING_SENTENCE_PUNCTUATION, '');
  if (url && !endsAreLetters(url)) return { kind: 'URL', run: url };
  return null;
}

/**
 * Visible text nodes of an rtl element that hold a phone number (with `+`, or 9+ digits in groups), an email or a URL and have no isolating ancestor
 * (`bdi`, `dir="ltr"`, `unicode-bidi: isolate|plaintext|embed`): the bidi algorithm moves the `+`, the groups or the dots to the wrong end of the run.
 * An email or URL that starts and ends with a letter keeps its order without isolation and is not reported; one that starts or ends with a digit or a
 * symbol (a trailing `/`) is. Not reported: code, pre, kbd, samp, hidden text, ltr elements.
 * @param {{texts: {element: string, text: string, visible?: boolean, inCode?: boolean, direction?: string, isolated?: boolean}[]}} facts
 * @param {number} [max] cap on the number of hints
 * @returns {{check: 'ltr-run-in-rtl?', element: string, detail: string}[]}
 */
export function ltrRunInRtlHints({ texts }, max = Infinity) {
  const hints = [];
  for (const t of texts) {
    if (t.visible === false || t.inCode || t.isolated || t.direction !== 'rtl') continue;
    const found = scramblableRun(t.text);
    if (found) hints.push({ check: 'ltr-run-in-rtl?', element: t.element, detail: `the ${found.kind} "${excerpt(found.run)}" sits in right-to-left text with no isolation, so its symbols can land at the wrong end; wrap it in <bdi dir="ltr"> (or an element with dir="ltr")` });
  }
  return hints.slice(0, max);
}

/**
 * True when the text is entirely English-looking: no letter outside the Latin script, a word of 3+ letters left after the allow-listed terms, emails and
 * URLs are taken out, and not just one acronym (PDF) or brand-shaped token (iOS).
 */
function looksUntranslated(text, allowList) {
  const rest = withoutAllowed(text.replace(EMAIL, ' ').replace(URL, ' '), allowList);
  if (NON_LATIN_LETTER.test(rest) || !LATIN_WORD.test(rest)) return false;
  const words = rest.match(/\p{L}+/gu);
  return !(words.length === 1 && (SHORT_ACRONYM.test(words[0]) || INNER_CAPITAL.test(words[0])));
}

/**
 * Texts a user sees or hears (text nodes, option labels, shown placeholders, aria-label, title, alt, the value of a submit or button input) that are entirely
 * Latin script in an rtl context: probably untranslated. Not reported: an element or ancestor with a `lang` other than the page's, `translate="no"`, `dir="ltr"`,
 * code, pre, kbd, samp, bdi, hidden text, text in an ltr context, an allow-listed term, a text that is only an email, URL, number, acronym of up to 5 capitals or
 * brand-shaped word. A sentence in the page's script that holds a Latin brand is never reported.
 * @param {{texts: {element: string, text: string, visible?: boolean, keepLatin?: boolean, direction?: string}[]}} facts `direction` is the computed direction of the
 *   element that holds the text; keepLatin = the text sits under translate="no", an other `lang`, dir="ltr", code, pre, kbd, samp or bdi
 * @param {string[]} [allowList] terms that are the same in every language (brand names), whole words or phrases
 * @returns {{check: 'untranslated?', element: string, detail: string}[]} none, or ONE row: the count and the first 5 different texts
 */
export function untranslatedHints({ texts }, allowList = []) {
  const found = texts.filter((t) => t.visible !== false && !t.keepLatin && t.direction === 'rtl' && looksUntranslated(t.text, allowList));
  return found.length === 0 ? [] : [groupedHint('untranslated?', found, 'in English on a right-to-left page', 'Translate them; if a text is the same in every language, mark it lang="en" or translate="no", or add the term to --same-in-all-locales / sameInAllLocales.')];
}

const wordCount = (text) => text.split(/\s+/).filter((word) => LETTER.test(word)).length;

/**
 * The visible texts of a page worth comparing across locales: 2+ words, one entry per distinct text, whitespace squashed.
 * @param {{text: string, visible?: boolean}[]} texts the `texts` facts of a page
 * @returns {string[]} what `batch` stores beside the report for `same-as-default?`
 */
export function comparableTexts(texts) {
  const seen = new Set(texts.filter((t) => t.visible !== false).map((t) => squash(t.text)));
  return [...seen].filter((text) => wordCount(text) >= MIN_WORDS_TO_COMPARE).slice(0, MAX_COMPARABLE_TEXTS);
}

/**
 * Texts of 2+ words that are identical in the first locale and in another one: the second locale probably still shows the default text. Works for
 * left-to-right target locales too (en and de).
 * @param {{reference: string[], other: string[], referenceLocale: string, locale: string}} facts the comparableTexts of both pages (same state and width)
 * @param {string[]} [allowList] terms that are the same in every language; a text left with fewer than 2 words after removing them is not reported
 * @returns {{check: 'same-as-default?', element: string, detail: string}[]} none, or ONE row: the count and the first 5 different texts
 */
export function sameAsDefaultHints({ reference, other, referenceLocale, locale }, allowList = []) {
  const inReference = new Set(reference);
  const same = other.filter((text) => inReference.has(text) && wordCount(withoutAllowed(text, allowList)) >= MIN_WORDS_TO_COMPARE).map((text) => ({ element: `${locale} page`, text }));
  return same.length === 0 ? [] : [groupedHint('same-as-default?', same, `identical in ${referenceLocale} and ${locale}`, 'Translate them, or add a term to sameInAllLocales if it is the same in every language.')];
}
