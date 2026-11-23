// Purpose: read the fonts Chromium actually drew for mapped text elements (G3: the font on screen, not only the font asked for).
// Exports: readDrawnFonts. Invariants: reads only, through a CDP session that is detached before it returns; every glyph of the
// element is counted (each text node and pseudo-element below it, open and user-agent shadow roots included, read one by one:
// CSS.getPlatformFontsForNode itself looks only two layout levels down, so h1>a>span text came back empty); an element with no text
// (an empty field, an image) gets {fonts: [], noText: true}; an element whose drawn fonts cannot be read gets {unknown: why}, so the
// element gate shows "not checked (why)" and never a pass.
// CDP `CSS.getPlatformFontsForNode` is the only source. The Font Loading API is not a fallback: `document.fonts.check()` answers true
// for a family that is neither installed nor loaded (probe, Playwright 1.62.1 / Chromium 151 on macOS: "Roboto" missing, the text drawn
// in Helvetica, check() true), so it cannot tell a fallback from the real font.

/**
 * The element measureInPage measures for this selector (the same lookup; measureInPage must stay self-contained, so it is repeated here).
 * @param {string} rootSelector compare --root
 * @param {string} selector map selector
 * @returns {string} a page expression that yields the element or null
 */
function lookupExpression(rootSelector, selector) {
  const root = JSON.stringify(rootSelector);
  const own = JSON.stringify(selector);
  return `(() => { const root = document.querySelector(${root}); if (!root) return null; return root.matches(${own}) ? root : root.querySelector(${own}) ?? document.querySelector(${own}); })()`;
}

const TEXT_NODE = 3;
const PIERCE_ALL = { depth: -1, pierce: true }; // DOM.describeNode: the whole subtree, open and user-agent shadow roots included
const NO_TEXT_ELEMENTS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']); // their text is never drawn, so it is not the element's text

/**
 * The nodes that can draw the element's glyphs, from a DOM.describeNode tree: each text node with more than white space and each
 * pseudo-element (::before, ::after, ::marker: generated text has no DOM text node). Children, shadow roots (open and the browser's
 * own, which hold a field's value and placeholder) and pseudo-elements are all followed, so a node that is not drawn (an unslotted
 * child, a textarea's source text) simply reads no font, and each drawn glyph is counted once. Frames are not entered.
 * @param {object} root DOM.Node
 * @returns {{text: object[], pseudo: object[]}} DOM.Node lists
 */
function glyphSources(root) {
  const text = [];
  const pseudo = [];
  const walk = (node) => {
    if (node.nodeType === TEXT_NODE) {
      if (node.nodeValue.trim() !== '') text.push(node);
      return;
    }
    if (NO_TEXT_ELEMENTS.has(node.nodeName)) return;
    pseudo.push(...(node.pseudoElements ?? []));
    for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) walk(child);
  };
  walk(root);
  return { text, pseudo };
}

const firstLine = (error) => String(error?.message ?? error).split('\n')[0];

/** Glyphs summed per drawn family over all nodes, in the order the families were first seen. */
function sumByFamily(perNode) {
  const totals = new Map();
  for (const { familyName, glyphCount } of perNode.flat()) totals.set(familyName, (totals.get(familyName) ?? 0) + glyphCount);
  return [...totals].map(([family, glyphs]) => ({ family, glyphs }));
}

/**
 * Drawn fonts of one mapped element. Each source node is read on its own (CSS.getPlatformFontsForNode looks only two layout levels
 * below the node it is given, so reading the element itself missed h1>a>span text and a textarea's value); a text node has no layout
 * children and a pseudo-element no DOM children, so no glyph is read twice.
 */
async function fontsOf(cdp, rootSelector, selector) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression: lookupExpression(rootSelector, selector) });
  if (exceptionDetails) return { unknown: `element lookup failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}` };
  if (!result.objectId) return { unknown: 'element not found for the font read' };
  const { node } = await cdp.send('DOM.describeNode', { objectId: result.objectId, ...PIERCE_ALL });
  const { text, pseudo } = glyphSources(node);
  const backendNodeIds = [...text, ...pseudo].map((source) => source.backendNodeId);
  const { nodeIds } = await cdp.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds });
  const perNode = await Promise.all(nodeIds.map(async (nodeId) => (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts));
  const fonts = sumByFamily(perNode);
  return fonts.length === 0 && text.length === 0 ? { fonts, noText: true } : { fonts }; // text that drew nothing is "no glyph drawn"
}

async function readEach(cdp, rootSelector, items) {
  const entries = [];
  for (const { id, selector } of items) {
    try {
      entries.push([id, await fontsOf(cdp, rootSelector, selector)]);
    } catch (error) {
      entries.push([id, { unknown: `CDP font read failed: ${firstLine(error)}` }]); // shown as a failing "not checked" row, not dropped
    }
  }
  return Object.fromEntries(entries);
}

/**
 * Read the platform fonts each text element was drawn with: glyph counts per font family, summed over every text node below the
 * element (a field's value or placeholder and generated content included).
 * @param {object} page Playwright page (Chromium; other engines have no CDP session)
 * @param {string} rootSelector compare --root
 * @param {{id: string, selector: string}[]} items the mapped text elements whose Figma style names a font family
 * @returns {Promise<Record<string, {fonts: {family: string, glyphs: number}[], noText?: true} | {unknown: string}>>} per Figma node id;
 *   `noText` marks an element with no text to draw (an empty field, an image), which is not judged
 */
export async function readDrawnFonts(page, rootSelector, items) {
  if (items.length === 0) return {};
  let cdp;
  try {
    cdp = await page.context().newCDPSession(page);
  } catch (error) {
    return Object.fromEntries(items.map(({ id }) => [id, { unknown: `no CDP session: ${firstLine(error)}` }]));
  }
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    await cdp.send('DOM.getDocument', { depth: 0 }); // DOM.requestNode needs the document requested first
    return await readEach(cdp, rootSelector, items);
  } finally {
    await cdp.detach();
  }
}
