// Purpose: in-page responsive audit (serialised into the browser by Playwright).
// Exports: auditInPage. It also gathers plain facts (visible inputs, text nodes, text blocks, small inline interactive elements) that lib/bidi.mjs,
// lib/rendered-checks.mjs and lib/translation-hints.mjs turn into findings. Empty fields are probed at the very end (a value is set, the computed
// direction read, the field put back with the native setter: no input/change event, no framework setter, selection stays 0,0, and the `selectionchange`
// the browser queues is swallowed for a moment). Invariant: must stay self-contained - no imports or closure variables, which is why
// it is one function (C3 exception: Playwright serialises it whole).

/**
 * Runs inside the page. Returns layout-invariant violations for the current viewport.
 * @param {{minTarget: number, minText: number, smallViewport: number, max: number}} cfg
 * @returns {{scrollWidth: number, clientWidth: number, findings: {check: string, element: string, detail: string}[],
 *   docDirection: string, fields: {element: string, type: string, inputmode: string, autocomplete: string, name: string, id: string, ariaLabel: string, direction: string|null, visible: boolean,
 *   placeholder: string, placeholderDirection: string, placeholderAlign: string}[] (direction = while the field holds a value; null when no value could be probed),
 *   texts: {element: string, text: string, visible: boolean, inCode: boolean, direction: string, isolated: boolean, keepLatin: boolean}[], blocks: {element: string, tag: string, text: string, textAlign: string, direction: string, visible: boolean, dirAuto: boolean}[],
 *   inlineTargets: {element: string, width: number, height: number, siblingText: boolean}[]}}
 */
export function auditInPage(cfg) {
  const MAX_TEXT_LENGTH = 200; // a raw key is short; longer text cannot match, so it is cut to keep the facts small
  const MAX_TEXTS_PER_ELEMENT = 20;
  const PROBE_VALUE = '1'; // any non-empty value: a field's filled state only depends on the value not being empty
  const PROBE_TYPES = new Set(['', 'text', 'search', 'tel', 'url', 'email', 'password', 'number']); // types that keep a script-set value (a date field would drop '1')
  const SELECTION_GUARD_MS = 100; // the browser queues one `selectionchange` per probed field; they arrive within a few ms, 20 ms caught all five in the measured case
  const ISOLATING_BIDI = /^(isolate|plaintext|embed)/;
  const findings = [];
  const fields = [];
  const probes = [];
  const texts = [];
  const blocks = [];
  const inlineTargets = [];
  const counts = {};
  const add = (check, el, detail) => {
    counts[check] = (counts[check] ?? 0) + 1;
    if (counts[check] <= cfg.max) findings.push({ check, element: label(el), detail });
  };
  const label = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls ? `.${cls}` : ''}`;
  };
  const shown = (el, r, s) => r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.opacity !== '0' && (s.clip === 'auto' || s.clip === '');
  const clippedByAncestor = (el) => {
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      if (getComputedStyle(p).overflowX !== 'visible') return true;
    }
    return false;
  };
  // Content squeezed to nothing by a collapsed or transparent ancestor (closed details, an accordion at height 0, an opacity 0 wrapper) is not visible to the user.
  const collapsedByAncestor = (el) => {
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const ps = getComputedStyle(p);
      const pr = p.getBoundingClientRect();
      const closedDetails = p.tagName === 'DETAILS' && !p.open && !el.closest('summary');
      if (closedDetails || ps.contentVisibility === 'hidden' || ps.opacity === '0' || (ps.overflowY !== 'visible' && pr.height < 1) || (ps.overflowX !== 'visible' && pr.width < 1)) return true;
    }
    return false;
  };
  const ownTexts = (el) => [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim()).map((n) => n.textContent.trim());
  const hasOwnText = (el) => ownTexts(el).length > 0;
  // Letters or digits written beside the link in its block: walk up through inline wrappers (strong, em, an inline li) to the first block.
  const textBeside = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if ([...p.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && /[\p{L}\p{N}]/u.test(n.textContent))) return true;
      if (p === document.body || getComputedStyle(p).display !== 'inline') return false;
    }
    return false;
  };
  // The element or an inline ancestor of the text isolates it from the surrounding rtl run: bdi, dir=ltr, unicode-bidi isolate|plaintext|embed. Block elements never count:
  // the browser style sheet gives p, div and every [dir] element `unicode-bidi: isolate`, which isolates the paragraph from its neighbours, not the text inside it from its own sentence.
  const isolatedByAncestor = (el) => {
    for (let p = el; p && getComputedStyle(p).display === 'inline'; p = p.parentElement) {
      if (p.tagName === 'BDI' || p.getAttribute('dir') === 'ltr' || (!p.hasAttribute('dir') && ISOLATING_BIDI.test(getComputedStyle(p).unicodeBidi))) return true;
    }
    return false;
  };
  const keepsLatin = (el) => el.translate === false || Boolean(el.closest('[dir=ltr],code,pre,kbd,samp,textarea'));
  const fieldFacts = (el, s) => {
    const placeholderStyle = getComputedStyle(el, '::placeholder');
    const emptyWithPlaceholder = el.matches(':placeholder-shown');
    const fact = {
      element: label(el), type: el.getAttribute('type') ?? '', inputmode: el.getAttribute('inputmode') ?? '', autocomplete: el.getAttribute('autocomplete') ?? '', name: el.getAttribute('name') ?? '', id: el.id,
      ariaLabel: el.getAttribute('aria-label') ?? '', direction: s.direction, visible: true,
      placeholder: emptyWithPlaceholder ? (el.getAttribute('placeholder') ?? '').slice(0, MAX_TEXT_LENGTH) : '',
      placeholderDirection: placeholderStyle.direction || s.direction, placeholderAlign: placeholderStyle.textAlign,
    };
    if (el.value === '' && PROBE_TYPES.has((el.getAttribute('type') ?? '').toLowerCase())) {
      fact.direction = null; // set by the probe at the end of the audit
      probes.push({ el, fact });
    }
    fields.push(fact);
  };
  const interactive = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=radio]';
  const vw = document.documentElement.clientWidth;
  const root = document.documentElement;
  if (root.scrollWidth > vw) add('hscroll', root, `scrollWidth ${root.scrollWidth} > viewport ${vw}`);
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (!shown(el, r, s)) continue;
    if (el.matches('input,textarea')) fieldFacts(el, s);
    if ((r.right > vw + 1 || r.left < -1) && s.position !== 'fixed' && !clippedByAncestor(el)) {
      add('offscreen', el, `x ${Math.round(r.left)}..${Math.round(r.right)} outside 0..${vw}`);
    }
    if (hasOwnText(el)) {
      const collapsed = collapsedByAncestor(el);
      const inCode = Boolean(el.closest('code,pre,kbd,samp,select,option'));
      const bidi = { direction: s.direction, isolated: s.direction === 'rtl' && isolatedByAncestor(el), keepLatin: keepsLatin(el) };
      for (const text of ownTexts(el).slice(0, MAX_TEXTS_PER_ELEMENT)) texts.push({ element: label(el), text: text.slice(0, MAX_TEXT_LENGTH), visible: !collapsed, inCode, ...bidi });
      if (s.display !== 'inline') {
        const dirAuto = el.closest('[dir]')?.getAttribute('dir') === 'auto';
        blocks.push({ element: label(el), tag: el.tagName.toLowerCase(), text: ownTexts(el).join(' ').slice(0, MAX_TEXT_LENGTH), textAlign: s.textAlign, direction: s.direction, visible: !collapsed, dirAuto });
      }
      if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1 && s.textOverflow !== 'ellipsis') add('clipped-text', el, `scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`);
      if (vw < cfg.smallViewport && Number.parseFloat(s.fontSize) < cfg.minText) add('small-text', el, `${s.fontSize} < ${cfg.minText}px`);
    }
    if (el.matches(interactive) && (r.width < cfg.minTarget || r.height < cfg.minTarget)) {
      if (s.display !== 'inline') add('tap-target', el, `${Math.round(r.width)}x${Math.round(r.height)} < ${cfg.minTarget}x${cfg.minTarget}`);
      else inlineTargets.push({ element: label(el), width: r.width, height: r.height, siblingText: textBeside(el) }); // exempt by WCAG only inside running text: a hint
    }
  }
  // Fields inside open shadow roots (the walk above does not enter them): only their direction facts are gathered.
  const walkShadowFields = (host) => {
    for (const el of host.shadowRoot.querySelectorAll('*')) {
      if (el.matches('input,textarea')) {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        if (shown(el, r, s)) fieldFacts(el, s);
      }
      if (el.shadowRoot) walkShadowFields(el);
    }
  };
  for (const host of document.body.querySelectorAll('*')) if (host.shadowRoot) walkShadowFields(host);
  // Option text is in the DOM even when the list is closed (an option of a closed select has no box, so the walk above skipped it).
  for (const select of document.body.querySelectorAll('select')) {
    if (!shown(select, select.getBoundingClientRect(), getComputedStyle(select))) continue;
    const bidi = { direction: getComputedStyle(select).direction, isolated: false };
    for (const option of select.querySelectorAll('option')) {
      if (option.getBoundingClientRect().width > 0) continue; // an open list box was walked above
      for (const text of ownTexts(option).slice(0, MAX_TEXTS_PER_ELEMENT)) texts.push({ element: `${label(select)} option`, text: text.slice(0, MAX_TEXT_LENGTH), visible: true, inCode: true, keepLatin: keepsLatin(option), ...bidi });
    }
  }
  // Last, because it touches the page: an empty field is judged on its filled state, so give it a value, read the direction, put it back.
  if (probes.length > 0) {
    const swallow = (event) => event.stopImmediatePropagation();
    window.addEventListener('selectionchange', swallow, true);
    setTimeout(() => window.removeEventListener('selectionchange', swallow, true), SELECTION_GUARD_MS);
    for (const { el, fact } of probes) {
      const setValue = Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set; // not the instance setter a framework may wrap
      setValue.call(el, PROBE_VALUE);
      fact.direction = el.value === PROBE_VALUE ? getComputedStyle(el).direction : null;
      setValue.call(el, '');
    }
  }
  return { scrollWidth: root.scrollWidth, clientWidth: vw, findings, docDirection: getComputedStyle(root).direction, fields, texts, blocks, inlineTargets };
}
