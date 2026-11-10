// Purpose: flatten a Figma REST node tree into a list of boxes relative to the frame root.
// Exports: flattenSpec, colorToCss. Invariants: pure (no I/O); invisible nodes are dropped; gap prefers the gap
// derived from sibling coordinates over Figma's itemSpacing.
const TEXT_MAX_CHARS = 80;
const DECIMALS = 100;
const AUTO_LAYOUTS = new Set(['HORIZONTAL', 'VERTICAL']);

const round = (value) => Math.round(value * DECIMALS) / DECIMALS;

/** Convert a Figma colour ({r,g,b,a} in 0-1) plus fill opacity to a CSS computed-style style string. */
export function colorToCss({ r, g, b, a = 1 }, opacity = 1) {
  const channels = [r, g, b].map((v) => Math.round(v * 255));
  const alpha = round(a * opacity);
  return alpha >= 1 ? `rgb(${channels.join(', ')})` : `rgba(${channels.join(', ')}, ${alpha})`;
}

function solidFill(fills) {
  const fill = (fills ?? []).find((f) => f.type === 'SOLID' && f.visible !== false);
  return fill ? colorToCss(fill.color, fill.opacity ?? 1) : undefined;
}

function textStyle(node) {
  const s = node.style ?? {};
  return {
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    fontWeight: s.fontWeight,
    lineHeightPx: s.lineHeightPx === undefined ? undefined : round(s.lineHeightPx),
    letterSpacing: s.letterSpacing === undefined ? 0 : round(s.letterSpacing),
    color: solidFill(node.fills),
  };
}

function relativeBox(node, origin) {
  const b = node.absoluteBoundingBox;
  return { x: round(b.x - origin.x), y: round(b.y - origin.y), w: round(b.width), h: round(b.height) };
}

/** Gaps between consecutive visible children along the layout axis, from their coordinates. */
function derivedGaps(node, origin) {
  const axis = node.layoutMode === 'HORIZONTAL' ? ['x', 'w'] : ['y', 'h'];
  const boxes = (node.children ?? [])
    .filter((c) => c.visible !== false && c.absoluteBoundingBox && c.layoutPositioning !== 'ABSOLUTE')
    .map((c) => relativeBox(c, origin))
    .sort((a, b) => a[axis[0]] - b[axis[0]]);
  return boxes.slice(1).map((box, i) => round(box[axis[0]] - (boxes[i][axis[0]] + boxes[i][axis[1]])));
}

function layoutStyle(node, origin) {
  if (!AUTO_LAYOUTS.has(node.layoutMode)) return {};
  const gaps = derivedGaps(node, origin);
  const uniform = gaps.length > 0 && gaps.every((g) => Math.abs(g - gaps[0]) < 0.5);
  const spaceBetween = node.primaryAxisAlignItems === 'SPACE_BETWEEN';
  return {
    layoutMode: node.layoutMode,
    gap: spaceBetween ? undefined : (uniform ? gaps[0] : node.itemSpacing),
    figmaItemSpacing: node.itemSpacing,
    derivedGaps: gaps,
    padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].map((v) => v ?? 0),
  };
}

function boxStyle(node, origin) {
  return {
    background: solidFill(node.fills),
    radius: node.rectangleCornerRadii ?? node.cornerRadius,
    ...layoutStyle(node, origin),
  };
}

function describe(node, origin) {
  const isText = node.type === 'TEXT';
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    ...relativeBox(node, origin),
    ...(isText ? { text: (node.characters ?? '').slice(0, TEXT_MAX_CHARS), style: textStyle(node) } : { style: boxStyle(node, origin) }),
  };
}

function walk(node, origin, out) {
  if (node.visible === false) return;
  if (node.absoluteBoundingBox) out.push(describe(node, origin));
  for (const child of node.children ?? []) walk(child, origin, out);
}

/**
 * Flatten a Figma node document into root info plus a flat child list.
 * @param {object} document Figma REST node ("document" of /v1/files/:key/nodes)
 * @returns {{root: {id: string, name: string, w: number, h: number}, nodes: object[]}} x/y/w/h are relative to the root
 * @throws {Error} when the node has no absoluteBoundingBox
 */
export function flattenSpec(document) {
  const box = document.absoluteBoundingBox;
  if (!box) throw new Error(`node ${document.id} has no absoluteBoundingBox (not a visible frame?)`);
  const origin = { x: box.x, y: box.y };
  const nodes = [];
  walk(document, origin, nodes);
  return { root: { id: document.id, name: document.name, w: round(box.width), h: round(box.height) }, nodes };
}
