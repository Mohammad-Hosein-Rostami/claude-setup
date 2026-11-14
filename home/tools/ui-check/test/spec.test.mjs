// Purpose: unit checks for flattenSpec, compareElements, alignColumns and the report cap (no browser needed).
import assert from 'node:assert/strict';
import test from 'node:test';
import { alignColumns } from '../commands/columns.mjs';
import { compareElements } from '../lib/elements.mjs';
import { writeReport, MAX_REPORT_LINES } from '../lib/report.mjs';
import { flattenSpec, colorToCss } from '../lib/spec.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const frame = JSON.parse(fs.readFileSync(new URL('./fixtures/frame.json', import.meta.url), 'utf8'));

test('flattenSpec makes boxes relative to the root and derives the gap from siblings', () => {
  const spec = flattenSpec(frame);
  assert.deepEqual(spec.root, { id: '1:1', name: 'Card', w: 300, h: 120 });
  assert.deepEqual(spec.nodes.map((n) => n.id), ['1:1', '1:2', '1:4']);
  const title = spec.nodes[1];
  assert.deepEqual([title.x, title.y, title.w, title.h], [16, 16, 100, 24]);
  assert.equal(title.style.letterSpacing, -0.2);
  assert.equal(title.style.color, 'rgb(0, 0, 0)');
  const root = spec.nodes[0];
  assert.equal(root.style.gap, 16); // derived (256 - 240), not itemSpacing 99
  assert.equal(root.style.figmaItemSpacing, 99);
  assert.deepEqual(root.style.padding, [16, 16, 16, 16]);
  assert.equal(root.style.background, 'rgb(255, 255, 255)');
});

test('colorToCss emits rgba for partial alpha', () => {
  assert.equal(colorToCss({ r: 0, g: 0, b: 0, a: 1 }, 0.5), 'rgba(0, 0, 0, 0.5)');
});

test('compareElements reports only failing props', () => {
  const spec = flattenSpec(frame);
  const css = { fontSize: 20, fontWeight: 600, lineHeight: 24, letterSpacing: -0.2, color: 'rgb(0, 0, 0)',
    backgroundColor: 'rgb(255, 255, 255)', radius: [8, 8, 8, 8], padding: [16, 16, 16, 20], rowGap: 16, columnGap: 0 };
  const measured = [
    { id: '1:1', found: true, box: { x: 0, y: 0, w: 300, h: 120 }, css },
    { id: '1:2', found: true, box: { x: 16, y: 16, w: 100, h: 24 }, css },
  ];
  const rows = compareElements(spec.nodes, { '1:1': '#card', '1:2': 'h1' }, measured);
  assert.deepEqual(rows.map((r) => r.prop), ['padding-left']);
  assert.equal(rows[0].is, '20');
  assert.equal(rows[0].should, '16');
});

test('compareElements flags a missing element and CSS line-height normal', () => {
  const spec = flattenSpec(frame);
  const css = { fontSize: 20, fontWeight: 600, lineHeight: 'normal', letterSpacing: -0.2, color: 'rgb(0, 0, 0)' };
  const measured = [{ id: '1:2', found: true, box: { x: 16, y: 16, w: 100, h: 24 }, css }, { id: '1:4', found: false }];
  const rows = compareElements(spec.nodes, { '1:2': 'h1', '1:4': 'p' }, measured);
  assert.deepEqual(rows.map((r) => r.prop), ['line-height', 'element']);
});

test('alignColumns flags a shifted column', () => {
  const rows = [[{ x: 0, w: 100 }, { x: 100, w: 200 }], [{ x: 0, w: 100 }, { x: 104, w: 200 }]];
  assert.deepEqual(alignColumns(rows).map((c) => c.pass), [true, false]);
});

test('report.md is capped at 40 lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-check-'));
  const rows = Array.from({ length: 100 }, (_, i) => [`e${i}`, 'x', '1', '2', '1']);
  const md = writeReport(dir, { title: 't', verdict: 'FAIL', summary: ['a'], head: ['element', 'prop', 'is', 'should', 'delta'], rows });
  assert.ok(fs.readFileSync(md, 'utf8').trimEnd().split('\n').length <= MAX_REPORT_LINES);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')).rows.length, 100);
});

test('report.md lists hints in their own section, capped at 12 lines, and the whole file stays within the cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-hints-'));
  const head = ['width', 'check', 'element', 'detail'];
  const many = (n, check) => Array.from({ length: n }, (_, i) => [320, check, `el${i}`, 'd']);
  const md = fs.readFileSync(writeReport(dir, { title: 't', verdict: 'FAIL', summary: ['s'], head, rows: many(60, 'hscroll'), hints: { head, rows: many(30, 'focus-indicator') }, data: { hints: [] } }), 'utf8');
  const lines = md.trimEnd().split('\n');
  assert.ok(lines.length <= MAX_REPORT_LINES, `${lines.length} lines`);
  const at = lines.indexOf('## Hints (heuristics: reported, never fail the run)');
  assert.ok(at > 0 && lines.length - at <= 11, 'hint section is at most 12 lines with its blank line');
  assert.match(md, /more hints in report\.json/);
  const few = fs.readFileSync(writeReport(dir, { title: 't', verdict: 'PASS', summary: ['s'], head, rows: [], hints: { head, rows: many(2, 'raw-i18n-key') }, data: {} }), 'utf8');
  assert.match(few, /PASS[\s\S]*## Hints[\s\S]*el1/);
  assert.doesNotMatch(fs.readFileSync(writeReport(dir, { title: 't', verdict: 'PASS', summary: ['s'], head, rows: [], data: {} }), 'utf8'), /Hints/);
});
