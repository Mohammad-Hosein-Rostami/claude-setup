// Purpose: read the fonts Chromium actually drew for mapped text elements (G3: the font on screen, not only the font asked for).
// Exports: readDrawnFonts. Invariants: reads only, through a CDP session that is detached before it returns; an element whose drawn
// fonts cannot be read gets {unknown: why}, so the element gate shows "not checked (why)" and never a pass.
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

const firstLine = (error) => String(error?.message ?? error).split('\n')[0];

async function fontsOf(cdp, rootSelector, selector) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression: lookupExpression(rootSelector, selector) });
  if (exceptionDetails) return { unknown: `element lookup failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}` };
  if (!result.objectId) return { unknown: 'element not found for the font read' };
  const { nodeId } = await cdp.send('DOM.requestNode', { objectId: result.objectId });
  const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
  return { fonts: fonts.map(({ familyName, glyphCount }) => ({ family: familyName, glyphs: glyphCount })) };
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
 * Read the platform fonts each text element was drawn with (the element and its descendants' text, glyph counts per font).
 * @param {object} page Playwright page (Chromium; other engines have no CDP session)
 * @param {string} rootSelector compare --root
 * @param {{id: string, selector: string}[]} items the mapped text elements whose Figma style names a font family
 * @returns {Promise<Record<string, {fonts: {family: string, glyphs: number}[]} | {unknown: string}>>} per Figma node id
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
