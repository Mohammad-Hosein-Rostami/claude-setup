// Purpose: gather the facts behind the `focus-indicator` finding by pressing the real Tab key (so :focus-visible applies, which a bare
// .focus() call may not trigger) and comparing the computed style of each focused element with its unfocused style.
// Exports: collectFocusables, focusProbe. Invariants: runs last on a page (focus handlers may change it); focusProbe is serialised into
// the page, so it is self-contained (no imports or closure variables); the page DOM is not modified, only a `window` property holds the
// snapshots; stops after MAX_FOCUS_STOPS Tab presses, when focus leaves the page, or when it returns to an element already seen.
import { INDICATOR_FIELDS, MAX_FOCUS_STOPS } from './rendered-checks.mjs';

/**
 * Runs inside the page. mode `snapshot` blurs the page and records the unfocused style of every keyboard-focusable element (and, for a
 * visually hidden one, of its label and neighbours); mode `read` reports the element that now has focus, or 'skip' / 'end'.
 * @param {{mode: 'snapshot'|'read', fields: string[]}} input fields = style properties that can show focus
 * @returns {string|{element: string, hidden: boolean, before: object, after: object, related: {before: object, after: object}[]}|number}
 */
export function focusProbe({ mode, fields }) {
  const FOCUSABLE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex],[contenteditable=""],[contenteditable="true"]';
  const styleOf = (el) => {
    const s = getComputedStyle(el);
    return Object.fromEntries(fields.map((f) => [f, s[f]]));
  };
  const label = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls ? `.${cls}` : ''}`;
  };
  const isHidden = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.opacity === '0' || (s.clip !== 'auto' && s.clip !== '') || r.width <= 1 || r.height <= 1;
  };
  const relatedOf = (el) => [...new Set([...(el.labels ?? []), el.closest('label'), el.nextElementSibling, el.previousElementSibling, el.parentElement])].filter(Boolean);
  if (mode === 'snapshot') {
    document.activeElement?.blur();
    const before = new Map();
    for (const el of document.querySelectorAll(FOCUSABLE)) {
      const r = el.getBoundingClientRect();
      if (el.disabled || el.tabIndex < 0 || r.width <= 0 || r.height <= 0 || getComputedStyle(el).visibility === 'hidden') continue;
      const hidden = isHidden(el);
      const related = hidden ? relatedOf(el).map((rel) => ({ rel, before: styleOf(rel) })) : [];
      before.set(el, { hidden, before: styleOf(el), related });
    }
    window.__uiCheckFocus = { before, seen: new Set() };
    return before.size;
  }
  const { before, seen } = window.__uiCheckFocus;
  const active = document.activeElement;
  if (!active || active === document.body || active === document.documentElement || seen.has(active)) return 'end';
  seen.add(active);
  const start = before.get(active);
  if (!start) return 'skip';
  return {
    element: label(active), hidden: start.hidden, before: start.before, after: styleOf(active),
    related: start.related.map(({ rel, before: relBefore }) => ({ before: relBefore, after: styleOf(rel) })),
  };
}

/**
 * Tab through the page and collect, per keyboard stop, the style with and without focus.
 * @param {object} page Playwright page (already opened and settled)
 * @param {number} [max] Tab presses at most
 * @returns {Promise<{element: string, hidden: boolean, before: object, after: object, related: object[]}[]>} input of focusIndicatorFindings
 */
export async function collectFocusables(page, max = MAX_FOCUS_STOPS) {
  await page.evaluate(focusProbe, { mode: 'snapshot', fields: INDICATOR_FIELDS });
  const facts = [];
  for (let stop = 0; stop < max; stop += 1) {
    await page.keyboard.press('Tab');
    const read = await page.evaluate(focusProbe, { mode: 'read', fields: INDICATOR_FIELDS });
    if (read === 'end') break;
    if (read !== 'skip') facts.push(read);
  }
  return facts;
}
