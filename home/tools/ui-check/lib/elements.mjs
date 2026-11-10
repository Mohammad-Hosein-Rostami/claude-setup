// Purpose: compare measured DOM boxes/styles to the flattened Figma spec (the element gate).
// Exports: compareElements, parseColor. Invariants: pure; only props present in the spec are checked;
// a missing element is one failing row.
import { TOLERANCE } from './tolerances.mjs';

const fmt = (v) => (typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v));

/** Parse "rgb(r, g, b)" / "rgba(r, g, b, a)" / "transparent" to [r, g, b, a]. */
export function parseColor(css) {
  if (!css || css === 'transparent') return [0, 0, 0, 0];
  const parts = css.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0];
  return [parts[0], parts[1], parts[2], parts[3] ?? 1];
}

function numberRow(label, prop, is, should, tolerance) {
  const delta = is - should;
  return Math.abs(delta) > tolerance ? { element: label, prop, is: fmt(is), should: fmt(should), delta: fmt(delta) } : null;
}

function colorRow(label, prop, is, should) {
  const a = parseColor(is);
  const b = parseColor(should);
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
  if (style.lineHeightPx === undefined) return rows;
  const lineHeight = css.lineHeight === 'normal'
    ? { element: label, prop: 'line-height', is: 'normal', should: fmt(style.lineHeightPx), delta: 'set explicitly' }
    : numberRow(label, 'line-height', css.lineHeight, style.lineHeightPx, TOLERANCE.lineHeight);
  return [...rows, lineHeight];
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

function boxStyleRows(label, spec, css) {
  const background = spec.style.background === undefined ? null : colorRow(label, 'background', css.backgroundColor, spec.style.background);
  return [background, ...radiusRows(label, spec, css), ...layoutRows(label, spec, css)];
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
    rows.push(...boxRows(label, spec, m.box), ...style);
  }
  return rows.filter(Boolean);
}
