// Purpose: in-page responsive audit (serialised into the browser by Playwright).
// Exports: auditInPage. It also gathers plain facts (visible inputs, text nodes, text blocks, small interactive elements) that lib/bidi.mjs and
// lib/rendered-checks.mjs turn into findings. Invariant: must stay self-contained - no imports or closure variables, which is why
// it is one function (C3 exception: Playwright serialises it whole).

/**
 * Runs inside the page. Returns layout-invariant violations for the current viewport.
 * @param {{minTarget: number, minText: number, smallViewport: number, max: number}} cfg
 * @returns {{scrollWidth: number, clientWidth: number, findings: {check: string, element: string, detail: string}[],
 *   docDirection: string, fields: {element: string, type: string, inputmode: string, autocomplete: string, name: string, id: string, ariaLabel: string, direction: string, visible: boolean}[],
 *   texts: {element: string, text: string, visible: boolean}[], blocks: {element: string, textAlign: string, direction: string, visible: boolean}[],
 *   targets: {element: string, width: number, height: number, display: string, siblingText: boolean}[]}}
 */
export function auditInPage(cfg) {
  const MAX_TEXT_LENGTH = 200; // a raw key is short; longer text cannot match, so it is cut to keep the facts small
  const MAX_TEXTS_PER_ELEMENT = 20;
  const findings = [];
  const fields = [];
  const texts = [];
  const blocks = [];
  const targets = [];
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
  const ownTexts = (el) => [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim()).map((n) => n.textContent.trim());
  const hasOwnText = (el) => ownTexts(el).length > 0;
  const siblingText = (el) => [...(el.parentElement?.childNodes ?? [])].some((n) => n !== el && n.nodeType === Node.TEXT_NODE && /[\p{L}\p{N}]/u.test(n.textContent));
  const interactive = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=radio]';
  const vw = document.documentElement.clientWidth;
  const root = document.documentElement;
  if (root.scrollWidth > vw) add('hscroll', root, `scrollWidth ${root.scrollWidth} > viewport ${vw}`);
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (!shown(el, r, s)) continue;
    if (el.matches('input,textarea')) {
      fields.push({ element: label(el), type: el.getAttribute('type') ?? '', inputmode: el.getAttribute('inputmode') ?? '', autocomplete: el.getAttribute('autocomplete') ?? '', name: el.getAttribute('name') ?? '', id: el.id, ariaLabel: el.getAttribute('aria-label') ?? '', direction: s.direction, visible: true });
    }
    if ((r.right > vw + 1 || r.left < -1) && s.position !== 'fixed' && !clippedByAncestor(el)) {
      add('offscreen', el, `x ${Math.round(r.left)}..${Math.round(r.right)} outside 0..${vw}`);
    }
    if (hasOwnText(el)) {
      for (const text of ownTexts(el).slice(0, MAX_TEXTS_PER_ELEMENT)) texts.push({ element: label(el), text: text.slice(0, MAX_TEXT_LENGTH), visible: true });
      if (s.display !== 'inline') blocks.push({ element: label(el), textAlign: s.textAlign, direction: s.direction, visible: true });
      if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1 && s.textOverflow !== 'ellipsis') add('clipped-text', el, `scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`);
      if (vw < cfg.smallViewport && Number.parseFloat(s.fontSize) < cfg.minText) add('small-text', el, `${s.fontSize} < ${cfg.minText}px`);
    }
    if (el.matches(interactive) && (r.width < cfg.minTarget || r.height < cfg.minTarget)) {
      targets.push({ element: label(el), width: r.width, height: r.height, display: s.display, siblingText: siblingText(el) });
    }
  }
  return { scrollWidth: root.scrollWidth, clientWidth: vw, findings, docDirection: getComputedStyle(root).direction, fields, texts, blocks, targets };
}
