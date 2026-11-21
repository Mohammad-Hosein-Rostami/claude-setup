// Purpose: `figma-frames` - list the frames under some Figma nodes into a frames file that `ui-coverage` reads as the design inventory.
// Exports: options, apiNodeId, framesOf, variantsOf, targetsOf, run. A `--node` may be a URL id (`12-40`); it is sent to Figma as `12:40`. Invariants: framesOf is pure; the only network call is the Figma nodes endpoint (depth 2),
// through lib/figma-api.mjs, which reads FIGMA_TOKEN and never prints it. Exit 0 ok; no token, an API error or an --out folder that does not exist is exit 2 (cli.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { parse, need } from '../lib/args.mjs';
import { UsageError } from '../lib/errors.mjs';
import { fetchNode } from '../lib/figma-api.mjs';

export const options = {
  file: { type: 'string' },
  node: { type: 'string', multiple: true },
  out: { type: 'string' },
};

// The nodes endpoint returns the node, its children and their children: enough for node -> frame and node -> section -> frame.
const NODE_DEPTH = 2;
const FRAME_TYPES = new Set(['FRAME', 'COMPONENT']);
const JSON_INDENT = 2;

/** A Figma node id as the API wants it: the URL form `12-40` becomes `12:40`. */
export const apiNodeId = (node) => node.trim().replace(/^(\d+)-(\d+)$/, '$1:$2');

const sizeOf = (box, side) => (box && Number.isFinite(box[side]) ? Math.ceil(box[side]) : null);

/**
 * The frames of one requested node: each FRAME or COMPONENT that is a child of the node or of a SECTION child of it.
 * @param {{name?: string, children?: object[]}} document the node document fetched with depth 2
 * @returns {{node: string, name: string, page: string, width: number|null, height: number|null}[]} in document order; width and height are ceil of the bounding box (null when Figma sent none)
 */
export function framesOf(document) {
  const children = document.children ?? [];
  const candidates = children.flatMap((child) => (child.type === 'SECTION' ? child.children ?? [] : [child]));
  return candidates
    .filter((child) => FRAME_TYPES.has(child.type))
    .map((frame) => ({ node: frame.id, name: frame.name, page: document.name, width: sizeOf(frame.absoluteBoundingBox, 'width'), height: sizeOf(frame.absoluteBoundingBox, 'height') }));
}

const VARIANT_TYPE = 'COMPONENT';
const SET_TYPE = 'COMPONENT_SET';

const variantsOfSet = (set, page) => (set.children ?? [])
  .filter((child) => child.type === VARIANT_TYPE)
  .map((variant) => ({ node: variant.id, name: variant.name, set: set.name, page, width: sizeOf(variant.absoluteBoundingBox, 'width'), height: sizeOf(variant.absoluteBoundingBox, 'height') }));

/**
 * The variants of the component sets of one requested node: each COMPONENT inside a COMPONENT_SET that sits where
 * `framesOf` looks (a child of the node or of a SECTION child of it). `framesOf` skips component sets; these are the
 * baselines for control states (hover, focus, disabled ...).
 * @param {{name?: string, children?: object[]}} document the node document (depth 3 or the whole subtree, so the variants are in it)
 * @returns {{node: string, name: string, set: string, page: string, width: number|null, height: number|null}[]} in document order
 */
export function variantsOf(document) {
  const children = document.children ?? [];
  const candidates = children.flatMap((child) => (child.type === 'SECTION' ? child.children ?? [] : [child]));
  return candidates.filter((child) => child.type === SET_TYPE).flatMap((set) => variantsOfSet(set, document.name));
}

/**
 * What `figma-pull --bulk` and `figma-refresh` cache for one node: the node itself when it is a FRAME or COMPONENT,
 * the variants when it is a COMPONENT_SET, else its frames (`framesOf`) followed by its variants (`variantsOf`).
 * @param {{id: string, name?: string, type?: string, children?: object[]}} document the node document (whole subtree)
 * @returns {{node: string, name: string, kind: 'frame'|'variant', set?: string}[]} a node listed once, in document order
 */
export function targetsOf(document) {
  if (FRAME_TYPES.has(document.type)) return [{ node: document.id, name: document.name, kind: 'frame' }];
  const variants = document.type === SET_TYPE ? variantsOfSet(document, document.name) : variantsOf(document);
  const frames = document.type === SET_TYPE ? [] : framesOf(document);
  return [
    ...frames.map(({ node, name }) => ({ node, name, kind: 'frame' })),
    ...variants.map(({ node, name, set }) => ({ node, name, kind: 'variant', set })),
  ];
}

/** Run figma-frames. @returns {Promise<number>} exit code */
export async function run(argv) {
  const values = parse(argv, options);
  need(values, 'file', 'node', 'out');
  if (!fs.statSync(path.dirname(path.resolve(values.out)), { throwIfNoEntry: false })?.isDirectory()) {
    throw new UsageError(`cannot write ${values.out}: the folder does not exist`); // checked before any request
  }
  const nodes = values.node.map(apiNodeId);
  const frames = new Map();
  for (const node of nodes) {
    for (const frame of framesOf(await fetchNode(values.file, node, NODE_DEPTH))) frames.set(frame.node, frame);
  }
  const source = `ui-check figma-frames --file ${values.file} ${nodes.map((node) => `--node ${node}`).join(' ')}`;
  fs.writeFileSync(values.out, `${JSON.stringify({ file: values.file, source, frames: [...frames.values()] }, null, JSON_INDENT)}\n`);
  console.log(`${values.out}: ${frames.size} frames from ${nodes.length} node${nodes.length === 1 ? '' : 's'}`);
  return 0;
}
