// Purpose: output helpers for recall search: query-centred snippets and tag neutralising.
// Exports: windowSnippet, neutralize, stem.
// Invariants: pure; a snippet window is chosen by light-stemmed term matches so it follows the porter/prefix behaviour
// of the FTS index without needing FTS internals.
const MIN_STEM_CHARS = 4;
const SUFFIX = /(?:ations?|ings?|ed|es|ly|s)$/;
const WINDOW_PROBES = 6;

/** Light suffix stripping for matching (keeps at least MIN_STEM_CHARS characters). */
export function stem(word) {
  const cut = word.replace(SUFFIX, '');
  return cut.length >= MIN_STEM_CHARS ? cut : word;
}

/** A `size`-char window of `text` that covers the most distinct query terms (earliest on ties). */
export function windowSnippet(text, terms, size) {
  const lower = text.toLowerCase();
  const probes = terms.map((t) => {
    const at = [];
    const root = stem(t);
    for (let i = lower.indexOf(root); i >= 0 && at.length < WINDOW_PROBES; i = lower.indexOf(root, i + 1)) at.push(i);
    return at;
  });
  const starts = [...new Set(probes.flat().map((i) => Math.max(0, i - Math.floor(size / 3))))].sort((a, b) => a - b);
  let best = { start: 0, covered: -1 };
  for (const start of starts.length ? starts : [0]) {
    const covered = probes.filter((at) => at.some((i) => i >= start && i < start + size)).length;
    if (covered > best.covered) best = { start, covered };
  }
  return text.slice(best.start, best.start + size);
}

const ZERO_WIDTH_SPACE = '\u200b';
/**
 * Defang every tag-like `<word` and `</word` (our own `<recall-results>` / `<recall-digest>` and any lookalike such as
 * `</system>`) by putting a zero-width space after the `<`, so stored text can neither open nor close a block. Visible
 * text stays the same; a `<` that is not followed by a letter (`a < b`, `<=`) is untouched.
 */
export const neutralize = (text) => text.replace(/<\/?(?=[A-Za-z])/g, (open) => open + ZERO_WIDTH_SPACE);
