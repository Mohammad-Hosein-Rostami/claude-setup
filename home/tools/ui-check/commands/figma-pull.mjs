// Purpose: `figma-pull` - cache Figma baselines (PNG), flattened specs and meta (zero MCP tokens): one node, every frame
// and component-set variant under a page or section (`--bulk`), or the same from a local export folder (`--from-export`:
// the nodes-JSON + `<id>.png` folder, or Figma's own PNG export, see lib/native-export.mjs).
// Exports: options, fetchTargets (one nodes call + one images call, shared with figma-refresh), run.
// Invariants: a complete cache folder is skipped unless --refresh; every spec.json comes from flattenSpec on the node's raw
// document; FIGMA_TOKEN is read by lib/figma-api.mjs and never printed; --from-export makes no network call.
import fs from 'node:fs';
import path from 'node:path';
import { parse, need, toNumber } from '../lib/args.mjs';
import { UsageError } from '../lib/errors.mjs';
import { cacheDir, isCached, writeCache } from '../lib/cache.mjs';
import { fetchNode, fetchBaseline, fetchNodes, fetchImages } from '../lib/figma-api.mjs';
import { applyNativeExport, isNativeExport, planNativeExport } from '../lib/native-export.mjs';
import { flattenSpec } from '../lib/spec.mjs';
import { apiNodeId, targetsOf } from './figma-frames.mjs';

export const options = {
  file: { type: 'string' },
  node: { type: 'string' },
  scale: { type: 'string', default: '1' },
  refresh: { type: 'boolean', default: false },
  bulk: { type: 'boolean', default: false },
  'from-export': { type: 'string' },
};

const MIN_SCALE = 0.01;
const EXPORT_NODES_FILE = 'nodes.json';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Every node of a document tree by id (the root included). */
function indexById(document, index = new Map()) {
  index.set(document.id, document);
  for (const child of document.children ?? []) indexById(child, index);
  return index;
}

/**
 * meta.json of one target: what readCache needs (scale, width, height) plus where it came from.
 * @param {{fileKey: string, scale: number, pulledFrom: string, source: 'api'|'export'}} origin
 * @param {{node: string, kind: string, set?: string}} target
 * @param {{root: {w: number, h: number}}} spec the flattened spec
 * @returns {object} meta
 */
function metaOf(origin, target, spec) {
  const { fileKey, scale, pulledFrom, source } = origin;
  const set = target.set === undefined ? {} : { set: target.set };
  return { fileKey, nodeId: target.node, scale, width: spec.root.w, height: spec.root.h, kind: target.kind, ...set, pulledFrom, source, fetchedAt: new Date().toISOString() };
}

/**
 * The targets under one node (targetsOf: frames, then component-set variants) from ONE nodes call for the whole
 * subtree and ONE images call for the targets that are not skipped. Hidden targets (visible: false) are left out,
 * because Figma renders no image for them.
 * @param {string} fileKey Figma file key
 * @param {string} node API node id of the page, section, frame or component set
 * @param {number} scale export scale
 * @param {(target: {node: string}) => boolean} [skip] true for a target that needs no fetch (already cached)
 * @returns {Promise<{targets: object[], hidden: number, entries: {target: object, png: Buffer, spec: object, meta: object}[]}>}
 * @throws {UsageError} when the node holds no target; Error on an API error
 */
export async function fetchTargets(fileKey, node, scale, skip = () => false) {
  const root = (await fetchNodes(fileKey, [node])).get(node);
  const index = indexById(root);
  const all = targetsOf(root);
  if (all.length === 0) throw new UsageError(`node ${node} holds no frame, component or component-set variant`);
  const targets = all.filter((target) => index.get(target.node).visible !== false);
  const todo = targets.filter((target) => !skip(target));
  const specs = todo.map((target) => flattenSpec(index.get(target.node))); // before the images call: a bad node costs no render
  const images = await fetchImages(fileKey, todo.map((target) => target.node), scale);
  const origin = { fileKey, scale, pulledFrom: node, source: 'api' };
  const entries = todo.map((target, i) => ({ target, png: images.get(target.node), spec: specs[i], meta: metaOf(origin, target, specs[i]) }));
  return { targets, hidden: all.length - targets.length, entries };
}

const countKind = (targets, kind) => targets.filter((target) => target.kind === kind).length;

async function pullBulk(fileKey, node, scale, refresh) {
  const skip = (target) => !refresh && isCached(cacheDir(fileKey, target.node));
  const { targets, hidden, entries } = await fetchTargets(fileKey, node, scale, skip);
  for (const entry of entries) writeCache(cacheDir(fileKey, entry.target.node), entry);
  const kinds = `${countKind(targets, 'frame')} frames, ${countKind(targets, 'variant')} variants`;
  const hiddenNote = hidden > 0 ? `; ${hidden} hidden skipped` : '';
  console.log(`bulk ${node}: ${targets.length} targets (${kinds}); pulled ${entries.length}, already cached ${targets.length - entries.length}${hiddenNote} -> ${path.dirname(cacheDir(fileKey, node))}`);
  return 0;
}

async function pullOne(fileKey, node, scale, refresh) {
  const dir = cacheDir(fileKey, node);
  if (!refresh && isCached(dir)) {
    console.log(`cached: ${dir} (use --refresh to refetch)`);
    return 0;
  }
  const document = await fetchNode(fileKey, node);
  const spec = flattenSpec(document);
  const png = await fetchBaseline(fileKey, node, scale);
  const meta = { fileKey, nodeId: node, scale, width: spec.root.w, height: spec.root.h, fetchedAt: new Date().toISOString() };
  writeCache(dir, { png, spec, meta });
  console.log(`pulled ${spec.nodes.length} nodes -> ${dir}`);
  return 0;
}

/**
 * Read and validate the nodes file of an export folder: the Figma nodes-API answer `{nodes: {<id>: {document}}}`.
 * @param {string} dir export folder
 * @returns {[string, object][]} [entry id, document] pairs
 * @throws {UsageError} when the file is missing, not JSON, or not that shape
 */
function readExportNodes(dir) {
  const file = path.join(dir, EXPORT_NODES_FILE);
  if (!fs.existsSync(file)) throw new UsageError(`--from-export: ${file} is missing (the Figma nodes-API answer of the exported nodes)`);
  let body;
  try {
    body = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UsageError(`--from-export: ${file} is not valid JSON: ${error.message}`);
  }
  const nodes = body?.nodes;
  if (nodes === null || typeof nodes !== 'object' || Array.isArray(nodes)) throw new UsageError(`--from-export: ${file} has no "nodes" object`);
  return Object.entries(nodes).map(([id, entry]) => {
    if (typeof entry?.document?.id !== 'string') throw new UsageError(`--from-export: ${file}: nodes["${id}"] has no document with an id`);
    return [id, entry.document];
  });
}

/** The baseline PNG of one exported node: `<dir>/<node id with ":" as "-">.png`, checked to be a PNG. */
function readExportPng(dir, nodeId) {
  const file = path.join(dir, `${nodeId.replace(/:/g, '-')}.png`);
  if (!fs.existsSync(file)) throw new UsageError(`--from-export: ${file} is missing (the PNG of node ${nodeId})`);
  const png = fs.readFileSync(file);
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new UsageError(`--from-export: ${file} is not a PNG`);
  return png;
}

/** One export entry -> cache entries for its targets (targetsOf), skipping complete cache folders unless refresh. */
function exportEntries(dir, [entryId, document], origin, refresh) {
  const index = indexById(document);
  const targets = targetsOf(document).filter((target) => index.get(target.node).visible !== false);
  if (targets.length === 0) throw new UsageError(`--from-export: node ${entryId} holds no frame, component or component-set variant`);
  return targets
    .filter((target) => refresh || !isCached(cacheDir(origin.fileKey, target.node)))
    .map((target) => {
      const spec = flattenSpec(index.get(target.node));
      return { target, png: readExportPng(dir, target.node), spec, meta: metaOf({ ...origin, pulledFrom: entryId }, target, spec) };
    });
}

function pullFromExport(fileKey, exportDir, scale, refresh) {
  const dir = path.resolve(exportDir);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`--from-export: ${dir} is not a folder`);
  if (isNativeExport(dir)) {
    const written = applyNativeExport(planNativeExport(dir, fileKey, scale));
    console.log(`from-export ${dir}: Figma's own export, wrote ${written} baseline${written === 1 ? '' : 's'} into the cache of ${fileKey}`);
    return 0;
  }
  const origin = { fileKey, scale, source: 'export' };
  const entries = readExportNodes(dir).flatMap((pair) => exportEntries(dir, pair, origin, refresh));
  for (const entry of entries) writeCache(cacheDir(fileKey, entry.target.node), entry);
  console.log(`from-export ${dir}: wrote ${entries.length} cache folder${entries.length === 1 ? '' : 's'} -> ${path.dirname(cacheDir(fileKey, 'node'))}`);
  return 0;
}

/** Run figma-pull. @returns {Promise<number>} exit code */
export async function run(argv) {
  const values = parse(argv, options);
  const fromExport = values['from-export'];
  if (values.bulk && fromExport !== undefined) throw new UsageError('--bulk and --from-export cannot be used together');
  const scale = toNumber(values.scale, 'scale', MIN_SCALE);
  if (fromExport !== undefined) {
    need(values, 'file');
    if (values.node !== undefined) throw new UsageError('--node is not used with --from-export (every node in its nodes.json is cached)');
    return pullFromExport(values.file, fromExport, scale, values.refresh);
  }
  need(values, 'file', 'node');
  if (values.bulk) return pullBulk(values.file, apiNodeId(values.node), scale, values.refresh);
  return pullOne(values.file, values.node, scale, values.refresh);
}
