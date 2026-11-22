// Purpose: gather the facts behind the `focus-indicator` hint by pressing the real Tab key (so :focus-visible applies, which a bare
// .focus() call may not trigger) and comparing the computed style of each focused element, its ::before/::after, its wrappers (3 ancestors),
// its label and neighbours, and the content of an open shadow root, with their unfocused styles.
// Exports: collectFocusables, walkFocus (the walk with a `capped` flag; each stop carries `ringWidth`), focusProbe. Invariants: runs last on a page (focus handlers may change it); focusProbe is serialised into
// the page, so it is self-contained (no imports or closure variables); the page DOM is not modified, only a `window` property holds the
// snapshots; the walk follows the deep active element (into open shadow roots), steps over iframe stops (their content is not inspected),
// and stops after MAX_FOCUS_STOPS focusables, MAX_PRESSES Tab presses, when focus leaves the page, or when it returns to an element already seen.
import { INDICATOR_FIELDS, MAX_FOCUS_STOPS, RELATED_SIZE_FIELDS, focusRingWidth } from './rendered-checks.mjs';

const MAX_PRESSES = MAX_FOCUS_STOPS * 2;
const MAX_CANDIDATES = MAX_FOCUS_STOPS * 2; // DOM order; their unfocused styles are recorded before the first Tab

/**
 * Runs inside the page. mode `snapshot` blurs the page and records the unfocused style of every keyboard-focusable element (also inside open shadow
 * roots) and of the elements around it; mode `read` reports the deep active element, or 'skip' (iframe, not recorded) / 'end' (focus left, or came back).
 * @param {{mode: 'snapshot'|'read', fields: string[], maxCandidates?: number}} input fields = style properties to record
 * @returns {string|number|{element: string, hidden: boolean, own: {before: object, after: object}[], related: {before: object, after: object}[]}}
 */
export function focusProbe({ mode, fields, maxCandidates }) {
  const FOCUSABLE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex],[contenteditable=""],[contenteditable="true"]';
  const MAX_SIBLINGS = 8;
  const MAX_SHADOW_NODES = 30;
  const MAX_ANCESTORS = 3;
  const MAX_CHILDREN = 8;
  const PSEUDOS = ['::before', '::after'];
  const styleOf = ({ node, pseudo }) => {
    const s = getComputedStyle(node, pseudo);
    return Object.fromEntries(fields.map((f) => [f, s[f]]));
  };
  const parentOf = (n) => n.parentElement ?? (n.getRootNode() instanceof ShadowRoot ? n.getRootNode().host : null);
  const deepActive = () => {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active;
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
  const pseudosOf = (node) => PSEUDOS.map((pseudo) => ({ node, pseudo }));
  const withPseudos = (node) => [{ node, pseudo: null }, ...pseudosOf(node)];
  const relatedTargets = (el) => {
    const around = new Set();
    let up = parentOf(el);
    for (let i = 0; up && i < MAX_ANCESTORS; i += 1, up = parentOf(up)) around.add(up);
    for (const l of el.labels ?? []) around.add(l);
    const wrapping = el.closest('label');
    if (wrapping) around.add(wrapping);
    let next = el.nextElementSibling;
    for (let i = 0; next && i < MAX_SIBLINGS; i += 1, next = next.nextElementSibling) around.add(next);
    if (el.previousElementSibling) around.add(el.previousElementSibling);
    around.delete(el);
    const inside = [...el.querySelectorAll('*')].slice(0, MAX_CHILDREN).map((node) => ({ node, pseudo: null })); // a ring drawn on a child (a logo inside a link)
    const inShadow = el.shadowRoot ? [...el.shadowRoot.querySelectorAll('*')].slice(0, MAX_SHADOW_NODES).map((node) => ({ node, pseudo: null })) : [];
    return [...[...around].flatMap(withPseudos), ...inside, ...inShadow];
  };
  const collect = (root, out) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.matches(FOCUSABLE)) out.push(el);
      if (el.shadowRoot) collect(el.shadowRoot, out);
    }
    return out;
  };
  if (mode === 'snapshot') {
    deepActive()?.blur();
    const before = new Map();
    for (const el of collect(document, []).slice(0, maxCandidates)) {
      const r = el.getBoundingClientRect();
      if (el.disabled || el.tabIndex < 0 || r.width <= 0 || r.height <= 0 || getComputedStyle(el).visibility === 'hidden') continue;
      const record = (target) => ({ target, before: styleOf(target) });
      before.set(el, { hidden: isHidden(el), own: withPseudos(el).map(record), related: relatedTargets(el).map(record) });
    }
    window.__uiCheckFocus = { before, seen: new Set() };
    return before.size;
  }
  const { before, seen } = window.__uiCheckFocus;
  const active = deepActive();
  if (!active || active === document.body || active === document.documentElement) return 'end';
  if (/^i?frame$/i.test(active.tagName)) return 'skip'; // Tab is inside a frame: keep pressing until focus is back in this document
  if (seen.has(active)) return 'end';
  seen.add(active);
  const start = before.get(active);
  if (!start) return 'skip';
  const pair = ({ target, before: was }) => ({ before: was, after: styleOf(target) });
  return { element: label(active), hidden: start.hidden, own: start.own.map(pair), related: start.related.map(pair) };
}

/**
 * Tab through the page and collect, per keyboard stop, the style with and without focus.
 * @param {object} page Playwright page (already opened and settled)
 * @param {number} [max] focusables at most
 * @returns {Promise<{element: string, hidden: boolean, own: object[], related: object[], ringWidth: number}[]>} input of focusIndicatorFindings; ringWidth in px
 */
export async function collectFocusables(page, max = MAX_FOCUS_STOPS) {
  return (await walkFocus(page, max)).facts;
}

/**
 * The focus walk with its end reason (P3e): `capped` is true when the walk stopped at `max` focusables or at the Tab-press limit before focus
 * left the page or came back, so a caller fails the run naming the cap instead of stopping silently.
 * @param {object} page Playwright page (already opened and settled)
 * @param {number} [max] focusables at most (MAX_FOCUS_STOPS unless the state raises it with a reason)
 * @returns {Promise<{facts: object[], capped: boolean, max: number}>} each fact also has `ringWidth` (px, from focusRingWidth; reported, never judged)
 */
export async function walkFocus(page, max = MAX_FOCUS_STOPS) {
  const fields = [...INDICATOR_FIELDS, ...RELATED_SIZE_FIELDS];
  const presses = Math.max(MAX_PRESSES, max * 2);
  await page.evaluate(focusProbe, { mode: 'snapshot', fields, maxCandidates: Math.max(MAX_CANDIDATES, max * 2) });
  const facts = [];
  for (let press = 0; press < presses; press += 1) {
    if (facts.length >= max) return { facts, capped: true, max };
    await page.keyboard.press('Tab');
    const read = await page.evaluate(focusProbe, { mode: 'read', fields });
    if (read === 'end') return { facts, capped: false, max };
    if (read !== 'skip') facts.push({ ...read, ringWidth: focusRingWidth(read) });
  }
  return { facts, capped: true, max };
}
