// Purpose: the design and no-change evidence in a request text (the brief, STATUS rules and decisions, a prompt), in English and
// Persian. Split out of ui-evidence.mjs, which re-exports everything here, so callers import from either file.
// Exports: requestEvidence, uiClauses, ownClauseMatches, FIGMA_LINK, DESIGN_WORDS, UI_WORDS.
// Invariants: pure (imports nothing, no I/O, so the router imports it without a cycle). Request text is untrusted: capped at 1 MB
// (text past the cap is reported as `partial`, which the caller plans as full checks), only tested with regexes that run in linear
// time, never evaluated, and only short matched phrases are returned. A Figma link is design evidence in any clause, and nothing
// here lowers a depth: noChange and design are both returned and the plan takes the stricter.

const MAX_REQUEST_BYTES = 1 << 20; // request text past 1 MB is not read
const MAX_PHRASES = 20; // matched phrases returned per kind
const MAX_PHRASE_CHARS = 80;

/** A Figma file link: design evidence in any clause, even negated, talk or pasted (the router reads pasted blocks for it too). */
export const FIGMA_LINK = /figma\.com\/(?:design|file|proto|board|make)\/|\bnode-id=\d/i;
// "match / follow / per / like the design(s), frame(s), mockup(s)", not "the design system / doc". FA: Figma, pixel,
// "matching the design / frame / Figma".
export const DESIGN_WORDS = /\bfigma\b|\bpixel[\s-]?perfect\b|\b(?:match(?:es|ed|ing)?|follow(?:s|ed|ing)?|per|like|according\sto|as\sin)\s(?:it\s)?(?:to\s)?(?:the\s|this\s|that\s|our\s|these\s|those\s)?(?:designs?|frames?|mock-?ups?|mocks?)\b(?!\s(?:systems?|docs?|documents?|reviews?|decisions?|patterns?|tokens?)\b)|فیگما|پیکسل|(?:مطابق|طبق|عین|مثل|تطابق)\s?(?:با\s)?(?:طرح|دیزاین|فریم)/i;
// The router's UI nouns (FA: page, component, style, design work, button, look).
export const UI_WORDS = /\b(?:ui|ux|components?|screens?|modals?|dialogs?|drawers?|buttons?|navbar|css|scss|sx|tailwind|mui|styling|spacing|responsive|page[\s-]?layouts?|form[\s-]?fields?)\b|صفحه|کامپوننت|استایل|طراحی|دکمه|ظاهر/i;
// FA: without a look change; look/style unchanged; refactor.
const NO_CHANGE_WORDS = /\brefactor(?:s|ed|ing)?\b|\bno\s(?:visual|ui|ux|look|style|styling|design|layout|appearance)\s?(?:changes?|differences?|diffs?)\b|\b(?:don'?t|do\snot|never|without)\s(?:chang|touch|alter|modify)\w*\s(?:the\s|any\s)?(?:look|ui|ux|design|appearance|layout|styles?|styling|visuals?|css|screens?)\b|\bsame\s(?:look|ui|appearance|layout|visuals?|design|screens?|renders?)\b|\b(?:look|ui|visuals?|appearance|layout|screens?|design)\s(?:stays?|remains?)\s(?:the\s)?(?:same|unchanged|identical)\b|\b(?:pixel|visually)[\s-]?identical\b|بدون\s?تغییر\s?(?:ظاهر|ظاهری|در\sظاهر|ui|طراحی|استایل|رابط)|(?:ظاهر|استایل|طراحی|ui)\s?(?:را\s)?(?:تغییر|عوض)\s?(?:نده|ندهید|ندید|نکن|نکنید|نکند|نکنه|نشود|نشه)|ریفکتور/i;
// Talk about the checks themselves gives no evidence: "the pixel checks are heavy", "what do u mean". FA: checks (plural), check of ui/pixel/Figma/look.
// Not "a pixel perfect job": that names the work asked for. (‌ is the Persian zero-width non-joiner.)
const TALK = /\b(?:ui|ux|pixel|visual|design|figma|screen)[\s-]?(?:perfect[\s-]?)?(?:checks?|checkers?|checking|gates?|chains?|loops?|proofs?|qa|rounds?)\b|\bchecks\b|\b(?:visual-qa|ui-check|ui-proof|ui-coverage|done-check|skill[\s-]?router|router|check[\s-]plan)\b|\bwhat\sdo(?:es)?\s(?:u|you|ya|it|this|that)\smean\b|(?:چک|تست|بررسی)[\s‌]?ها|(?:چک|تست|بررسی)[\s‌](?:ی[\s‌])?(?:ui|یو[\s‌]?آی|پیکسل|فیگما|ظاهر)/i;
// EN negation reaches forward ("don't ... pixel perfect"); "is not pixel perfect" is a complaint, not a negation.
const EN_NEGATOR = /\b(?:no|never|without|skip|skipping|stop|nothing|avoid|cannot|(?:do|does|did|should|must|wo|ca)n'?t)\b|(?<!\b(?:is|are|was|were|it's|looks?|seems?)\s)\bnot\b/i;
// FA negation sits in the verb at the clause end, so it counts anywhere in the clause (outside the matched phrase).
const FA_NEGATOR = /(?<=^|[\s‌])(?:نکن(?:ید|ی|ین|ه)?|نده(?:ید)?|ندی[دن]|نزن(?:ید|ین)?|نساز(?:ید|ین)?|نباید|نخواه|بدون|نه|هرگز|نمی)(?=$|[\s‌])/;
// Double negation keeps the evidence: "don't skip the ui checks", FA "do not drop / reduce / remove".
const AFFIRM = /\b(?:don'?t|do\snot|never|no|without)\s(?:skip(?:ping)?|drop(?:ping)?|los(?:e|ing)|sacrific(?:e|ing)|cut(?:ting)?|stop(?:ping)?|ignor(?:e|ing)|miss(?:ing)?)\b|(?:رد|کم|حذف|فراموش)[\s‌]?(?:نکن|نکنید|نشه|نشود)/gi;
// Negations that refuse nothing, blanked before the negators are read: a complaint ("doesn't match the design", "is not matching")
// or not knowing ("I don't know why ...", FA "I don't know / understand").
const NOT_A_REFUSAL = /\b(?:(?:do|does|did|is|are|was|were)(?:n'?t|\snot)|not)\s(?:(?:quite|exactly|fully|really|yet)\s)?(?=match)|\b(?:don'?t|do\snot|didn'?t|did\snot|can'?t|cannot)\s(?:know|understand|get|see|figure\sout|tell)\b|نمی[\s‌]?(?:دونم|دانم|فهمم|فهمیم|دونیم|دانیم)/gi;
// The router's clauses. A colon, a dash (` - `, em dash, en dash), a semicolon and a new line end a clause, so "no shortcuts: make it
// pixel perfect" keeps its design words; a hyphen inside a word (`pixel-perfect`) does not.
const CLAUSE_BREAK = /[.!?;:,\n\r،؛؟…—–]+|\s-+\s|\s(?:but|however)\s|\s(?:ولی|اما)\s/i;
const PART_BREAK = new RegExp(`${CLAUSE_BREAK.source}|\\s(?:and|then|also|so|plus)\\s|\\s(?:و|سپس|بعد)\\s`, 'i'); // finer, for design words

const globalOf = (pattern) => new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
const DESIGN_ALL = globalOf(DESIGN_WORDS);
const NO_CHANGE_ALL = globalOf(NO_CHANGE_WORDS);
const UI_ALL = globalOf(UI_WORDS);
const FIGMA_LINK_ALL = globalOf(FIGMA_LINK);
const FA_NEGATOR_ALL = globalOf(FA_NEGATOR);

/**
 * The request as lower-case text, capped at 1 MB, FA letters unified, spaces collapsed; `partial` when text past the cap was not read.
 * @throws {TypeError} on a non-string
 */
function requestText(text) {
  if (text === null || text === undefined) return { text: '', partial: false };
  if (typeof text !== 'string') throw new TypeError('request text must be a string');
  const encoded = new TextEncoder().encode(text.slice(0, MAX_REQUEST_BYTES));
  const partial = text.length > MAX_REQUEST_BYTES || encoded.length > MAX_REQUEST_BYTES;
  return { text: unifiedText(new TextDecoder().decode(encoded.subarray(0, MAX_REQUEST_BYTES))), partial };
}

/** Lower case, typographic apostrophes as `'`, Arabic yeh and kaf as Persian, runs of spaces (no-break space too) as one. */
function unifiedText(read) {
  return read.toLowerCase().replace(/[’‘]/g, "'").replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/[ \t\f\v ]+/g, ' ');
}

/**
 * The matches of `pattern` in a clause that no negator reaches: no EN negator before the match, no FA negator outside it. The
 * negators are found once per clause (first EN start; first FA start, last FA end), so a long clause with many matches stays linear.
 */
function unnegatedMatches(clause, pattern) {
  const enAt = clause.search(EN_NEGATOR);
  const faSpans = [...clause.matchAll(FA_NEGATOR_ALL)];
  const faFirst = faSpans.length ? faSpans[0].index : Infinity;
  const faLastEnd = faSpans.length ? faSpans.at(-1).index + faSpans.at(-1)[0].length : -Infinity;
  const found = [];
  for (const match of clause.matchAll(pattern)) {
    const end = match.index + match[0].length;
    if (!(enAt >= 0 && enAt < match.index) && faFirst >= match.index && faLastEnd <= end) found.push(match[0]);
  }
  return found;
}

const blank = (phrase) => ' '.repeat(phrase.length);

/** Each clause of `text` split by `breaks`, double negations and negations that refuse nothing blanked, talk clauses left out. */
const evidenceClauses = (text, breaks) =>
  text.split(breaks).map((clause) => clause.replace(AFFIRM, blank).replace(NOT_A_REFUSAL, blank)).filter((clause) => !TALK.test(clause));

const phrases = (found) => [...new Set(found.map((phrase) => phrase.trim().slice(0, MAX_PHRASE_CHARS)))].slice(0, MAX_PHRASES);

function evidenceOf({ text, partial }) {
  const design = [...text.matchAll(FIGMA_LINK_ALL)].map((match) => match[0]);
  const noChange = [];
  for (const clause of evidenceClauses(text, PART_BREAK)) {
    design.push(...unnegatedMatches(clause, DESIGN_ALL));
    noChange.push(...unnegatedMatches(clause, NO_CHANGE_ALL));
  }
  return { design: phrases(design), noChange: phrases(noChange), partial };
}

/**
 * Design and no-change evidence in a request (the brief, STATUS rules and decisions). Talk clauses and negated phrases give nothing,
 * except a Figma link, which counts anywhere.
 * @param {string|null|undefined} text untrusted request text (only the first 1 MB is read)
 * @returns {{ design: string[], noChange: string[], partial: boolean }} the matched phrases (short, lower-case, at most 20 each);
 *   partial: the text was over 1 MB and its rest was not read, so the caller must plan the full checks (pixel)
 * @throws {TypeError} when text is neither a string nor null/undefined
 */
export const requestEvidence = (text) => evidenceOf(requestText(text));

/**
 * For the skill router: does the request ask for design work, and does it ask for UI work at all? Talk and negated clauses are removed.
 * A prompt over 1 MB is not read whole, so it counts as both (the full route).
 * @param {string|null|undefined} text untrusted prompt text
 * @returns {{ design: boolean, ui: boolean }} design: as requestEvidence; ui: design, or a UI noun in a clause that is neither talk nor negated
 */
export function uiClauses(text) {
  const request = requestText(text);
  if (request.partial) return { design: true, ui: true };
  const design = evidenceOf(request).design.length > 0;
  return { design, ui: design || evidenceClauses(request.text, CLAUSE_BREAK).some((clause) => unnegatedMatches(clause, UI_ALL).length > 0) };
}

/**
 * For the skill router: which of its own word patterns (a skill's route, a follow-up word) match in a clause of the request that is
 * neither talk about the checks nor negated, with the same clauses, talk and negation rules as uiClauses.
 * @param {string|null|undefined} text untrusted prompt text (only the first 1 MB is read)
 * @param {RegExp[]} patterns the router's patterns; each must run in linear time (it is run once per clause)
 * @returns {boolean[]} one per pattern; a prompt over 1 MB counts every pattern as matched (the full route)
 * @throws {TypeError} when text is neither a string nor null/undefined
 */
export function ownClauseMatches(text, patterns) {
  const request = requestText(text);
  if (request.partial) return patterns.map(() => true);
  const clauses = evidenceClauses(request.text, CLAUSE_BREAK);
  return patterns.map((pattern) => {
    const all = globalOf(pattern);
    return clauses.some((clause) => unnegatedMatches(clause, all).length > 0);
  });
}
