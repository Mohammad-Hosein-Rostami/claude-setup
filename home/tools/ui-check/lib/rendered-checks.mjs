// Purpose: pure decision functions for the `responsive` findings that need element facts but no browser: `raw-i18n-key`,
// `focus-indicator`, `rtl-physical-align`, and the `target-size?` hint.
// Exports: rawI18nKeyFindings, focusIndicatorFindings, focusRingWidth, focusRingWidthHints, rtlPhysicalAlignFindings, targetSizeHints, MAX_FOCUS_STOPS, FOCUS_INDICATOR_FAILS, RAW_KEY_PATTERN, INDICATOR_FIELDS, RELATED_SIZE_FIELDS.
// Invariants: pure; each takes plain facts gathered in the page (lib/audit.mjs, lib/focus-audit.mjs), so a unit test needs no browser;
// a hidden element never produces a finding; every function takes an optional cap on the number of findings.

/** Dotted lower-case identifier such as `reset.hint`: what an i18n lookup prints when the key has no translation. */
export const RAW_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
/** Keyboard stops examined for `focus-indicator` (Tab presses). */
export const MAX_FOCUS_STOPS = 60;
/**
 * P3e: `focus-indicator` ships as a hint (a new heuristic proves itself first). Set true once results.md shows 0 false alarms on one real
 * screen per UI project; any false alarm keeps it a hint. While false, a control whose focus changes nothing is a hint, never a failure.
 */
export const FOCUS_INDICATOR_FAILS = false;
/**
 * Computed-style fields that can show keyboard focus on the element itself: outline, box-shadow, border colour/width, background colour or image,
 * text decoration, transform, and `content` (a ::before/::after that only exists on focus). Text colour alone is not counted.
 */
export const INDICATOR_FIELDS = ['outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'borderColor', 'borderWidth', 'backgroundColor', 'backgroundImage', 'textDecorationLine', 'transform', 'content'];
/** Extra fields compared on the related elements only (a sibling underline that grows from width 0 on focus). */
export const RELATED_SIZE_FIELDS = ['width', 'height'];

/** Last segments that make a dotted token a file name, host name or version rather than a translation key. */
const FILE_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'css', 'scss', 'html', 'htm', 'md', 'txt', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico',
  'xml', 'yaml', 'yml', 'csv', 'zip', 'gz', 'tar', 'log', 'lock', 'map', 'woff', 'woff2', 'ttf', 'mp3', 'mp4', 'doc', 'docx', 'xls', 'xlsx', 'py', 'rb', 'go', 'rs', 'java', 'sh']);
const TOP_LEVEL_DOMAINS = new Set(['com', 'net', 'org', 'io', 'dev', 'app', 'co', 'ai', 'info', 'biz', 'edu', 'gov', 'xyz', 'ir', 'ru', 'cn', 'uk', 'de', 'fr', 'jp']);
const VERSION = /^v\d+(\.\d+)+$/;

/** True for a dotted token that is a version, file name, host name or abbreviation (`v1.2.3`, `package.json`, `acme.io`, `fig.1`, `i.e`), not a translation key. */
function isNotAKey(token) {
  const segments = token.split('.');
  const last = segments[segments.length - 1];
  return VERSION.test(token) || FILE_EXTENSIONS.has(last) || TOP_LEVEL_DOMAINS.has(last) || segments.some((part) => /^\d+$/.test(part)) || segments.every((part) => part.length === 1);
}

/**
 * Visible text nodes whose whole trimmed text is a raw translation key (a missing translation shown to the user). Not reported: text in code, pre, kbd,
 * samp or a select, collapsed or hidden content, versions, file names, host names (public-suffix-like last segment), a digit-only segment, an uppercase letter
 * (the pattern is lower case) and single-letter abbreviations.
 * @param {{texts: {element: string, text: string, visible?: boolean, inCode?: boolean}[]}} facts one entry per own text node of an element
 * @param {number} [max] cap on the number of hints
 * @returns {{check: 'raw-i18n-key', element: string, detail: string}[]}
 */
export function rawI18nKeyFindings({ texts }, max = Infinity) {
  return texts
    .filter((t) => t.visible !== false && !t.inCode && RAW_KEY_PATTERN.test(t.text.trim()) && !isNotAKey(t.text.trim()))
    .map((t) => ({ check: 'raw-i18n-key', element: t.element, detail: `shows the raw translation key "${t.text.trim()}" (missing translation, or the lookup fell back to the key)` }))
    .slice(0, max);
}

/** Elements whose text is code, user input or a control label, where an explicit `text-align: left` is normal. */
const ALIGN_EXEMPT_TAGS = new Set(['pre', 'code', 'textarea', 'button', 'kbd', 'samp']);
const CELL_TAGS = new Set(['td', 'th']);
const NUMBERS_ONLY = /^[\d\s.,:;+\-\u2212/()%$\u20AC\u00A3\u0660-\u0669\u06F0-\u06F9\u066B\u066C]+$/u;
const PHYSICAL_LEFT = new Set(['left', '-webkit-left']);

/**
 * Visible text blocks whose own direction is rtl and whose computed text-align is `left` (in rtl it only computes to `left` when `left` was written).
 * Not reported: pre, code, textarea, button, a table cell holding only numbers, `dir=auto` text, a block that is itself ltr (an ltr island).
 * @param {{blocks: {element: string, tag?: string, text?: string, textAlign: string, direction: string, visible?: boolean, dirAuto?: boolean}[]}} facts
 *   blocks = non-inline elements with their own text
 * @param {number} [max] cap on the number of hints
 * @returns {{check: 'rtl-physical-align', element: string, detail: string}[]}
 */
export function rtlPhysicalAlignFindings({ blocks }, max = Infinity) {
  const numericCell = (b) => CELL_TAGS.has(b.tag) && NUMBERS_ONLY.test((b.text ?? '').trim());
  return blocks
    .filter((b) => b.visible !== false && b.direction === 'rtl' && PHYSICAL_LEFT.has(b.textAlign) && !b.dirAuto && !ALIGN_EXEMPT_TAGS.has(b.tag) && !numericCell(b))
    .map((b) => ({ check: 'rtl-physical-align', element: b.element, detail: 'text-align: left in an rtl context sits on the wrong edge; use start (or remove it) so the text follows the direction' }))
    .slice(0, max);
}

const drawn = (width) => String(width).split(' ').some((part) => Number.parseFloat(part) > 0);
/** A colour that defaults to the text colour (outline, border) only shows when the line is drawn, so a text colour change alone must not count. */
const COLOUR_NEEDS_LINE = {
  outlineColor: (state) => state.outlineStyle !== 'none' && drawn(state.outlineWidth),
  borderColor: (state) => drawn(state.borderWidth),
};

function fieldChanged({ before, after }, field) {
  if (before[field] === after[field]) return false;
  const drawnNow = COLOUR_NEEDS_LINE[field];
  return drawnNow === undefined || drawnNow(before) || drawnNow(after);
}

const differs = (pair, fields) => fields.some((field) => fieldChanged(pair, field));

/**
 * Keyboard-focusable elements that look the same focused and unfocused.
 * An indicator is a change (see INDICATOR_FIELDS) on the element or its ::before/::after (`own`), or on `related`: up to 3 ancestors (focus-within,
 * :has wrappers), the label, the following siblings, the previous sibling, the open shadow root's content, each with its pseudo-elements; on related
 * elements a width or height change counts too. A visually hidden control (opacity 0, clipped, 1px: a custom checkbox's real input) is judged on `related`
 * only, because its own outline is invisible too.
 * @param {{focusables: {element: string, hidden: boolean, own: {before: object, after: object}[], related: {before: object, after: object}[]}[]}} facts
 *   before/after = the style fields without and with keyboard focus (Tab, so :focus-visible applies)
 * @param {number} [max] cap on the number of findings
 * @returns {{check: 'focus-indicator', element: string, detail: string}[]} every focusable the walk collected is judged (the walk itself is capped, lib/focus-audit.mjs)
 */
export function focusIndicatorFindings({ focusables }, max = Infinity) {
  const relatedFields = [...INDICATOR_FIELDS, ...RELATED_SIZE_FIELDS];
  const shown = (f) => (f.hidden ? [] : f.own).some((pair) => differs(pair, INDICATOR_FIELDS)) || f.related.some((pair) => differs(pair, relatedFields));
  return focusables
    .filter((f) => !shown(f))
    .map((f) => ({
      check: 'focus-indicator',
      element: f.element,
      detail: `no visible focus indicator: outline, box-shadow, border, background, underline and transform are unchanged on keyboard focus, on it and on its wrappers, label and neighbours${f.hidden ? ' (it is visually hidden: only its label and neighbours can show focus)' : ''}`,
    }))
    .slice(0, max);
}

const NO_OUTLINE_STYLES = new Set(['none', 'hidden']);
const SHADOW_LAYER_SEPARATOR = /,(?![^(]*\))/; // a comma outside rgb( ... )
const SHADOW_COLOUR = /[a-z-]+\([^)]*\)|#[0-9a-f]+/gi;
const SHADOW_NUMBERS = /(-?\d*\.?\d+)px/g;
const SHADOW_INSET = /\binset\b/g;

/** Width in px of the outline in a computed style, 0 when its style is none or hidden. */
function outlineWidthOf(style) {
  return NO_OUTLINE_STYLES.has(style.outlineStyle) ? 0 : parseFloat(style.outlineWidth) || 0;
}

/** Layers of a computed `box-shadow` value (empty for `none`). */
function shadowLayers(boxShadow) {
  return boxShadow === undefined || boxShadow === 'none' ? [] : boxShadow.split(SHADOW_LAYER_SEPARATOR).map((layer) => layer.trim());
}

/** How far a shadow layer reaches past the box as a solid band: its spread plus its largest offset; a blur-only glow is not a ring (0). */
function shadowReach(layer) {
  const [x = 0, y = 0, blur = 0, spread = 0] = [...layer.replace(SHADOW_COLOUR, '').replace(SHADOW_INSET, '').matchAll(SHADOW_NUMBERS)].map((match) => Number(match[1]));
  return blur > 0 && spread <= 0 ? 0 : Math.max(0, spread + Math.max(Math.abs(x), Math.abs(y)));
}

/** Ring width of one before/after style pair: the outline drawn on focus, or the widest box-shadow layer that was not there before. */
function ringWidthOfPair({ before, after }) {
  const drawn = outlineWidthOf(after);
  const outline = drawn === outlineWidthOf(before) ? 0 : drawn; // an outline that is already there unfocused is not the focus ring
  const had = new Set(shadowLayers(before.boxShadow));
  const added = shadowLayers(after.boxShadow).filter((layer) => !had.has(layer)).map(shadowReach);
  return Math.max(outline, ...added);
}

/**
 * Width in px of the focus ring a keyboard stop shows: the largest of the outline drawn and the box-shadow band added on focus (an element with
 * `outline: none` and a `0 0 0 3px` shadow measures 3, not 0), on the element, its ::before/::after and its related elements. A part that looks the
 * same unfocused as focused adds nothing, so an always-on shadow is not counted. Report-only: it never decides a finding (FOCUS_INDICATOR_FAILS stays false).
 * Chromium reports the default `auto` outline by its computed width, which can be less than the pixels it paints.
 * @param {{hidden: boolean, own: {before: object, after: object}[], related: {before: object, after: object}[]}} facts one keyboard stop, as `focusIndicatorFindings` takes it
 * @returns {number} px, 0 when nothing ring-like appears on focus
 */
export function focusRingWidth({ hidden, own, related }) {
  return Math.max(0, ...(hidden ? [] : own).map(ringWidthOfPair), ...related.map(ringWidthOfPair));
}

const WIDTH_DECIMALS = 100; // widths show with at most 2 decimals

/**
 * Hint `focus-ring-width`: how wide the focus rings of the page are, one row for the whole walk. Report-only information (the number a capture
 * needs to keep a ring out of the clip); it never decides a finding. No row when no stop shows a ring (`focus-indicator` covers that case).
 * @param {{focusables: {element: string, ringWidth: number}[]}} facts the stops of `walkFocus`, each with its `ringWidth` in px
 * @returns {{check: 'focus-ring-width', element: 'page', detail: string}[]} none or one
 */
export function focusRingWidthHints({ focusables }) {
  const ringed = focusables.filter((f) => f.ringWidth > 0);
  if (ringed.length === 0) return [];
  const widest = ringed.reduce((best, f) => (f.ringWidth > best.ringWidth ? f : best));
  const counts = new Map();
  for (const f of ringed) counts.set(f.ringWidth, (counts.get(f.ringWidth) ?? 0) + 1);
  const px = (n) => `${Math.round(n * WIDTH_DECIMALS) / WIDTH_DECIMALS}px`;
  const spread = [...counts].sort(([a], [b]) => a - b).map(([width, count]) => `${px(width)} x${count}`).join(', ');
  return [{ check: 'focus-ring-width', element: 'page', detail: `widest focus ring ${px(widest.ringWidth)} (${widest.element}); ${ringed.length} of ${focusables.length} keyboard stops show one: ${spread}` }];
}

/**
 * Hint `target-size?`: an inline link or button under the minimum size that is NOT inside running text. WCAG 2.5.8 exempts only inline targets in a
 * sentence or text block, so a row of inline links (nav, breadcrumb, pagination, footer, language links) may fail it. The failing `tap-target` check
 * still skips every inline element; this only hints.
 * @param {{targets: {element: string, width: number, height: number, siblingText: boolean}[]}} facts small inline interactive elements;
 *   siblingText = letters or digits sit beside the element in its block (through inline wrappers such as strong or em)
 * @param {number} min minimum width and height in CSS px
 * @param {number} [max] cap on the number of hints
 * @returns {{check: 'target-size?', element: string, detail: string}[]}
 */
export function targetSizeHints({ targets }, min, max = Infinity) {
  return targets
    .filter((t) => (t.width < min || t.height < min) && !t.siblingText)
    .map((t) => ({ check: 'target-size?', element: t.element, detail: `${Math.round(t.width)}x${Math.round(t.height)} < ${min}x${min}; an inline link outside running text is not exempt from WCAG 2.5.8 (confirm and enlarge, or dismiss)` }))
    .slice(0, max);
}
