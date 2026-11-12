// Purpose: in-page measurement of mapped elements (serialised into the browser by Playwright).
// Exports: measureInPage. Invariant: must stay self-contained - no imports or closure variables.

/**
 * Runs inside the page. Returns each item's box (relative to the root) and computed styles.
 * @param {{rootSelector: string, items: {id: string, selector: string}[]}} input
 */
export function measureInPage({ rootSelector, items }) {
  const root = document.querySelector(rootSelector);
  if (!root) return { rootFound: false, results: [] };
  const origin = root.getBoundingClientRect();
  const px = (v) => Number.parseFloat(v);
  let ctx = null;
  // Chrome keeps oklch()/color()/lab() in computed style; repaint on a 1x1 canvas to get sRGB bytes.
  const toRgb = (value) => {
    if (!value || value === 'transparent' || value.startsWith('rgb')) return value;
    try {
      ctx ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 1000) / 1000})`;
    } catch {
      return value; // left raw: the comparison treats an unknown format as not comparable
    }
  };
  const measure = ({ id, selector }) => {
    const el = root.matches(selector) ? root : root.querySelector(selector) ?? document.querySelector(selector);
    if (!el) return { id, found: false };
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    const radiusPx = (v) => (v.endsWith('%') ? (px(v) / 100) * Math.min(r.width, r.height) : px(v));
    return {
      id,
      found: true,
      box: { x: r.x - origin.x, y: r.y - origin.y, w: r.width, h: r.height },
      css: {
        fontSize: px(s.fontSize),
        fontWeight: Number(s.fontWeight),
        lineHeight: s.lineHeight === 'normal' ? 'normal' : px(s.lineHeight),
        letterSpacing: s.letterSpacing === 'normal' ? 0 : px(s.letterSpacing),
        color: toRgb(s.color),
        backgroundColor: toRgb(s.backgroundColor),
        radius: [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius].map(radiusPx),
        padding: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map(px),
        rowGap: s.rowGap === 'normal' ? 0 : px(s.rowGap),
        columnGap: s.columnGap === 'normal' ? 0 : px(s.columnGap),
      },
    };
  };
  return { rootFound: true, results: items.map(measure) };
}
