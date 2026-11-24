// Purpose: the pure half of `figma-diff`: turn a flattened Figma frame (spec.json) into text and graphic units, pair them with the
// units of the built page, and name every difference (a part only in the build, only in Figma, or worded differently).
// Exports: strictText, looseKey, differenceKind, figmaUnits, diffUnits, classifyRow, parseDecisions, CLASSES, PLACE_PX.
// Invariants: pure (no I/O, no browser). A unit is {part, text, box:{x,y,w,h}} with both sides' boxes relative to the top-left of the
// Figma frame and of the built root. Hidden Figma layers never reach this module (flattenSpec drops invisible nodes). Sample data
// (e-mail addresses, phone-like numbers) and texts with no letter or digit never make a row. Graphics on both sides pass the same
// size filter. A row no decision covers gets the default class of its type (classifyRow); a decision needs a written reason of
// MIN_REASON_CHARS+ characters (the ui-coverage rule) and no owner approval: the owner checks the report after the work.
// Ported and cut from an earlier web app project's harness `figma-diff/` (match.mjs, compare-frame.mjs, collect-figma.mjs, decisions.mjs).
import { MIN_REASON_CHARS, isReason } from '../../ui-coverage/lib/shape.mjs';
import { UsageError } from './errors.mjs';

/** Same place: the two boxes overlap, or their centres are at most this far apart (CSS px = Figma px at scale 1). */
export const PLACE_PX = 16;
const NEARLY_SAME = 0.8; // similarity at which a long text is the same text with an edit, wherever it moved
const MIN_LONG_TEXT = 40; // shorter texts are paired by wording or by place, never by likeness alone
const MIN_HELD_KEY = 4; // "one text holds the other" needs at least this many letters, so "a" never pairs with everything
const SPELLING_DISTANCE = 2; // at most this many letters changed is a spelling difference, more is a different wording
const MIN_ARTWORK_PX = 12; // smaller drawings are a tick or a dot inside a control
const MIN_THICKNESS_PX = 3; // thinner drawings are rules and separators, which CSS draws as borders
const DECORATION_SHARE = 0.5; // a drawing at least this share of the frame's width or height is background decoration
const CLUSTER_GAP_PX = 2; // vectors of one icon overlap or touch
const EDGE_PX = 1; // a layer whose centre lies this far outside the frame still belongs to it
const ARTWORK_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON']);
const DEVICE_CHROME = /status ?bar|home ?indicator/i; // a phone frame's drawn system bars are not part of the page
const OLD_CACHE_TEXT_CHARS = 80; // spec.json written before full texts were kept cut every text at 80 characters
const EMAIL = /[\w.*+-]+@[\w.*-]+\.[A-Za-z*]{2,}/g;
const PHONE_LIKE = /\+?\*{2,}\d{2,}|\+?\d[\d ()-]{6,}\d/g;
const SPACE_LIKE = /[\u00a0\u2007\u202f\u200b\u200e\u200f]/g;

/** Whitespace-normalised text: NBSP and zero-width characters become plain spaces, runs collapse, NFC. */
export const strictText = (text) => (text ?? '').normalize('NFC').replace(SPACE_LIKE, ' ').replace(/\s+/g, ' ').trim();

/** Comparison key: lower case, letters and digits only (no punctuation, no spaces, curly and straight quotes alike). */
export const looseKey = (text) => strictText(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** The text with e-mail addresses and phone-like numbers taken out, so sample data compares equal. */
const withoutSampleData = (text) => strictText(strictText(text).replace(EMAIL, ' ').replace(PHONE_LIKE, ' '));
const keyOf = (text) => looseKey(withoutSampleData(text));

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

/** How alike two texts are, 0 to 1: one minus the edit distance of their keys over the longer key. */
function similarity(a, b) {
  const [x, y] = [keyOf(a), keyOf(b)];
  if (!x && !y) return 1;
  return 1 - editDistance(x, y) / Math.max(x.length, y.length);
}

/**
 * Why two texts differ.
 * @param {string} figmaText Figma's characters
 * @param {string} buildText the text the page shows
 * @returns {'same'|'case'|'punctuation'|'spelling'|'words'} punctuation also covers spacing; spelling is at most 2 letters changed
 */
export function differenceKind(figmaText, buildText) {
  const [a, b] = [withoutSampleData(figmaText), withoutSampleData(buildText)];
  if (a === b) return 'same';
  if (a.toLowerCase() === b.toLowerCase()) return 'case';
  const [x, y] = [looseKey(a), looseKey(b)];
  if (x === y) return 'punctuation';
  return editDistance(x, y) <= SPELLING_DISTANCE ? 'spelling' : 'words';
}

const centre = (box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });
const distance = (a, b) => Math.hypot(centre(a).x - centre(b).x, centre(a).y - centre(b).y);
const overlaps = (a, b, gap = 0) => a.x <= b.x + b.w + gap && b.x <= a.x + a.w + gap && a.y <= b.y + b.h + gap && b.y <= a.y + a.h + gap;
const samePlace = (a, b) => overlaps(a, b) || distance(a, b) <= PLACE_PX;
const centreInside = (outer, inner) => {
  const { x, y } = centre(inner);
  return x >= outer.x - EDGE_PX && x <= outer.x + outer.w + EDGE_PX && y >= outer.y - EDGE_PX && y <= outer.y + outer.h + EDGE_PX;
};
const union = (a, b) => {
  const [x, y] = [Math.min(a.x, b.x), Math.min(a.y, b.y)];
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
const boxOf = ({ x, y, w, h }) => ({ x, y, w, h });

/** True for a drawing worth listing: big enough, not a thin rule, not a background shape spanning the frame. */
const isArtwork = (box, frame) => Math.max(box.w, box.h) >= MIN_ARTWORK_PX && Math.min(box.w, box.h) >= MIN_THICKNESS_PX
  && box.w < frame.w * DECORATION_SHARE && box.h < frame.h * DECORATION_SHARE;

/** Drawn vectors merged into one graphic per icon or drawing (vectors that overlap or touch belong together). */
function artworkClusters(nodes) {
  let clusters = [];
  for (const node of nodes.filter((n) => ARTWORK_TYPES.has(n.type))) {
    const touching = clusters.filter((c) => overlaps(c.box, node, CLUSTER_GAP_PX));
    const box = touching.reduce((merged, c) => union(merged, c.box), boxOf(node));
    clusters = [...clusters.filter((c) => !touching.includes(c)), { part: 'graphic', text: '', box, node: node.id, name: node.name }];
  }
  return clusters;
}

/**
 * Read a flattened Figma frame into units.
 * @param {{root: {id: string, w: number, h: number}, nodes: object[]}} spec spec.json (flattenSpec output)
 * @returns {{units: object[], frame: {x: number, y: number, w: number, h: number}, ignored: {outsideFrame: number, deviceChrome: number},
 *   cutTexts: number}} cutTexts = texts of exactly 80 characters (a cache written before full texts were kept: re-pull it)
 */
export function figmaUnits(spec) {
  const frame = { x: 0, y: 0, w: spec.root.w, h: spec.root.h };
  const layers = spec.nodes.filter((n) => n.id !== spec.root.id && n.visible !== false); // flattenSpec already drops hidden layers; a hand-made spec may not
  const inside = layers.filter((n) => centreInside(frame, n));
  const chrome = inside.filter((n) => n.type !== 'TEXT' && DEVICE_CHROME.test(n.name ?? ''));
  const page = inside.filter((n) => !chrome.some((c) => centreInside(c, n))); // a chrome layer holds its own centre, so it goes too
  const texts = page.filter((n) => n.type === 'TEXT').map((n) => ({ part: 'text', text: strictText(n.text), box: boxOf(n), node: n.id, name: n.name }));
  return {
    units: [...texts, ...artworkClusters(page)],
    frame,
    ignored: { outsideFrame: layers.length - inside.length, deviceChrome: inside.length - page.length },
    cutTexts: texts.filter((t) => (t.text ?? '').length === OLD_CACHE_TEXT_CHARS).length,
  };
}

/** Pair each Figma unit with the best-scoring free built unit (score null = not a candidate); paired units leave both lists. */
function pairPass(state, how, score) {
  for (const figma of [...state.figmaLeft]) {
    let best = null;
    for (const build of state.buildLeft) {
      const value = score(figma, build);
      if (value !== null && (best === null || value > best.value)) best = { build, value };
    }
    if (!best) continue;
    state.pairs.push({ figma, build: best.build, how });
    state.figmaLeft.splice(state.figmaLeft.indexOf(figma), 1);
    state.buildLeft.splice(state.buildLeft.indexOf(best.build), 1);
  }
}

/** Text pairing, strongest evidence first: same wording, nearly the same long text, one text holding the other, same place. */
function pairTexts(figmaTexts, builtTexts) {
  const state = { pairs: [], figmaLeft: [...figmaTexts], buildLeft: [...builtTexts] };
  pairPass(state, 'same wording', (f, b) => (keyOf(f.text) === keyOf(b.text) ? -distance(f.box, b.box) : null));
  pairPass(state, 'nearly the same wording', (f, b) => {
    const alike = similarity(f.text, b.text);
    return alike >= NEARLY_SAME && Math.max(f.text.length, b.text.length) > MIN_LONG_TEXT ? alike : null;
  });
  pairPass(state, 'one text holds the other', (f, b) => {
    const [x, y] = [keyOf(f.text), keyOf(b.text)];
    return Math.min(x.length, y.length) >= MIN_HELD_KEY && (x.includes(y) || y.includes(x)) && samePlace(f.box, b.box) ? -distance(f.box, b.box) : null;
  });
  pairPass(state, 'same place', (f, b) => (samePlace(f.box, b.box) ? similarity(f.text, b.text) - distance(f.box, b.box) / 1000 : null));
  return state;
}

const DIFFERENCE_ORDER = ['same', 'case', 'punctuation', 'spelling', 'words'];

/** A built text split by a link inside it (`Have an account? <a>Log in</a>`) is judged by its whole block when that fits Figma better. */
function closestDifference(figmaText, build) {
  const kinds = [differenceKind(figmaText, build.text)];
  if (build.context) kinds.push(differenceKind(figmaText, build.context));
  return kinds.sort((a, b) => DIFFERENCE_ORDER.indexOf(a) - DIFFERENCE_ORDER.indexOf(b))[0];
}

const figmaSide = (u) => ({ figma: u.part === 'graphic' ? u.name : u.text, node: u.node, figmaBox: u.box });
const buildSide = (u) => ({ build: u.part === 'graphic' ? u.name : u.text, where: u.where, buildBox: u.box });

/** Rows for texts: wording rows for pairs that differ; missing and extra rows for the rest, unless the other side's block holds them. */
function textRows(figmaTexts, builtTexts) {
  const { pairs, figmaLeft, buildLeft } = pairTexts(figmaTexts, builtTexts);
  const rows = [];
  for (const { figma, build } of pairs) {
    const difference = closestDifference(figma.text, build);
    if (difference !== 'same') rows.push({ type: 'wording', part: build.part, difference, ...figmaSide(figma), ...buildSide(build) });
  }
  const heldByPairedFigma = (u) => pairs.some((p) => keyOf(p.figma.text).includes(keyOf(u.text)) && samePlace(p.figma.box, u.box));
  const heldByBuiltBlock = (u) => builtTexts.some((b) => b.contextBox && keyOf(b.context).includes(keyOf(u.text)) && samePlace(b.contextBox, u.box));
  for (const u of buildLeft) if (!heldByPairedFigma(u)) rows.push({ type: 'extra', part: u.part, figma: '', ...buildSide(u) });
  for (const u of figmaLeft) if (!heldByBuiltBlock(u)) rows.push({ type: 'missing', part: 'text', ...figmaSide(u), build: '' });
  return rows;
}

/** Rows for graphics: a Figma drawing and a built image, svg or CSS picture pair when they lie in the same place. */
function graphicRows(figmaGraphics, builtGraphics) {
  const state = { pairs: [], figmaLeft: [...figmaGraphics], buildLeft: [...builtGraphics] };
  pairPass(state, 'same place', (f, b) => (samePlace(f.box, b.box) ? -distance(f.box, b.box) : null));
  return [
    ...state.figmaLeft.map((u) => ({ type: 'missing', part: 'graphic', ...figmaSide(u), build: '' })),
    ...state.buildLeft.map((u) => ({ type: 'extra', part: 'graphic', figma: '', ...buildSide(u) })),
  ];
}

/**
 * Compare one Figma frame with one built page.
 * @param {{units: object[], frame: object}} figma figmaUnits output
 * @param {object[]} builtUnits collectBuiltUnits output: {part: 'text'|'link'|'button'|'label'|'field'|'graphic', text, box, where, name?, context?, contextBox?}
 * @returns {object[]} rows {type: 'extra'|'missing'|'wording', part, figma, build, node?, where?, difference?, figmaBox?, buildBox?}, sorted by type then top edge
 */
export function diffUnits(figma, builtUnits) {
  const comparable = (u) => (u.part === 'graphic' ? isArtwork(u.box, figma.frame) : keyOf(u.text) !== '');
  const [figmaKept, builtKept] = [figma.units.filter(comparable), builtUnits.filter(comparable)];
  const isGraphic = (u) => u.part === 'graphic';
  const rows = [
    ...textRows(figmaKept.filter((u) => !isGraphic(u)), builtKept.filter((u) => !isGraphic(u))),
    ...graphicRows(figmaKept.filter(isGraphic), builtKept.filter(isGraphic)),
  ];
  const order = ['missing', 'extra', 'wording'];
  const top = (row) => (row.figmaBox ?? row.buildBox).y;
  return rows.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || top(a) - top(b));
}

/** The three classes of a row. */
export const CLASSES = { fix: 'fix', keep: 'keep', ask: 'ask the owner' };
const MINOR_WORDING = new Set(['case', 'punctuation']);

/**
 * Default class of a row no decision covers. Rule (that harness's decisions.mjs: a difference no decision knows is not passed unseen;
 * the setup's standing rule: an element not in Figma defaults to "match Figma"): a part only in Figma or only in the build is `fix`
 * (match Figma); a case, punctuation or spacing difference is `fix` (use Figma's exact text); a different spelling or wording is
 * `ask the owner` (copy is a product decision, and either side may hold the typo).
 */
function defaultClass(row) {
  if (row.type === 'missing') return { class: CLASSES.fix, reason: 'Figma shows it and the build does not: build it' };
  if (row.type === 'extra') return { class: CLASSES.fix, reason: 'not in Figma: match Figma (remove it), or record a decision with its reason to keep it' };
  if (MINOR_WORDING.has(row.difference)) return { class: CLASSES.fix, reason: `${row.difference} differs: use Figma's exact text` };
  return { class: CLASSES.ask, reason: `the ${row.difference === 'spelling' ? 'spelling' : 'wording'} differs: the owner picks Figma's text or the build's` };
}

const decisionMatches = (decision, row, surface) => decision.type === row.type
  && (decision.surface === undefined || decision.surface === surface)
  && (decision.figma === undefined || strictText(decision.figma) === strictText(row.figma))
  && (decision.build === undefined || strictText(decision.build) === strictText(row.build));

/**
 * Class one row: the first decision that matches it (its reason is the row reason), else the default rule.
 * @param {object} row a diffUnits row
 * @param {string} surface the state's surface
 * @param {object[]} decisions parseDecisions output
 * @returns {{class: string, reason: string}}
 */
export function classifyRow(row, surface, decisions) {
  const decision = decisions.find((d) => decisionMatches(d, row, surface));
  if (!decision) return defaultClass(row);
  return { class: CLASSES[decision.class], reason: decision.reason.trim() };
}

// `owner` is allowed so an older decisions file still loads; it is not read (no owner approval is needed).
const DECISION_KEYS = ['type', 'surface', 'figma', 'build', 'class', 'reason', 'owner'];
const ROW_TYPES = ['extra', 'missing', 'wording'];

function checkDecision(entry, label) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new UsageError(`${label}: must be an object`);
  const unknown = Object.keys(entry).filter((key) => !DECISION_KEYS.includes(key));
  if (unknown.length > 0) throw new UsageError(`${label}: unknown field ${unknown.join(', ')} (allowed: ${DECISION_KEYS.join(', ')})`);
  if (!ROW_TYPES.includes(entry.type)) throw new UsageError(`${label}.type: must be one of ${ROW_TYPES.join(', ')}`);
  if (!Object.hasOwn(CLASSES, entry.class)) throw new UsageError(`${label}.class: must be one of ${Object.keys(CLASSES).join(', ')}`);
  if (!isReason(entry.reason)) throw new UsageError(`${label}.reason: must say why, at least ${MIN_REASON_CHARS} characters (no owner approval is needed)`);
  for (const key of ['surface', 'figma', 'build']) {
    if (entry[key] !== undefined && typeof entry[key] !== 'string') throw new UsageError(`${label}.${key}: must be a string`);
  }
  if (entry.figma === undefined && entry.build === undefined) throw new UsageError(`${label}: needs figma or build (the text or graphic name of the row)`);
}

/**
 * Validate a decisions file: [{type, figma?, build?, surface?, class: 'fix'|'keep'|'ask', reason}] (reason: MIN_REASON_CHARS+
 * characters; an `owner` field of an older file is allowed and not read).
 * @param {unknown} raw parsed JSON
 * @returns {object[]} the decisions, unchanged
 * @throws {UsageError} naming the entry and field of the first mistake
 */
export function parseDecisions(raw) {
  if (!Array.isArray(raw)) throw new UsageError('decisions: must be an array');
  raw.forEach((entry, index) => checkDecision(entry, `decisions[${index}]`));
  return raw;
}
