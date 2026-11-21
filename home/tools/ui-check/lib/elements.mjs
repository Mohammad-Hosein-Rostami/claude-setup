// Purpose: compare measured DOM boxes/styles to the flattened Figma spec (the element gate).
// Exports: compareElements, applySkips, SKIP_PROPS, parseColor, brokenImageRows. Invariants: pure; only props present in the spec are checked (font-family,
// stroke width and colour by stroke align, image fills: r9-ui-rules G3, G4, M1);
// a missing element is one failing row; a colour in an unknown format is skipped, not failed.
import { TOLERANCE } from './tolerances.mjs';

const fmt = (v) => (typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v));

/**
 * Parse "rgb(r, g, b)" / "rgba(r, g, b, a)" (comma or space syntax) / "transparent" to [r, g, b, a].
 * @param {string} css a computed or spec colour
 * @returns {number[] | null} null when the format is unknown (oklch, color(), lab...): never guess channels
 */
export function parseColor(css) {
  if (!css || css === 'transparent') return [0, 0, 0, 0];
  const body = /^rgba?\(([^)]*)\)$/i.exec(css.trim())?.[1];
  if (body === undefined) return null;
  const parts = body.trim().split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const nums = parts.map((p) => (p.endsWith('%') ? Number(p.slice(0, -1)) / 100 : Number(p)));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return [nums[0], nums[1], nums[2], nums[3] ?? 1];
}

function numberRow(label, prop, is, should, tolerance) {
  const delta = is - should;
  return Math.abs(delta) > tolerance ? { element: label, prop, is: fmt(is), should: fmt(should), delta: fmt(delta) } : null;
}

function colorRow(label, prop, is, should) {
  const a = parseColor(is);
  const b = parseColor(should);
  if (!a || !b) return null; // unknown colour format: not comparable, so never a false FAIL
  const off = a.slice(0, 3).some((v, i) => Math.abs(v - b[i]) > TOLERANCE.colorChannel) || Math.abs(a[3] - b[3]) > TOLERANCE.colorAlpha;
  return off ? { element: label, prop, is, should, delta: 'colour' } : null;
}

function boxRows(label, spec, box) {
  return ['x', 'y', 'w', 'h'].map((k) => numberRow(label, k, box[k], spec[k], TOLERANCE.box));
}

function textRows(label, style, css) {
  const rows = [
    style.fontSize === undefined ? null : numberRow(label, 'font-size', css.fontSize, style.fontSize, TOLERANCE.fontSize),
    style.fontWeight === undefined ? null : numberRow(label, 'font-weight', css.fontWeight, style.fontWeight, 0),
    style.letterSpacing === undefined ? null : numberRow(label, 'letter-spacing', css.letterSpacing, style.letterSpacing, TOLERANCE.letterSpacing),
    style.color === undefined ? null : colorRow(label, 'color', css.color, style.color),
  ];
  if (style.lineHeightPx === undefined) return [...rows, fontFamilyRow(label, style, css)];
  const lineHeight = css.lineHeight === 'normal'
    ? { element: label, prop: 'line-height', is: 'normal', should: fmt(style.lineHeightPx), delta: 'set explicitly' }
    : numberRow(label, 'line-height', css.lineHeight, style.lineHeightPx, TOLERANCE.lineHeight);
  return [...rows, lineHeight, fontFamilyRow(label, style, css)];
}

function radiusRows(label, spec, css) {
  if (spec.style.radius === undefined) return [];
  const limit = Math.min(spec.w, spec.h) / 2;
  const should = Array.isArray(spec.style.radius) ? spec.style.radius : Array(4).fill(spec.style.radius);
  return should.map((r, i) => numberRow(label, `radius[${i}]`, Math.min(css.radius[i], limit), Math.min(r, limit), TOLERANCE.radius));
}

function layoutRows(label, spec, css) {
  const { padding, gap, layoutMode } = spec.style;
  const sides = ['top', 'right', 'bottom', 'left'];
  const rows = (padding ?? []).map((v, i) => numberRow(label, `padding-${sides[i]}`, css.padding[i], v, TOLERANCE.spacing));
  if (gap === undefined) return rows;
  const is = layoutMode === 'HORIZONTAL' ? css.columnGap : css.rowGap;
  return [...rows, numberRow(label, 'gap', is, gap, TOLERANCE.spacing)];
}

const SIDES = ['top', 'right', 'bottom', 'left'];
const IMAGE_RATIO_TOLERANCE = 0.02; // 2 % between the image's natural aspect ratio and its box, for object-fit: fill (a stretched or wrong image)
const firstColor = (text) => /rgba?\([^)]*\)/.exec(text ?? '')?.[0] ?? null;
const firstFamily = (list) => String(list ?? '').split(',')[0].trim().replace(/^["']|["']$/g, '');
const weightsOf = (weight) => (Array.isArray(weight) ? weight : Array(SIDES.length).fill(weight));

/** INSIDE stroke = a border in border-box (or an inset box-shadow): width and colour per side. */
function insideStrokeRows(label, style, css) {
  const weights = weightsOf(style.strokeWeight);
  if (/inset/.test(css.boxShadow ?? '') && css.borderWidth.every((w) => w === 0)) return [colorRow(label, 'border-color (inset box-shadow)', firstColor(css.boxShadow), style.stroke)];
  return weights.flatMap((w, i) => [numberRow(label, `border-${SIDES[i]}-width (INSIDE stroke)`, css.borderWidth[i], w, TOLERANCE.box), w > 0 ? colorRow(label, `border-${SIDES[i]}-color`, css.borderColor[i], style.stroke) : null]);
}

/** OUTSIDE (outline or box-shadow ring) and CENTER (outline with offset -weight/2) strokes: the box excludes them, so a CSS border is a failing width row. */
function outerStrokeRows(label, style, css) {
  const weight = Math.max(...weightsOf(style.strokeWeight));
  const bordered = css.borderWidth.map((w, i) => (w > 0 ? { element: label, prop: `border-${SIDES[i]}-width (${style.strokeAlign} stroke)`, is: fmt(w), should: '0 (an outline or box-shadow; the box size excludes the stroke)', delta: fmt(w) } : null));
  if (css.outline.width > 0) {
    const offset = style.strokeAlign === 'CENTER' ? -weight / 2 : 0;
    return [...bordered, numberRow(label, 'outline-width', css.outline.width, weight, TOLERANCE.spacing), numberRow(label, 'outline-offset', css.outline.offset, offset, TOLERANCE.spacing), colorRow(label, 'outline-color', css.outline.color, style.stroke)];
  }
  const ring = style.strokeAlign === 'OUTSIDE' ? firstColor(css.boxShadow) : null;
  if (ring) return [...bordered, colorRow(label, 'box-shadow ring colour', ring, style.stroke)];
  return [...bordered, { element: label, prop: `${style.strokeAlign} stroke`, is: 'none', should: `outline ${fmt(weight)}px ${style.stroke}`, delta: '-' }];
}

/** M1: the Figma stroke against the built border / outline, with the colour tolerance (standards/figma.md Figma-to-CSS table). */
function strokeRows(label, style, css) {
  if (style.stroke === undefined) return [];
  return style.strokeAlign === 'INSIDE' ? insideStrokeRows(label, style, css) : outerStrokeRows(label, style, css);
}

/** G4: a node with a Figma IMAGE fill must show a loaded image of the right shape. */
function imageRows(label, spec, css) {
  if (!spec.style.image) return [];
  const img = css.image;
  if (img.tag !== 'img') return img.background && img.background !== 'none' ? [] : [{ element: label, prop: 'image', is: 'none', should: 'an image (Figma IMAGE fill)', delta: '-' }];
  if (!img.loaded) return [{ element: label, prop: 'image', is: 'not loaded', should: 'loaded', delta: '-' }];
  if (img.objectFit !== 'fill' || !(spec.w > 0 && spec.h > 0)) return [];
  const ratio = img.natural[0] / img.natural[1] / (spec.w / spec.h);
  return Math.abs(ratio - 1) > IMAGE_RATIO_TOLERANCE ? [{ element: label, prop: 'image aspect', is: `${img.natural.join('x')} natural`, should: `${fmt(spec.w)}x${fmt(spec.h)} box`, delta: fmt(ratio) }] : [];
}

/** G3: the first family of the computed font-family must be Figma's (case aside). */
function fontFamilyRow(label, style, css) {
  if (style.fontFamily === undefined) return null;
  const is = firstFamily(css.fontFamily);
  return is.toLowerCase() === style.fontFamily.toLowerCase() ? null : { element: label, prop: 'font-family', is: is || css.fontFamily, should: style.fontFamily, delta: 'family' };
}

/**
 * G4: one failing row per broken eager image in the root, mapped or not.
 * @param {string[]} sources measureInPage `brokenImages`
 * @returns {{element: string, prop: string, is: string, should: string, delta: string}[]}
 */
export const brokenImageRows = (sources = []) => sources.map((src) => ({ element: `img ${src}`, prop: 'image', is: 'broken', should: 'loaded', delta: '-' }));

function boxStyleRows(label, spec, css) {
  const background = spec.style.background === undefined ? null : colorRow(label, 'background', css.backgroundColor, spec.style.background);
  return [background, ...radiusRows(label, spec, css), ...layoutRows(label, spec, css), ...strokeRows(label, spec.style, css), ...imageRows(label, spec, css)];
}

/**
 * Compare measured elements with the spec.
 * @param {object[]} nodes spec.json nodes
 * @param {Record<string, string>} map figmaId -> CSS selector
 * @param {object[]} measured results of measureInPage
 * @returns {{element: string, prop: string, is: string, should: string, delta: string}[]} failing rows only
 */
export function compareElements(nodes, map, measured) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const rows = [];
  for (const m of measured) {
    const spec = byId.get(m.id);
    const label = `${spec.name} (${map[m.id]})`;
    if (!m.found) {
      rows.push({ element: label, prop: 'element', is: 'missing', should: 'present', delta: '-' });
      continue;
    }
    const style = spec.type === 'TEXT' ? textRows(label, spec.style, m.css) : boxStyleRows(label, spec, m.css);
    rows.push(...[...boxRows(label, spec, m.box), ...style].filter(Boolean).map((row) => ({ ...row, id: m.id })));
  }
  return rows.filter(Boolean);
}

/** Map skip props (P3c) to the element-row props they remove: padding, gap and hug width only. */
export const SKIP_PROPS = Object.freeze({ padding: (prop) => prop.startsWith('padding-'), gap: (prop) => prop === 'gap', width: (prop) => prop === 'w' });

/**
 * Apply map skip entries: a skipped row becomes a SKIPPED row (shown, never failing). A `width` skip is honoured only in a strict run;
 * in a default run the row stays, with its `why` beside it (spec.json holds no Figma sizing, and the 0.5 % pixel rule does not back it).
 * @param {object[]} rows failing rows of compareElements (each has `id`)
 * @param {Record<string, {props: string[], why: string}>} skips per Figma node id
 * @param {boolean} strict the strict rule is in force
 * @returns {{rows: object[], skipped: object[]}}
 */
export function applySkips(rows, skips, strict) {
  const kept = [];
  const skipped = [];
  for (const row of rows) {
    const skip = skips?.[row.id];
    const hit = skip?.props.find((name) => SKIP_PROPS[name](row.prop));
    if (!hit) kept.push(row);
    else if (hit === 'width' && !strict) kept.push({ ...row, delta: `${row.delta} (width skip honoured only under --strict: ${skip.why})` });
    else skipped.push({ ...row, delta: `SKIPPED: ${skip.why}` });
  }
  return { rows: kept, skipped };
}
