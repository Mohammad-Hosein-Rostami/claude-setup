// Purpose: the design and no-change evidence in a request text (the brief, STATUS rules and decisions, a prompt), in English and
// Persian. Split out of ui-evidence.mjs, which re-exports everything here, so callers import from either file.
// Exports: requestEvidence, uiClauses, ownClauseMatches, FIGMA_LINK, DESIGN_WORDS, UI_WORDS.
// Invariants: pure (imports nothing, no I/O, so the router imports it without a cycle). Request text is untrusted: capped at 1 MB
// (text past the cap is reported as `partial`, which the caller plans as full checks), only tested with regexes that run in linear
// time, never evaluated, and only short matched phrases are returned. A Figma link is design evidence in any clause, and nothing
// here lowers a depth: noChange and design are both returned and the plan takes the stricter.
// Design scope (a positive pixel or Figma request always counts): a negator refuses a design phrase only when it governs it directly,
// with nothing but light words between them (BRIDGE_WORDS, at most MAX_BRIDGE_WORDS: "don't make it pixel perfect"); a content word
// ends its reach ("never ship the screen unless it is pixel perfect", FA "بدون هیچ اختلافی مطابق فیگما"). In a clause that talks
// about the checks, the talk phrase itself is blanked and a design phrase counts when a request verb governs it the same way
// ("implement the figma frame ... with full ui checks"), never in a statement ("the pixel checks are heavy"). UI nouns and the
// router's own words keep the clause rule: any EN negator before them, or FA negator in the clause, and every talk clause, drop them.

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
const TALK = /\b(?:ui|ux|pixel|visual|design|figma|screen)[\s-]?(?:perfect[\s-]?)?(?:checks?|checkers?|checking|gates?|chains?|loops?|proofs?|qa|rounds?)\b|\bchecks\b|\b(?:visual-qa|ui-check|ui-proof|ui-coverage|router|check[\s-]plan)\b|\bwhat\sdo(?:es)?\s(?:u|you|ya|it|this|that)\smean\b|(?:چک|تست|بررسی)[\s‌]?ها|(?:چک|تست|بررسی)[\s‌](?:ی[\s‌])?(?:ui|یو[\s‌]?آی|پیکسل|فیگما|ظاهر)/i;
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
const TALK_ALL = globalOf(TALK);

// The design scope walk (header "Design scope"). Words are split on spaces and the Persian zero-width non-joiner.
const MAX_BRIDGE_WORDS = 6; // light words a negator or request verb reaches across ("not every ui work is a full pixel-perfect")
const SCOPE_WINDOW_CHARS = 200; // text read on each side of a design phrase: 7 words, with room for blanked spans
const WORD_SPLIT = /[\s‌]+/;
const WORD_EDGE = /^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu;
const EN_NEGATOR_WORDS = new Set(['no', 'not', 'never', 'without', 'skip', 'skipping', 'stop', 'nothing', 'avoid', 'cannot',
  ...['do', 'does', 'did', 'should', 'must', 'wo', 'ca'].flatMap((stem) => [`${stem}n't`, `${stem}nt`])]);
const FA_NEGATOR_WORDS = new Set(['نکن', 'نکنید', 'نکنی', 'نکنین', 'نکنه', 'نده', 'ندهید', 'ندید', 'ندین', 'نزن', 'نزنید', 'نزنین',
  'نساز', 'نسازید', 'نسازین', 'نباید', 'نخواه', 'بدون', 'نه', 'هرگز', 'نمی']);
// "is not pixel perfect" is a complaint, not a refusal (as EN_NEGATOR's look-behind)
const COMPLAINT_BEFORE_NOT = new Set(['is', 'are', 'was', 'were', "it's", 'look', 'looks', 'seem', 'seems']);
// Imperative verbs that ask for the design work in a talk clause ("implement the figma frame"); EN before, FA after the phrase.
const REQUEST_VERBS = new Set(['make', 'build', 'implement', 'match', 'follow', 'create', 'code', 'recreate', 'replicate', 'redo', 'rebuild',
  'use', 'apply', 'do', 'ship', 'deliver', 'port', 'copy', 'convert', 'turn', 'finish', 'complete', 'fix', 'update', 'align',
  'بساز', 'بسازید', 'بسازین', 'پیاده', 'کن', 'کنید', 'کنین']);
// Light words: articles, pronouns, prepositions, quantifiers, light verbs (FA: object marker, prepositions, "any work", "want", "be").
const BRIDGE_WORDS = new Set([...REQUEST_VERBS, 'a', 'an', 'the', 'it', 'its', 'this', 'that', 'these', 'those', 'any', 'anything', 'some',
  'my', 'our', 'your', 'me', 'us', 'you', 'i', 'we', 'every', 'all', 'each', 'full', 'fully', 'whole', 'exact', 'exactly', 'really', 'even',
  'just', 'too', 'also', 'again', 'yet', 'on', 'in', 'for', 'to', 'with', 'of', 'at', 'about', 'into', 'from', 'made', 'making', 'doing',
  'done', 'go', 'going', 'using', 'want', 'need', 'try', 'trying', 'bother', 'worry', 'care', 'aim', 'be', 'is', 'are', 'being', 'get',
  'add', 'run', 'ui', 'ux', 'work', 'job', 'mode', 'perfect',
  'را', 'رو', 'به', 'با', 'در', 'روی', 'برای', 'از', 'این', 'اون', 'آن', 'هم', 'هیچ', 'کامل', 'دقیق', 'کاری', 'کار', 'خوام', 'خواهم',
  'میخوام', 'باشه', 'باشد', 'بشه', 'شود', 'پرفکت']);

const wordsOf = (text) => text.split(WORD_SPLIT).map((word) => word.replace(WORD_EDGE, '')).filter(Boolean);

/**
 * Who governs a design phrase at [start, end) of a clause: `negated` (a negator reaches it across light words: EN before it, FA before
 * or after it), `request` (a request verb reaches it, or the phrase starts with one: "match the frame"), or neither.
 */
function designScope(clause, start, end) {
  const before = wordsOf(clause.slice(Math.max(0, start - SCOPE_WINDOW_CHARS), start));
  if (start > SCOPE_WINDOW_CHARS) before.shift(); // a word cut by the window is not read
  const after = wordsOf(clause.slice(end, end + SCOPE_WINDOW_CHARS));
  if (end + SCOPE_WINDOW_CHARS < clause.length) after.pop();
  let request = REQUEST_VERBS.has(wordsOf(clause.slice(start, end))[0]);
  for (let i = before.length - 1, bridges = 0; i >= 0 && bridges <= MAX_BRIDGE_WORDS; i--, bridges++) {
    const word = before[i];
    if (word === 'not' && COMPLAINT_BEFORE_NOT.has(before[i - 1])) break;
    if (EN_NEGATOR_WORDS.has(word) || FA_NEGATOR_WORDS.has(word)) return { negated: true, request };
    if (!BRIDGE_WORDS.has(word)) break;
    request ||= REQUEST_VERBS.has(word);
  }
  for (let i = 0; i < after.length && i <= MAX_BRIDGE_WORDS; i++) {
    if (FA_NEGATOR_WORDS.has(after[i])) return { negated: true, request };
    if (!BRIDGE_WORDS.has(after[i])) break;
    request ||= REQUEST_VERBS.has(after[i]);
  }
  return { negated: false, request };
}

/** The design phrases of a clause that no negator governs; in a talk clause only those a request verb asks for. */
function designMatches({ text, talk }) {
  const read = talk ? text.replace(TALK_ALL, blank) : text;
  const found = [];
  for (const match of read.matchAll(DESIGN_ALL)) {
    const scope = designScope(read, match.index, match.index + match[0].length);
    if (!scope.negated && (scope.request || !talk)) found.push(match[0]);
  }
  return found;
}

/**
 * The request as lower-case text, capped at `maxBytes`, FA letters unified, spaces collapsed; `partial` when text past the cap was not read.
 * @throws {TypeError} on a non-string
 */
function requestText(text, maxBytes = MAX_REQUEST_BYTES) {
  if (text === null || text === undefined) return { text: '', partial: false };
  if (typeof text !== 'string') throw new TypeError('request text must be a string');
  const encoded = new TextEncoder().encode(text.slice(0, maxBytes));
  const partial = text.length > maxBytes || encoded.length > maxBytes;
  return { text: unifiedText(new TextDecoder().decode(encoded.subarray(0, maxBytes))), partial };
}

/** Lower case, typographic apostrophes as `'`, Arabic yeh and kaf as Persian, runs of spaces (no-break space too) as one. */
function unifiedText(read) {
  return read.toLowerCase().replace(/[’‘]/g, "'").replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/[ \t\f\v ]+/g, ' ');
}

/** The negator positions of a clause for the clause rule: first EN start; first FA start, last FA end. */
function negatorsOf(text) {
  const faSpans = [...text.matchAll(FA_NEGATOR_ALL)];
  return {
    enAt: text.search(EN_NEGATOR),
    faFirst: faSpans.length ? faSpans[0].index : Infinity,
    faLastEnd: faSpans.length ? faSpans.at(-1).index + faSpans.at(-1)[0].length : -Infinity,
  };
}

/**
 * The matches of `pattern` in a clause that no negator reaches by the clause rule: no EN negator before it, no FA negator outside it.
 * The negators are found once, at the first match, so a clause the pattern misses costs one scan (linear for many clauses).
 */
function unnegatedMatches(clause, pattern) {
  let negators = null;
  const found = [];
  for (const match of clause.text.matchAll(pattern)) {
    negators ??= negatorsOf(clause.text);
    const { enAt, faFirst, faLastEnd } = negators;
    const end = match.index + match[0].length;
    if (!(enAt >= 0 && enAt < match.index) && faFirst >= match.index && faLastEnd <= end) found.push(match[0]);
  }
  return found;
}

function blank(phrase) {
  return ' '.repeat(phrase.length);
}

/** Each clause of `text` split by `breaks`, double negations and negations that refuse nothing blanked, and whether it is talk. */
const evidenceClauses = (text, breaks) => text.split(breaks).map((part) => {
  const clause = part.replace(AFFIRM, blank).replace(NOT_A_REFUSAL, blank);
  return { text: clause, talk: TALK.test(clause) };
});
const requestClauses = (clauses) => clauses.filter((clause) => !clause.talk);

const phrases = (found) => [...new Set(found.map((phrase) => phrase.trim().slice(0, MAX_PHRASE_CHARS)))].slice(0, MAX_PHRASES);

/** The evidence of the read request; `withNoChange` false skips the no-change phrases (the router reads design only). */
function evidenceOf({ text, partial }, withNoChange = true) {
  const design = [...text.matchAll(FIGMA_LINK_ALL)].map((match) => match[0]);
  const noChange = [];
  for (const clause of evidenceClauses(text, PART_BREAK)) {
    design.push(...designMatches(clause));
    if (withNoChange && !clause.talk) noChange.push(...unnegatedMatches(clause, NO_CHANGE_ALL));
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
 * For the skill router: does the request ask for design work, and does it ask for UI work at all? Talk and negated clauses are removed
 * for UI nouns; design phrases follow the design scope (header).
 * @param {string|null|undefined} text untrusted prompt text
 * @param {number} [maxBytes] the most of it read (default 1 MB; the router reads less to stay fast)
 * @returns {{ design: boolean, ui: boolean }} design: as requestEvidence; ui: design, or a UI noun in a clause that is neither talk nor
 *   negated; a prompt over `maxBytes` is not read whole, so it counts as both (the full route)
 */
export function uiClauses(text, maxBytes = MAX_REQUEST_BYTES) {
  const request = requestText(text, maxBytes);
  if (request.partial) return { design: true, ui: true };
  const design = evidenceOf(request, false).design.length > 0;
  return { design, ui: design || requestClauses(evidenceClauses(request.text, CLAUSE_BREAK)).some((clause) => unnegatedMatches(clause, UI_ALL).length > 0) };
}

/**
 * For the skill router: which of its own word patterns (a skill's route, a follow-up word) match in a clause of the request that is
 * neither talk about the checks nor negated, with the same clauses, talk and clause negation rule as uiClauses' UI nouns.
 * @param {string|null|undefined} text untrusted prompt text
 * @param {RegExp[]} patterns the router's patterns; each must run in linear time (it is run once per clause)
 * @param {number} [maxBytes] the most of the text read (default 1 MB)
 * @returns {boolean[]} one per pattern; a prompt over `maxBytes` counts every pattern as matched (the full route)
 * @throws {TypeError} when text is neither a string nor null/undefined
 */
export function ownClauseMatches(text, patterns, maxBytes = MAX_REQUEST_BYTES) {
  const request = requestText(text, maxBytes);
  if (request.partial) return patterns.map(() => true);
  const clauses = requestClauses(evidenceClauses(request.text, CLAUSE_BREAK));
  return patterns.map((pattern) => {
    const all = globalOf(pattern);
    return clauses.some((clause) => unnegatedMatches(clause, all).length > 0);
  });
}
