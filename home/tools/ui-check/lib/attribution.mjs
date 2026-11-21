// Purpose: attribute the colour metric's leftover pixels of one compare to the topmost Figma node and a class: accepted, text
// anti-aliasing, flagged text (displaced or ink change), graphic, other; plus the clusters the crops are cut around. Ported and cut
// from the ICE harness (diff-attribution.mjs and attribution/: geometry, text-metrics, clusters, attribute).
// Exports: CLASSES, CLASS_LABELS, MIN_TEXT_DIFF_PX, textScopeBoxes, leftoverPixels, attributePixels, acceptedBox.
// Invariants: pure (no files). A pixel index is y * width + x into two PNGs of the same size. The leftover metric is the colour metric
// of lib/pixels.mjs colorDrift (any RGBA channel off by more than 2 levels, anti-aliasing counted); the caller checks the recount
// against the record, so a drift between the two copies fails closed (exit 2). spec.json lists nodes in paint order (parents first,
// later siblings on top), so the LAST node whose box holds a pixel owns it. Accepted pixels are counted apart and never measured as
// text or clustered. Every pixel gets exactly one class, so the class counts add up to the pixel count.

/** The classes in report order. */
export const CLASSES = ['accepted', 'text-aa', 'text-flagged', 'graphic', 'other'];
export const CLASS_LABELS = Object.freeze({ accepted: 'accepted', 'text-aa': 'text anti-aliasing', 'text-flagged': 'flagged text', graphic: 'graphic', other: 'other' });
/** A text box needs at least this many leftover device px before it is measured; fewer is anti-aliasing. */
export const MIN_TEXT_DIFF_PX = 20;

const CHANNELS = 4;
const RGB = 3;
const OPAQUE = 255;
const CHANNEL_DELTA = 2; // same as lib/pixels.mjs DRIFT_CHANNEL_DELTA
const TEXT_DILATE_CSS = 2; // CSS px a TEXT box grows by, so glyph anti-aliasing just outside it is still text
const GRAPHIC_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'ELLIPSE', 'LINE', 'STAR', 'REGULAR_POLYGON']);
const MAX_SHIFT = 2; // device px a text box may be displaced by and still be found
const INK_RANGE = Object.freeze({ min: 0.97, max: 1.03 }); // ink of the actual text over the baseline's, outside = an ink change
const LUMA = [0.299, 0.587, 0.114];
const CLUSTER_DILATE = 2; // device px: pixels this close join one cluster
const TOP_CLUSTERS = 10;
const TOP_NODES = 5;
const OUTSIDE = '(outside every Figma node)';

/**
 * The Figma TEXT boxes a default-rule colour metric leaves out, in device px, exactly as commands/compare.mjs builds them.
 * @param {object[]} nodes spec.json nodes (CSS px relative to the root)
 * @param {number} scale device pixel ratio
 * @returns {{x: number, y: number, w: number, h: number}[]}
 */
export const textScopeBoxes = (nodes, scale) => nodes.filter((n) => n.type === 'TEXT').map((n) => ({ x: Math.floor(n.x * scale), y: Math.floor(n.y * scale), w: Math.ceil(n.w * scale), h: Math.ceil(n.h * scale) }));

const insideAny = (x, y, boxes) => boxes.some((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);

function channelOff(base, actual, offset) {
  for (let c = 0; c < CHANNELS; c += 1) if (Math.abs(base.data[offset + c] - actual.data[offset + c]) > CHANNEL_DELTA) return true;
  return false;
}

/**
 * The leftover pixels of the colour metric: every one, and those outside `excluded` (the default rule's scope).
 * @param {object} base PNG
 * @param {object} actual PNG of the same size
 * @param {{x: number, y: number, w: number, h: number}[]} excluded boxes left out of `outside` (textScopeBoxes)
 * @returns {{every: number[], outside: number[]}} pixel indices
 */
export function leftoverPixels(base, actual, excluded) {
  const every = [];
  const outside = [];
  for (let y = 0; y < base.height; y += 1) {
    for (let x = 0; x < base.width; x += 1) {
      const idx = y * base.width + x;
      if (!channelOff(base, actual, idx * CHANNELS)) continue;
      every.push(idx);
      if (!insideAny(x, y, excluded)) outside.push(idx);
    }
  }
  return { every, outside };
}

/** Integer, end-exclusive device box of a node (at least 1 px wide), moved by `offset` and grown by `grow` device px. */
function deviceBox(node, { scale, offset }, grow = 0) {
  const x0 = Math.floor(node.x * scale);
  const y0 = Math.floor(node.y * scale);
  const x1 = Math.max(Math.ceil((node.x + node.w) * scale), x0 + 1);
  const y1 = Math.max(Math.ceil((node.y + node.h) * scale), y0 + 1);
  return { x0: x0 + offset.x - grow, y0: y0 + offset.y - grow, x1: x1 + offset.x + grow, y1: y1 + offset.y + grow };
}

const kindOf = (node) => {
  if (node.type === 'TEXT') return 'text';
  return GRAPHIC_TYPES.has(node.type) || node.style?.image === true ? 'graphic' : 'other';
};

/** One region per spec node in paint order: TEXT is text, a vector shape or an IMAGE fill is graphic, the rest is other. */
function buildRegions(nodes, place) {
  return nodes.map((node) => {
    const kind = kindOf(node);
    return { node, kind, box: deviceBox(node, place, kind === 'text' ? Math.ceil(TEXT_DILATE_CSS * place.scale) : 0) };
  });
}

/** owner[idx] = index of the topmost region holding the pixel, or -1; later regions paint over earlier ones. */
function buildOwnerMap(regions, width, height) {
  const owner = new Int32Array(width * height).fill(-1);
  regions.forEach(({ box }, i) => {
    for (let y = Math.max(0, box.y0); y < Math.min(height, box.y1); y += 1) owner.fill(i, y * width + Math.max(0, box.x0), y * width + Math.min(width, box.x1));
  });
  return owner;
}

const labelOf = (node) => (node ? `${node.name} (${node.id})` : OUTSIDE);
const inBox = (box, x, y) => x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1;

/** The accepted entry's reason for a pixel, or null: an entry without nodes covers every pixel. */
function acceptedReason(accepted, x, y) {
  if (accepted.all !== null) return accepted.all;
  return accepted.boxes.find(({ box }) => inBox(box, x, y))?.reason ?? null;
}

const bump = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

/** Split the pixels into accepted (by reason), text (by region) and graphic / other (indices, and px by node label). */
function splitPixels(pixels, { regions, owner, accepted, width }) {
  const split = { acceptedBy: new Map(), textPx: new Map(), spatial: { graphic: [], other: [] }, byNode: { graphic: new Map(), other: new Map() } };
  for (const idx of pixels) {
    const x = idx % width;
    const reason = acceptedReason(accepted, x, (idx - x) / width);
    const region = owner[idx] < 0 ? null : regions[owner[idx]];
    if (reason !== null) bump(split.acceptedBy, reason);
    else if (region?.kind === 'text') bump(split.textPx, region);
    else {
      const kind = region?.kind ?? 'other';
      split.spatial[kind].push(idx);
      bump(split.byNode[kind], labelOf(region?.node));
    }
  }
  return split;
}

/** Luma of a pixel composited over white (a translucent Figma fill is judged by what it looks like). */
function luma(png, x, y) {
  const o = (y * png.width + x) * CHANNELS;
  const alpha = png.data[o + RGB] / OPAQUE;
  return LUMA.reduce((sum, weight, c) => sum + weight * (png.data[o + c] * alpha + OPAQUE * (1 - alpha)), 0);
}

function shiftedSad(base, actual, region, [dx, dy]) {
  let sad = 0;
  for (let y = region.y0; y < region.y1; y += 1) {
    for (let x = region.x0; x < region.x1; x += 1) sad += Math.abs(luma(actual, x + dx, y + dy) - luma(base, x, y));
  }
  return sad;
}

/** The integer shift (dx, dy within MAX_SHIFT) that moves the actual text onto the baseline best; (0, 0) wins ties. */
function bestShift(base, actual, region) {
  let best = { shift: [0, 0], sad: shiftedSad(base, actual, region, [0, 0]) };
  for (let dy = -MAX_SHIFT; dy <= MAX_SHIFT; dy += 1) {
    for (let dx = -MAX_SHIFT; dx <= MAX_SHIFT; dx += 1) {
      const sad = shiftedSad(base, actual, region, [dx, dy]);
      if (sad < best.sad) best = { shift: [dx, dy], sad };
    }
  }
  return best.shift;
}

function inkSum(png, region) {
  let sum = 0;
  for (let y = region.y0; y < region.y1; y += 1) for (let x = region.x0; x < region.x1; x += 1) sum += OPAQUE - luma(png, x, y);
  return sum;
}

/** Judge one text box: flagged when it is displaced (best shift not 0, 0) or its ink leaves INK_RANGE. */
function measureText(base, actual, box) {
  const region = { x0: Math.max(box.x0, MAX_SHIFT), y0: Math.max(box.y0, MAX_SHIFT), x1: Math.min(box.x1, base.width - MAX_SHIFT), y1: Math.min(box.y1, base.height - MAX_SHIFT) };
  if (region.x1 <= region.x0 || region.y1 <= region.y0) return { shift: [0, 0], inkRatio: 1, flagged: false };
  const shift = bestShift(base, actual, region);
  const baseInk = inkSum(base, region);
  const actualInk = inkSum(actual, region);
  const inkRatio = baseInk === 0 ? (actualInk === 0 ? 1 : Infinity) : actualInk / baseInk;
  return { shift, inkRatio, flagged: shift[0] !== 0 || shift[1] !== 0 || inkRatio < INK_RANGE.min || inkRatio > INK_RANGE.max };
}

/** Each text region with leftover px: anti-aliasing below MIN_TEXT_DIFF_PX, else measured. Biggest first. */
function judgeText(textPx, base, actual) {
  return [...textPx].map(([region, px]) => {
    const judged = px < MIN_TEXT_DIFF_PX ? { shift: [0, 0], inkRatio: 1, flagged: false } : measureText(base, actual, region.box);
    return { label: labelOf(region.node), text: region.node.text ?? '', px, box: region.box, ...judged };
  }).sort((a, b) => b.px - a.px);
}

/** Mark every pixel within CLUSTER_DILATE of a leftover pixel; only the original pixels are counted and boxed. */
function markDilated(indices, width, height) {
  const dilated = new Uint8Array(width * height);
  for (const idx of indices) {
    const x = idx % width;
    const y = (idx - x) / width;
    for (let yy = Math.max(0, y - CLUSTER_DILATE); yy <= Math.min(height - 1, y + CLUSTER_DILATE); yy += 1) {
      dilated.fill(1, yy * width + Math.max(0, x - CLUSTER_DILATE), yy * width + Math.min(width - 1, x + CLUSTER_DILATE) + 1);
    }
  }
  return dilated;
}

/** Flood one 8-connected component of the dilated mask from `start` with `label`. */
function floodLabel(start, label, { dilated, labels, width, height }) {
  const stack = [start];
  labels[start] = label;
  while (stack.length > 0) {
    const idx = stack.pop();
    const x = idx % width;
    const y = (idx - x) / width;
    for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy += 1) {
      for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx += 1) {
        const next = yy * width + xx;
        if (!dilated[next] || labels[next]) continue;
        labels[next] = label;
        stack.push(next);
      }
    }
  }
}

/** Clusters of pixel indices after a CLUSTER_DILATE dilation, biggest first: {px, box: {x, y, w, h}} in device px. */
function clusterPixels(indices, width, height) {
  const grid = { dilated: markDilated(indices, width, height), labels: new Int32Array(width * height), width, height };
  let next = 0;
  for (const idx of indices) if (!grid.labels[idx]) floodLabel(idx, (next += 1), grid);
  const byLabel = new Map();
  for (const idx of indices) {
    const x = idx % width;
    const y = (idx - x) / width;
    const c = byLabel.get(grid.labels[idx]) ?? { px: 0, x0: x, y0: y, x1: x, y1: y };
    byLabel.set(grid.labels[idx], { px: c.px + 1, x0: Math.min(c.x0, x), y0: Math.min(c.y0, y), x1: Math.max(c.x1, x), y1: Math.max(c.y1, y) });
  }
  return [...byLabel.values()].map((c) => ({ px: c.px, box: { x: c.x0, y: c.y0, w: c.x1 - c.x0 + 1, h: c.y1 - c.y0 + 1 } })).sort((a, b) => b.px - a.px);
}

const topNodes = (map) => [...map].map(([label, px]) => ({ label, px })).sort((a, b) => b.px - a.px).slice(0, TOP_NODES);

/** Per class: the px count and its top nodes (accepted: its reasons; text: its text boxes). */
function classRows(split, texts) {
  const textOf = (flagged) => texts.filter((t) => t.flagged === flagged);
  const textNodes = (list) => list.slice(0, TOP_NODES).map(({ label, px }) => ({ label, px }));
  const sum = (list) => list.reduce((total, t) => total + t.px, 0);
  return {
    accepted: { px: [...split.acceptedBy.values()].reduce((total, px) => total + px, 0), nodes: topNodes(split.acceptedBy) },
    'text-aa': { px: sum(textOf(false)), nodes: textNodes(textOf(false)) },
    'text-flagged': { px: sum(textOf(true)), nodes: textNodes(textOf(true)) },
    graphic: { px: split.spatial.graphic.length, nodes: topNodes(split.byNode.graphic) },
    other: { px: split.spatial.other.length, nodes: topNodes(split.byNode.other) },
  };
}

/**
 * Attribute the leftover pixels of one compare.
 * @param {{base: object, actual: object, pixels: number[], nodes: object[]}} images PNGs of one size, the pixel indices to class
 *   (leftoverPixels) and the spec.json nodes in paint order
 * @param {{scale: number, offset: {x: number, y: number}}} place device pixel ratio and where the node origin sits in the image
 * @param {{all: string|null, boxes: {box: {x0: number, y0: number, x1: number, y1: number}, reason: string}[]}} accepted `all` = the
 *   reason of an entry that covers every pixel; boxes are device px, end-exclusive
 * @returns {{total: number, classes: Record<string, {px: number, nodes: {label: string, px: number}[]}>, flaggedText: object[], clusters: object[]}}
 *   clusters are graphic and other clusters ({class, px, box}), the biggest TOP_CLUSTERS; flaggedText the flagged text boxes
 */
export function attributePixels({ base, actual, pixels, nodes }, place, accepted) {
  const { width, height } = base;
  const regions = buildRegions(nodes, place);
  const split = splitPixels(pixels, { regions, owner: buildOwnerMap(regions, width, height), accepted, width });
  const texts = judgeText(split.textPx, base, actual);
  const clusters = ['graphic', 'other'].flatMap((kind) => clusterPixels(split.spatial[kind], width, height).map((c) => ({ class: kind, ...c })));
  return { total: pixels.length, classes: classRows(split, texts), flaggedText: texts.filter((t) => t.flagged), clusters: clusters.sort((a, b) => b.px - a.px).slice(0, TOP_CLUSTERS) };
}

/** Device box of a node for an accepted entry (TEXT grown like its text region). @returns {{x0: number, y0: number, x1: number, y1: number}} */
export const acceptedBox = (node, place) => buildRegions([node], place)[0].box;
