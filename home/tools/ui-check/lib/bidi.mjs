// Purpose: the `bidi-field` responsive finding: in an rtl document, a field whose value reads left to right (phone, email,
// url, number, one-time code, card number, postal code) must be dir="ltr" or the digits and symbols render in the wrong order.
// A text field with no such type/inputmode/autocomplete but a name, id or label that sounds like one gets the lower-severity hint
// `bidi-field?` (reported, never fails the run).
// Exports: bidiFieldFindings, isHint, BIDI_CHECK, BIDI_HINT_CHECK. Invariant: pure; takes plain element facts gathered by auditInPage, so it needs no browser.

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

const FIX = 'set dir="ltr" on the field (the value reads left to right; alignment may stay at the start edge)';

function toFinding(field) {
  if (readsLeftToRight(field)) return { check: BIDI_CHECK, element: field.element, detail: `${field.element}: ${FIX}` };
  if (soundsLeftToRight(field)) return { check: BIDI_HINT_CHECK, element: field.element, detail: `${field.element}: its name or label suggests a left-to-right value; if so, ${FIX}` };
  return null;
}

/**
 * Find fields that should carry dir="ltr" but compute direction rtl.
 * @param {{docDirection: string, fields: {element: string, type?: string, inputmode?: string, autocomplete?: string, name?: string, id?: string, ariaLabel?: string, direction: string, visible?: boolean}[]}} facts
 *   docDirection is the computed direction of the document element; each field is one input or textarea
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
