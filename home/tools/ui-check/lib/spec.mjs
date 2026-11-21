// Purpose: flatten a Figma REST node tree into a list of boxes relative to the frame root.
// Exports: flattenSpec, colorToCss. Invariants: pure (no I/O); invisible nodes are dropped; a TEXT node keeps its full
// characters (figma-diff compares whole wordings; a cut text would hide a difference after the cut); gap prefers the gap
// derived from sibling coordinates over Figma's itemSpacing. Each node keeps absoluteBoundingBox (x, y, w, h) and absoluteRenderBounds
// (`render`), and box nodes their stroke (colour, align, weight), effects (type, radius, spread, offset) and image fill.
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
    // A single child has no gap (Figma keeps a stale itemSpacing), so only assert it with 2+ children.
    gap: spaceBetween || gaps.length === 0 ? undefined : (uniform ? gaps[0] : node.itemSpacing),
    figmaItemSpacing: node.itemSpacing,
    derivedGaps: gaps,
    padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].map((v) => v ?? 0),
  };
}

/** The node's visible stroke: colour, align (INSIDE, OUTSIDE, CENTER) and weight (per side when Figma gives individual weights). */
function strokeStyle(node) {
  const color = solidFill(node.strokes);
  if (color === undefined) return {};
  const sides = node.individualStrokeWeights;
  const weight = sides ? [sides.top, sides.right, sides.bottom, sides.left] : node.strokeWeight;
  return { stroke: color, strokeAlign: node.strokeAlign ?? 'INSIDE', strokeWeight: weight ?? 1 };
}

/** Visible effects with their radii (blur), spread and offset, so a shadow or blur can be sized in CSS (standards/figma.md). */
function effectsOf(node) {
  const effects = (node.effects ?? []).filter((e) => e.visible !== false);
  if (effects.length === 0) return {};
  return { effects: effects.map((e) => ({ type: e.type, radius: e.radius ?? 0, spread: e.spread ?? 0, offset: e.offset ?? null, color: e.color ? colorToCss(e.color) : undefined })) };
}

const hasImageFill = (node) => (node.fills ?? []).some((f) => f.type === 'IMAGE' && f.visible !== false);

function boxStyle(node, origin) {
  return {
    background: solidFill(node.fills),
    radius: node.rectangleCornerRadii ?? node.cornerRadius,
    ...(hasImageFill(node) ? { image: true } : {}),
    ...strokeStyle(node),
    ...effectsOf(node),
    ...layoutStyle(node, origin),
  };
}

/** The painted area (absoluteRenderBounds: strokes outside, shadows, blur included) relative to the root; null when Figma gives none. */
function renderBox(node, origin) {
  const b = node.absoluteRenderBounds;
  return b ? { x: round(b.x - origin.x), y: round(b.y - origin.y), w: round(b.width), h: round(b.height) } : null;
}

function describe(node, origin) {
  const isText = node.type === 'TEXT';
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    ...relativeBox(node, origin),
    render: renderBox(node, origin),
    ...(isText ? { text: node.characters ?? '', style: textStyle(node) } : { style: boxStyle(node, origin) }),
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
 * @returns {{root: {id: string, name: string, w: number, h: number, render: object|null}, nodes: object[]}} x/y/w/h (absoluteBoundingBox) are relative
 *   to the root; `render` keeps absoluteRenderBounds beside it (null when absent); box nodes carry stroke, strokeAlign, strokeWeight, effects
 *   and image (an IMAGE fill) in `style` when Figma has them
 * @throws {Error} when the node has no absoluteBoundingBox
 */
export function flattenSpec(document) {
  const box = document.absoluteBoundingBox;
  if (!box) throw new Error(`node ${document.id} has no absoluteBoundingBox (not a visible frame?)`);
  const origin = { x: box.x, y: box.y };
  const nodes = [];
  walk(document, origin, nodes);
  return { root: { id: document.id, name: document.name, w: round(box.width), h: round(box.height), render: renderBox(document, origin) }, nodes };
}
