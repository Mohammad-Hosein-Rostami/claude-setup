// Purpose: the `bidi-field` responsive finding: in an rtl document, a field whose value reads left to right (phone, email,
// url, number, one-time code, card number, postal code) must be dir="ltr" or the digits and symbols render in the wrong order.
// Exports: bidiFieldFindings, BIDI_CHECK. Invariant: pure; takes plain element facts gathered by auditInPage, so it needs no browser.

export const BIDI_CHECK = 'bidi-field';
const LTR_TYPES = new Set(['tel', 'email', 'url', 'number']);
const LTR_INPUTMODES = new Set(['numeric', 'decimal', 'tel', 'email', 'url']);
const LTR_AUTOCOMPLETE = ['tel', 'email', 'url', 'one-time-code', 'cc-number', 'postal-code'];

/** True when the facts describe a field whose value is always written left to right. */
function readsLeftToRight({ type, inputmode, autocomplete }) {
  const autofill = (autocomplete ?? '').toLowerCase();
  return LTR_TYPES.has((type ?? '').toLowerCase()) || LTR_INPUTMODES.has((inputmode ?? '').toLowerCase()) || LTR_AUTOCOMPLETE.some((hint) => autofill.includes(hint));
}

/**
 * Find fields that should carry dir="ltr" but compute direction rtl.
 * @param {{docDirection: string, fields: {element: string, type?: string, inputmode?: string, autocomplete?: string, direction: string, visible?: boolean}[]}} facts
 *   docDirection is the computed direction of the document element; each field is one input or textarea
 * @param {number} [max] cap on the number of findings
 * @returns {{check: 'bidi-field', element: string, detail: string}[]}
 */
export function bidiFieldFindings({ docDirection, fields }, max = Infinity) {
  if (docDirection !== 'rtl') return [];
  return fields
    .filter((f) => f.visible !== false && (f.type ?? '').toLowerCase() !== 'hidden' && f.direction === 'rtl' && readsLeftToRight(f))
    .slice(0, max)
    .map((f) => ({
      check: BIDI_CHECK,
      element: f.element,
      detail: `${f.element}: set dir="ltr" on the field (the value reads left to right; alignment may stay at the start edge)`,
    }));
}
