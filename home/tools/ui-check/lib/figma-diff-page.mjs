// Purpose: in-page half of `figma-diff` (serialised into the browser by Playwright): list the visible texts, field texts and graphics of
// the built root, in the unit shape lib/figma-diff.mjs compares with Figma.
// Exports: collectBuiltInPage. Invariants: must stay self-contained - no imports or closure variables, which is why it is one function
// (C3 exception: Playwright serialises it whole); only what a person can see is listed (display none, visibility hidden, opacity 0,
// boxes of 1 px or less such as screen-reader-only text, closed <details>); the page is never changed; boxes are relative to the
// root's top-left (the Figma frame's origin); a unit whose centre lies outside the root is left out.

/**
 * Runs inside the page.
 * @param {{rootSelector: string}} input the state's figma root selector
 * @returns {{rootFound: boolean, units: {part: 'text'|'link'|'button'|'label'|'field'|'graphic', text: string, name?: string, where: string,
 *   box: {x: number, y: number, w: number, h: number}, context?: string, contextBox?: object}[]}} texts are as rendered (text-transform
 *   applied); context = the text of the block that holds the unit, so a line split by a link inside it still compares as one line
 */
export function collectBuiltInPage({ rootSelector }) {
  const MAX_CONTEXT_CHARS = 400;
  const MIN_VISIBLE_PX = 1;
  const INTERACTIVE = 'a[href],button,[role=button],[role=link],summary,label';
  const SKIPPED = 'script,style,noscript,template,textarea,select,option,svg';
  const NO_TEXT_INPUTS = new Set(['hidden', 'checkbox', 'radio', 'file', 'range', 'color', 'image', 'submit', 'button', 'reset']);
  const BUTTON_INPUTS = new Set(['submit', 'button', 'reset']);
  const root = document.querySelector(rootSelector);
  if (!root) return { rootFound: false, units: [] };
  const origin = root.getBoundingClientRect();
  const units = [];
  const clean = (text) => (text ?? '').replace(/\s+/g, ' ').trim();
  const where = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.classList.length ? `.${[...el.classList].slice(0, 2).join('.')}` : ''}`;
  const boxOf = (r) => ({ x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height });
  const insideRoot = (r) => {
    const [cx, cy] = [r.left + r.width / 2, r.top + r.height / 2];
    return cx >= origin.left && cx <= origin.right && cy >= origin.top && cy <= origin.bottom;
  };
  const shown = (el) => {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > MIN_VISIBLE_PX && r.height > MIN_VISIBLE_PX;
  };
  const add = (el, unit, rect = el.getBoundingClientRect()) => {
    if (insideRoot(rect)) units.push({ ...unit, where: where(el), box: boxOf(rect) });
  };
  const isInline = (el) => /^(inline|contents)/.test(getComputedStyle(el).display);
  const blockOf = (el) => {
    let block = el;
    while (block !== root && block.parentElement && isInline(block)) block = block.parentElement;
    return block;
  };
  const partOf = (el) => {
    if (el.matches('a[href],[role=link]')) return 'link';
    if (el.matches('label')) return 'label';
    return el.matches(INTERACTIVE) ? 'button' : 'text';
  };
  const transformed = (text, el) => {
    const mode = getComputedStyle(el).textTransform;
    if (mode === 'uppercase') return text.toLocaleUpperCase();
    if (mode === 'lowercase') return text.toLocaleLowerCase();
    return mode === 'capitalize' ? text.replace(/(^|\s)(\p{L})/gu, (_, space, letter) => space + letter.toLocaleUpperCase()) : text;
  };
  // Texts: one unit per interactive element (link, button, label) or per block, from the text nodes it holds.
  const runs = new Map();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !clean(node.nodeValue) || parent.closest(SKIPPED) || !shown(parent)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.width < MIN_VISIBLE_PX) continue;
    const interactive = parent.closest(INTERACTIVE);
    const owner = interactive && root.contains(interactive) ? interactive : blockOf(parent);
    const run = runs.get(owner) ?? { text: '', left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    run.text += transformed(node.nodeValue, parent);
    Object.assign(run, { left: Math.min(run.left, rect.left), top: Math.min(run.top, rect.top), right: Math.max(run.right, rect.right), bottom: Math.max(run.bottom, rect.bottom) });
    runs.set(owner, run);
  }
  for (const [owner, run] of runs) {
    const block = owner.matches(INTERACTIVE) ? blockOf(owner.parentElement ?? owner) : owner; // a link's line is the block around it
    const rect = new DOMRect(run.left, run.top, run.right - run.left, run.bottom - run.top);
    add(owner, { part: partOf(owner), text: clean(run.text), context: clean(block.innerText).slice(0, MAX_CONTEXT_CHARS), contextBox: boxOf(block.getBoundingClientRect()) }, rect);
  }
  // Fields: the typed value (never a password's), else the placeholder; a button input's value is its label; a select shows its option.
  for (const el of root.querySelectorAll('input,textarea,select')) {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    if (!shown(el) || (NO_TEXT_INPUTS.has(type) && !BUTTON_INPUTS.has(type))) continue;
    if (BUTTON_INPUTS.has(type)) add(el, { part: 'button', text: clean(el.value) });
    else if (el.tagName === 'SELECT') add(el, { part: 'field', text: clean(el.selectedOptions[0]?.textContent) });
    else add(el, { part: 'field', text: el.value && type !== 'password' ? clean(el.value) : clean(el.placeholder) });
  }
  // Graphics: images, outermost svgs, canvases, videos, and CSS pictures (background or mask image of the element or its ::before/::after).
  const fileName = (value) => (value ?? '').split('/').pop().split('?')[0];
  for (const el of root.querySelectorAll('img,svg,canvas,video')) {
    if ((el.tagName.toLowerCase() === 'svg' && el.parentElement?.closest('svg')) || !shown(el)) continue;
    add(el, { part: 'graphic', text: '', name: el.tagName === 'IMG' ? fileName(el.getAttribute('src')) : el.tagName.toLowerCase() });
  }
  const cssPicture = (style) => [style.backgroundImage, style.maskImage, style.webkitMaskImage].find((image) => /url\(/.test(image ?? ''));
  for (const el of root.querySelectorAll('*')) {
    const pseudo = ['::before', '::after'].map((name) => getComputedStyle(el, name)).find((s) => s.content !== 'none' && cssPicture(s));
    const picture = cssPicture(getComputedStyle(el)) ?? (pseudo ? cssPicture(pseudo) : undefined);
    if (picture && shown(el)) add(el, { part: 'graphic', text: '', name: `css:${fileName(picture.match(/url\("?([^")]+)/)?.[1])}` });
  }
  return { rootFound: true, units };
}
