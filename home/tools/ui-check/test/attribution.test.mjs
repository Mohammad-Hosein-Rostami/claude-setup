// Purpose: browser-free tests for lib/attribution.mjs on tiny in-memory pngjs images: textScopeBoxes rounding, the leftover colour
// metric (> 2 levels, end-exclusive boxes), every class of attributePixels (accepted, text-aa, text-flagged, graphic, other) with the
// MIN_TEXT_DIFF_PX boundary, paint order and clusters, and acceptedBox. Exports: none.
import assert from 'node:assert/strict';
import test from 'node:test';
import pngjs from 'pngjs';
import { acceptedBox, attributePixels, CLASSES, CLASS_LABELS, leftoverPixels, MIN_TEXT_DIFF_PX, textScopeBoxes } from '../lib/attribution.mjs';
import { isolateEach } from './isolated-env.mjs';

const { PNG } = pngjs;
isolateEach('attribution');
const WHITE = 255;
const PLACE = Object.freeze({ scale: 1, offset: { x: 0, y: 0 } });
const NONE_ACCEPTED = Object.freeze({ all: null, boxes: [] });

/** A width x height PNG of one grey level, opaque. */
function canvas(width, height, grey = WHITE) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([grey, grey, grey, 255], i);
  return png;
}

const paint = (png, points, rgba) => points.forEach(([x, y]) => png.data.set(rgba, (y * png.width + x) * 4));
const block = (x0, y0, w, h) => Array.from({ length: w * h }, (_, i) => [x0 + (i % w), y0 + Math.floor(i / w)]);
const pxOf = (result) => Object.fromEntries(CLASSES.map((name) => [name, result.classes[name].px]));

test('CLASSES are in report order with a label each; MIN_TEXT_DIFF_PX is 20', () => {
  assert.deepEqual(CLASSES, ['accepted', 'text-aa', 'text-flagged', 'graphic', 'other']);
  assert.deepEqual(Object.keys(CLASS_LABELS), CLASSES);
  assert.ok(Object.isFrozen(CLASS_LABELS));
  assert.equal(MIN_TEXT_DIFF_PX, 20);
});

test('textScopeBoxes: TEXT nodes only, x and y floored and w and h ceiled after scaling', () => {
  const nodes = [
    { type: 'FRAME', x: 0, y: 0, w: 10, h: 10 },
    { type: 'TEXT', x: 1.3, y: 2.2, w: 3.1, h: 4.9 },
    { type: 'VECTOR', x: 1, y: 1, w: 1, h: 1 },
  ];
  assert.deepEqual(textScopeBoxes(nodes, 2), [{ x: 2, y: 4, w: 7, h: 10 }]);
  assert.deepEqual(textScopeBoxes([], 2), []);
});

test('leftoverPixels: a channel off by more than 2 levels counts (alpha too), 2 levels does not; excluded boxes are end-exclusive', () => {
  const base = canvas(4, 3, 100);
  const actual = canvas(4, 3, 100);
  paint(actual, [[1, 0]], [103, 100, 100, 255]);
  paint(actual, [[2, 0]], [102, 98, 100, 253]);
  paint(actual, [[0, 2]], [100, 100, 100, 252]);
  assert.deepEqual(leftoverPixels(base, actual, []), { every: [1, 8], outside: [1, 8] });
  assert.deepEqual(leftoverPixels(base, actual, [{ x: 1, y: 0, w: 1, h: 1 }]), { every: [1, 8], outside: [8] });
  assert.deepEqual(leftoverPixels(base, actual, [{ x: 0, y: 0, w: 1, h: 2 }]).outside, [1, 8], 'a box ending at x 1, y 2 holds neither');
});

/** 20x20 white images: a FRAME under a VECTOR and an IMAGE-filled RECTANGLE, plus 5 changed px (icon 2, photo 1, frame 1, outside 1). */
function shapes() {
  const base = canvas(20, 20);
  const actual = canvas(20, 20);
  paint(actual, [[0, 0], [1, 0], [11, 0], [10, 10], [18, 18]], [0, 0, 0, 255]);
  const nodes = [
    { id: '1:1', name: 'Card', type: 'FRAME', x: 0, y: 0, w: 15, h: 15 },
    { id: '1:2', name: 'Icon', type: 'VECTOR', x: 0, y: 0, w: 4, h: 4 },
    { id: '1:4', name: 'Photo', type: 'RECTANGLE', x: 10, y: 0, w: 3, h: 3, style: { image: true } },
  ];
  return { base, actual, nodes, pixels: leftoverPixels(base, actual, []).every };
}

test('attributePixels: the last node in paint order owns a pixel; vectors and IMAGE fills are graphic, the rest and outside is other', () => {
  const result = attributePixels(shapes(), PLACE, NONE_ACCEPTED);
  assert.equal(result.total, 5);
  assert.deepEqual(pxOf(result), { accepted: 0, 'text-aa': 0, 'text-flagged': 0, graphic: 3, other: 2 });
  assert.deepEqual(result.classes.graphic.nodes, [{ label: 'Icon (1:2)', px: 2 }, { label: 'Photo (1:4)', px: 1 }]);
  assert.deepEqual(result.classes.other.nodes, [{ label: 'Card (1:1)', px: 1 }, { label: '(outside every Figma node)', px: 1 }]);
  assert.deepEqual(result.flaggedText, []);
  assert.deepEqual(result.clusters, [
    { class: 'graphic', px: 2, box: { x: 0, y: 0, w: 2, h: 1 } },
    { class: 'graphic', px: 1, box: { x: 11, y: 0, w: 1, h: 1 } },
    { class: 'other', px: 1, box: { x: 10, y: 10, w: 1, h: 1 } },
    { class: 'other', px: 1, box: { x: 18, y: 18, w: 1, h: 1 } },
  ]);
});

test('attributePixels: an entry without nodes accepts every pixel; node boxes accept only the pixels inside them (end-exclusive)', () => {
  const all = attributePixels(shapes(), PLACE, { all: 'Known gradient drift on the card', boxes: [] });
  assert.deepEqual(pxOf(all), { accepted: 5, 'text-aa': 0, 'text-flagged': 0, graphic: 0, other: 0 });
  assert.deepEqual(all.classes.accepted.nodes, [{ label: 'Known gradient drift on the card', px: 5 }]);
  assert.deepEqual(all.clusters, [], 'accepted pixels are never clustered');
  const boxes = attributePixels(shapes(), PLACE, { all: null, boxes: [{ box: { x0: 0, y0: 0, x1: 1, y1: 1 }, reason: 'Icon edge accepted' }] });
  assert.deepEqual(pxOf(boxes), { accepted: 1, 'text-aa': 0, 'text-flagged': 0, graphic: 2, other: 2 });
});

/** 20x12 images with one TEXT node (device box grown by 2 px to 0,0..20,12); `draw` paints base and actual. */
function textCase(draw) {
  const base = canvas(20, 12);
  const actual = canvas(20, 12);
  draw(base, actual);
  const nodes = [{ id: '2:1', name: 'Label', type: 'TEXT', text: 'Hello', x: 2, y: 2, w: 16, h: 8 }];
  return attributePixels({ base, actual, nodes, pixels: leftoverPixels(base, actual, []).every }, PLACE, NONE_ACCEPTED);
}

test('attributePixels: a text box with MIN_TEXT_DIFF_PX - 1 leftover px is anti-aliasing, never measured', () => {
  const result = textCase((base, actual) => paint(actual, block(4, 4, 10, 2).slice(1), [0, 0, 0, 255]));
  assert.deepEqual(pxOf(result), { accepted: 0, 'text-aa': 19, 'text-flagged': 0, graphic: 0, other: 0 });
  assert.deepEqual(result.classes['text-aa'].nodes, [{ label: 'Label (2:1)', px: 19 }]);
  assert.deepEqual(result.flaggedText, []);
});

test('attributePixels: at MIN_TEXT_DIFF_PX the box is measured; new ink on a blank baseline is flagged text', () => {
  const result = textCase((base, actual) => paint(actual, block(4, 4, 10, 2), [0, 0, 0, 255]));
  assert.deepEqual(pxOf(result), { accepted: 0, 'text-aa': 0, 'text-flagged': 20, graphic: 0, other: 0 });
  assert.equal(result.flaggedText.length, 1);
  assert.deepEqual(result.flaggedText[0], { label: 'Label (2:1)', text: 'Hello', px: 20, box: { x0: 0, y0: 0, x1: 20, y1: 12 }, shift: [0, 0], inkRatio: Infinity, flagged: true });
  assert.deepEqual(result.clusters, [], 'text pixels are not clustered');
});

test('attributePixels: a measured text box with ink within 3 % and no shift stays anti-aliasing; 6 % less ink is flagged', () => {
  const grey = (from, to) => (base, actual) => {
    paint(base, block(4, 4, 10, 2), [from, from, from, 255]);
    paint(actual, block(4, 4, 10, 2), [to, to, to, 255]);
  };
  assert.deepEqual(pxOf(textCase(grey(100, 103))), { accepted: 0, 'text-aa': 20, 'text-flagged': 0, graphic: 0, other: 0 });
  const lighter = textCase(grey(100, 110));
  assert.equal(lighter.classes['text-flagged'].px, 20);
  assert.deepEqual(lighter.flaggedText[0].shift, [0, 0]);
  assert.ok(Math.abs(lighter.flaggedText[0].inkRatio - 145 / 155) < 1e-9);
});

test('attributePixels: text moved down 2 px is flagged with that shift and an unchanged ink ratio', () => {
  const result = textCase((base, actual) => {
    paint(base, block(4, 4, 10, 2), [0, 0, 0, 255]);
    paint(actual, block(4, 6, 10, 2), [0, 0, 0, 255]);
  });
  assert.equal(result.classes['text-flagged'].px, 40);
  assert.deepEqual([result.flaggedText[0].shift, result.flaggedText[0].inkRatio], [[0, 2], 1]);
});

test('acceptedBox: device px moved by the offset; TEXT grows by ceil(2 x scale); a zero-width box is still 1 px wide', () => {
  assert.deepEqual(acceptedBox({ type: 'FRAME', x: 1.5, y: 0, w: 0, h: 2 }, { scale: 2, offset: { x: 1, y: -1 } }), { x0: 4, y0: -1, x1: 5, y1: 3 });
  assert.deepEqual(acceptedBox({ type: 'TEXT', x: 1, y: 1, w: 2, h: 2 }, { scale: 1.5, offset: { x: 0, y: 0 } }), { x0: -2, y0: -2, x1: 8, y1: 8 });
});
