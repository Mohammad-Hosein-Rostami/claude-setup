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

/** Defang any <recall-results> tag inside past text so it cannot close or fake the output wrapper. */
/** Defang every `<recall-...>` tag (results block, digest block) so stored text cannot open or close ours. */
export const neutralize = (text) => text.replace(/<(\/?)recall-/gi, '<$1recall_');
