// Purpose: the two direction decisions for form fields in a right-to-left page.
// `bidi-field` (fails a run): a field whose VALUE reads left to right (phone, email, url, number, one-time code, card number, postal code) but
// computes direction rtl while it holds a value. Only the value is left to right: an empty field follows the page direction, so a field is judged
// on its filled state (the page-side probe in lib/audit.mjs sets a value on an empty field, reads the direction and puts the field back).
// A text field with no such type/inputmode/autocomplete but a name, id or label that sounds like one gets the hint `bidi-field?`.
// `bidi-placeholder` (fails a run): a visible empty field whose placeholder holds a strong right-to-left letter but renders left to right
// (an `dir="ltr"` on the element does that). `bidi-placeholder?` (hint): the placeholder is rtl but aligned with a physical `text-align: left`.
// Exports: bidiFieldFindings, bidiPlaceholderFindings, hasStrongRtl, isHint, BIDI_CHECK, BIDI_HINT_CHECK, BIDI_PLACEHOLDER_CHECK, BIDI_PLACEHOLDER_HINT.
// Invariant: pure; takes plain element facts gathered by auditInPage, so it needs no browser.

export const BIDI_CHECK = 'bidi-field';
export const BIDI_HINT_CHECK = 'bidi-field?';
const LTR_TYPES = new Set(['tel', 'email', 'url', 'number']);
const LTR_INPUTMODES = new Set(['numeric', 'decimal', 'tel', 'email', 'url']);
const LTR_AUTOCOMPLETE = ['tel', 'email', 'url', 'one-time-code', 'cc-number', 'postal-code'];
const TEXT_TYPES = new Set(['', 'text']);
const LTR_NAME_HINT = /phone|mobile|tel|otp|code|email|url|iban|card/i;

/** True for a finding that is only a hint and must not fail a run. */
export const isHint = (finding) => finding.check === BIDI_HINT_CHECK;

/** True when the facts describe a field whose value is always written left to right. */
function readsLeftToRight({ type, inputmode, autocomplete }) {
  const autofill = (autocomplete ?? '').toLowerCase();
  return LTR_TYPES.has((type ?? '').toLowerCase()) || LTR_INPUTMODES.has((inputmode ?? '').toLowerCase()) || LTR_AUTOCOMPLETE.some((hint) => autofill.includes(hint));
}

/** True for a plain text field whose name, id, autocomplete or aria-label sounds like a left-to-right value. */
function soundsLeftToRight({ type, name, id, autocomplete, ariaLabel }) {
  return TEXT_TYPES.has((type ?? '').toLowerCase()) && [name, id, autocomplete, ariaLabel].some((text) => LTR_NAME_HINT.test(text ?? ''));
}

const FIX = 'make only the typed value left to right: `input:not(:placeholder-shown) { direction: ltr }` (needs a placeholder attribute), or dir="ltr" on the field when it has no translated placeholder; the empty field, placeholder, label, hint and error keep the page direction';

function toFinding(field) {
  if (readsLeftToRight(field)) return { check: BIDI_CHECK, element: field.element, detail: `${field.element}: with a value it computes direction rtl, but the value reads left to right; ${FIX}` };
  if (soundsLeftToRight(field)) return { check: BIDI_HINT_CHECK, element: field.element, detail: `${field.element}: its name or label suggests a left-to-right value; if so, ${FIX}` };
  return null;
}

/**
 * Find fields whose value should read left to right but compute direction rtl while they hold a value.
 * @param {{docDirection: string, fields: {element: string, type?: string, inputmode?: string, autocomplete?: string, name?: string, id?: string, ariaLabel?: string, direction: string|null, visible?: boolean}[]}} facts
 *   docDirection is the computed direction of the document element; each field is one input or textarea; `direction` is the computed direction
 *   of the field WHILE IT HOLDS A VALUE (the field's own value, or the probe value for an empty field), null when no value could be probed
 * @param {number} [max] cap on the number of findings
 * @returns {{check: 'bidi-field'|'bidi-field?', element: string, detail: string}[]} `bidi-field` fails the run, `bidi-field?` is a hint
 */
export function bidiFieldFindings({ docDirection, fields }, max = Infinity) {
  if (docDirection !== 'rtl') return [];
  return fields
    .filter((f) => f.visible !== false && (f.type ?? '').toLowerCase() !== 'hidden' && f.direction === 'rtl')
    .map(toFinding)
    .filter(Boolean)
    .slice(0, max);
}

export const BIDI_PLACEHOLDER_CHECK = 'bidi-placeholder';
export const BIDI_PLACEHOLDER_HINT = 'bidi-placeholder?';
const STRONG_RTL_LETTER = /(?=\p{L})[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
const PHYSICAL_LEFT = new Set(['left', '-webkit-left']);

/** True when the text holds a letter that is strong right-to-left (Arabic, Persian, Hebrew, Syriac, Thaana, N'Ko); digits, symbols and Latin letters do not count. */
export const hasStrongRtl = (text) => STRONG_RTL_LETTER.test(text ?? '');

/**
 * Placeholders of visible empty fields that do not follow an rtl page.
 * `bidi-placeholder` (a finding): the placeholder holds a strong rtl letter and renders left to right. `bidi-placeholder?` (a hint): it is rtl but
 * aligned with a physical `text-align: left`. A placeholder with no rtl letter (digits, an example value) is never reported.
 * @param {{docDirection: string, fields: {element: string, placeholder?: string, placeholderDirection?: string, placeholderAlign?: string, visible?: boolean}[]}} facts
 *   placeholder is the placeholder text shown right now ('' when the field holds a value or has none); placeholderDirection is the computed
 *   direction of `::placeholder` (the field's own direction when the browser does not report it)
 * @param {number} [max] cap on the number of findings
 * @returns {{findings: {check: 'bidi-placeholder', element: string, detail: string}[], hints: {check: 'bidi-placeholder?', element: string, detail: string}[]}}
 */
export function bidiPlaceholderFindings({ docDirection, fields }, max = Infinity) {
  const result = { findings: [], hints: [] };
  if (docDirection !== 'rtl') return result;
  for (const f of fields) {
    if (f.visible === false || !hasStrongRtl(f.placeholder)) continue;
    if (f.placeholderDirection === 'ltr') {
      result.findings.push({ check: BIDI_PLACEHOLDER_CHECK, element: f.element, detail: `${f.element}: the placeholder "${f.placeholder}" renders left to right in an rtl page; it is translated text and follows the page direction (an empty field keeps the page direction; make only the typed value left to right: \`input:not(:placeholder-shown) { direction: ltr }\`)` });
    } else if (PHYSICAL_LEFT.has(f.placeholderAlign)) {
      result.hints.push({ check: BIDI_PLACEHOLDER_HINT, element: f.element, detail: `${f.element}: the placeholder "${f.placeholder}" is aligned with text-align: left in an rtl page; use start so it sits on the same edge as the label (apply left only while the field holds a value)` });
    }
  }
  return { findings: result.findings.slice(0, max), hints: result.hints.slice(0, max) };
}
