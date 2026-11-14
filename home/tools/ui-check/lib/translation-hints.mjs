// Purpose: pure decisions for the three text hints of a right-to-left or translated page: `ltr-run-in-rtl?` (a phone number with +, an email or a URL
// written inside rtl text without isolation), `untranslated?` (a run of English words on an rtl page) and `same-as-default?` (the same words in the first
// locale and in another one, `batch` only). They are hints: reported, never part of a verdict.
// Exports: ltrRunInRtlHints, untranslatedHints, sameAsDefaultHints, comparableTexts, parseAllowList. Invariants: pure; each takes plain facts gathered in the
// page (lib/audit.mjs); a hidden text never produces a hint; every function takes an optional cap on the number of hints.

const EXCERPT_LENGTH = 60;
const LTR_RUNS = [
  { kind: 'phone number with +', pattern: /\+\p{Nd}[\p{Nd}\s().-]{5,}\p{Nd}/u },
  { kind: 'email address', pattern: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/ },
  { kind: 'URL', pattern: /\b(?:https?:\/\/|www\.)\S+/i },
];
const LATIN_WORD_RUN = /\p{Script=Latin}{3,}(?:\s+\p{Script=Latin}{3,})+/u;
const ALLOWED_TERM_SEPARATOR = ' • ';
const MIN_WORDS_TO_COMPARE = 2;
const MAX_COMPARABLE_TEXTS = 1000; // per page and width: enough for a full screen, small enough to keep next to the report

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

/** The text with every allow-listed term (any letter case) replaced by a bullet, so the term can neither start nor continue a run of words. */
function withoutAllowed(text, allowList) {
  return allowList.reduce((rest, term) => rest.replace(new RegExp(escapeRegExp(term), 'giu'), ALLOWED_TERM_SEPARATOR), text);
}

/**
 * Visible text nodes of an rtl element that hold a phone number with `+`, an email or a URL and have no isolating ancestor
 * (`bdi`, `dir="ltr"`, `unicode-bidi: isolate|plaintext|embed`): the bidi algorithm moves the `+` or the dots to the wrong end of the run.
 * Not reported: code, pre, kbd, samp, hidden text, ltr elements.
 * @param {{texts: {element: string, text: string, visible?: boolean, inCode?: boolean, direction?: string, isolated?: boolean}[]}} facts
 * @param {number} [max] cap on the number of hints
 * @returns {{check: 'ltr-run-in-rtl?', element: string, detail: string}[]}
 */
export function ltrRunInRtlHints({ texts }, max = Infinity) {
  const hints = [];
  for (const t of texts) {
    if (t.visible === false || t.inCode || t.isolated || t.direction !== 'rtl') continue;
    const run = LTR_RUNS.map(({ kind, pattern }) => ({ kind, match: t.text.match(pattern) })).find(({ match }) => match);
    if (!run) continue;
    hints.push({ check: 'ltr-run-in-rtl?', element: t.element, detail: `the ${run.kind} "${excerpt(run.match[0])}" sits in right-to-left text with no isolation, so its symbols can land at the wrong end; wrap it in <bdi dir="ltr"> (or an element with dir="ltr")` });
  }
  return hints.slice(0, max);
}

/**
 * Visible text on an rtl document that holds a run of 2+ Latin-letter words of 3+ letters: probably an untranslated string. Option text counts
 * (it is in the DOM even when the list is closed). Not reported: text the page marks `translate="no"`, text in `dir="ltr"`, code, pre, kbd, samp,
 * textarea, an allow-listed term.
 * @param {{docDirection: string, texts: {element: string, text: string, visible?: boolean, keepLatin?: boolean}[]}} facts keepLatin = the text sits under translate="no",
 *   dir="ltr", code, pre, kbd, samp or a textarea
 * @param {string[]} [allowList] terms that are the same in every language (brand names)
 * @param {number} [max] cap on the number of hints
 * @returns {{check: 'untranslated?', element: string, detail: string}[]}
 */
export function untranslatedHints({ docDirection, texts }, allowList = [], max = Infinity) {
  if (docDirection !== 'rtl') return [];
  return texts
    .filter((t) => t.visible !== false && !t.keepLatin)
    .map((t) => ({ t, run: withoutAllowed(t.text, allowList).match(LATIN_WORD_RUN) }))
    .filter(({ run }) => run)
    .map(({ t, run }) => ({ check: 'untranslated?', element: t.element, detail: `"${excerpt(squash(run[0]))}" is English on a right-to-left page: translate it, or add the term to --same-in-all-locales / sameInAllLocales if it is the same in every language` }))
    .slice(0, max);
}

const wordCount = (text) => text.split(/\s+/).filter((word) => /\p{L}/u.test(word)).length;

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
 * @param {number} [max] cap on the number of hints
 * @returns {{check: 'same-as-default?', element: string, detail: string}[]}
 */
export function sameAsDefaultHints({ reference, other, referenceLocale, locale }, allowList = [], max = Infinity) {
  const inReference = new Set(reference);
  return other
    .filter((text) => inReference.has(text) && wordCount(withoutAllowed(text, allowList)) >= MIN_WORDS_TO_COMPARE)
    .map((text) => ({ check: 'same-as-default?', element: `"${excerpt(text)}"`, detail: `the text is identical in ${referenceLocale} and ${locale}: translate it, or add the term to sameInAllLocales if it is the same in every language` }))
    .slice(0, max);
}
