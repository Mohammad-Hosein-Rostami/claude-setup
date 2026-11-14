// Purpose: pure decision functions for the `responsive` findings that need element facts but no browser: `raw-i18n-key`,
// `focus-indicator`, `rtl-physical-align`, and the `target-size?` hint.
// Exports: rawI18nKeyFindings, focusIndicatorFindings, rtlPhysicalAlignFindings, targetSizeHints, MAX_FOCUS_STOPS, RAW_KEY_PATTERN, INDICATOR_FIELDS, RELATED_SIZE_FIELDS.
// Invariants: pure; each takes plain facts gathered in the page (lib/audit.mjs, lib/focus-audit.mjs), so a unit test needs no browser;
// a hidden element never produces a finding; every function takes an optional cap on the number of findings.

/** Dotted lower-case identifier such as `reset.hint`: what an i18n lookup prints when the key has no translation. */
export const RAW_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
/** Keyboard stops examined for `focus-indicator` (Tab presses). */
export const MAX_FOCUS_STOPS = 60;
/**
 * Computed-style fields that can show keyboard focus on the element itself: outline, box-shadow, border colour/width, background colour or image,
 * text decoration, transform, and `content` (a ::before/::after that only exists on focus). Text colour alone is not counted.
 */
export const INDICATOR_FIELDS = ['outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'borderColor', 'borderWidth', 'backgroundColor', 'backgroundImage', 'textDecorationLine', 'transform', 'content'];
/** Extra fields compared on the related elements only (a sibling underline that grows from width 0 on focus). */
export const RELATED_SIZE_FIELDS = ['width', 'height'];

/**
 * Visible text nodes whose whole trimmed text is a raw translation key (a missing translation shown to the user).
 * @param {{texts: {element: string, text: string, visible?: boolean}[]}} facts one entry per own text node of a visible element
 * @param {number} [max] cap on the number of findings
 * @returns {{check: 'raw-i18n-key', element: string, detail: string}[]}
 */
export function rawI18nKeyFindings({ texts }, max = Infinity) {
  return texts
    .filter((t) => t.visible !== false && RAW_KEY_PATTERN.test(t.text.trim()))
    .map((t) => ({ check: 'raw-i18n-key', element: t.element, detail: `shows the raw translation key "${t.text.trim()}" (missing translation, or the lookup fell back to the key)` }))
    .slice(0, max);
}

/**
 * Visible text blocks in an rtl context whose computed text-align is `left` (it only computes to `left` when `left` was written).
 * @param {{docDirection: string, blocks: {element: string, textAlign: string, direction: string, visible?: boolean}[]}} facts blocks = non-inline elements with their own text
 * @param {number} [max] cap on the number of findings
 * @returns {{check: 'rtl-physical-align', element: string, detail: string}[]}
 */
export function rtlPhysicalAlignFindings({ docDirection, blocks }, max = Infinity) {
  if (docDirection !== 'rtl') return [];
  return blocks
    .filter((b) => b.visible !== false && b.direction === 'rtl' && b.textAlign === 'left')
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
 * @returns {{check: 'focus-indicator', element: string, detail: string}[]} at most the first MAX_FOCUS_STOPS focusables are judged
 */
export function focusIndicatorFindings({ focusables }, max = Infinity) {
  const relatedFields = [...INDICATOR_FIELDS, ...RELATED_SIZE_FIELDS];
  const shown = (f) => (f.hidden ? [] : f.own).some((pair) => differs(pair, INDICATOR_FIELDS)) || f.related.some((pair) => differs(pair, relatedFields));
  return focusables
    .slice(0, MAX_FOCUS_STOPS)
    .filter((f) => !shown(f))
    .map((f) => ({
      check: 'focus-indicator',
      element: f.element,
      detail: `no visible focus indicator: outline, box-shadow, border, background, underline and transform are unchanged on keyboard focus, on it and on its wrappers, label and neighbours${f.hidden ? ' (it is visually hidden: only its label and neighbours can show focus)' : ''}`,
    }))
    .slice(0, max);
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
