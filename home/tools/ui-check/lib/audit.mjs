// Purpose: in-page responsive audit (serialised into the browser by Playwright).
// Exports: auditInPage. Invariant: must stay self-contained - no imports or closure variables, which is why
// it is one function (C3 exception: Playwright serialises it whole).

/**
 * Runs inside the page. Returns layout-invariant violations for the current viewport.
 * @param {{minTarget: number, minText: number, smallViewport: number, max: number}} cfg
 * @returns {{scrollWidth: number, clientWidth: number, findings: {check: string, element: string, detail: string}[]}}
 */
export function auditInPage(cfg) {
  const findings = [];
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
  const hasOwnText = (el) => [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
  const interactive = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=radio]';
  const vw = document.documentElement.clientWidth;
  const root = document.documentElement;
  if (root.scrollWidth > vw) add('hscroll', root, `scrollWidth ${root.scrollWidth} > viewport ${vw}`);
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (!shown(el, r, s)) continue;
    if ((r.right > vw + 1 || r.left < -1) && s.position !== 'fixed' && !clippedByAncestor(el)) {
      add('offscreen', el, `x ${Math.round(r.left)}..${Math.round(r.right)} outside 0..${vw}`);
    }
    if (hasOwnText(el)) {
      if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1 && s.textOverflow !== 'ellipsis') add('clipped-text', el, `scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`);
      if (vw < cfg.smallViewport && Number.parseFloat(s.fontSize) < cfg.minText) add('small-text', el, `${s.fontSize} < ${cfg.minText}px`);
    }
    if (el.matches(interactive) && s.display !== 'inline' && (r.width < cfg.minTarget || r.height < cfg.minTarget)) {
      add('tap-target', el, `${Math.round(r.width)}x${Math.round(r.height)} < ${cfg.minTarget}x${cfg.minTarget}`);
    }
  }
  return { scrollWidth: root.scrollWidth, clientWidth: vw, findings };
}
