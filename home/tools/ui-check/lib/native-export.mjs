// Purpose: read a folder of Figma's own PNG exports (File > Export, one PNG per layer) and attach each PNG to the cache
// folder of the layer it came from, which an earlier `figma-pull --bulk` already filled (spec.json, meta.json).
// Exports: isNativeExport, planNativeExport, applyNativeExport.
// Invariants: file and folder names are only compared with layer names, never used to build a write path or a command;
// every refusal happens in planNativeExport, before applyNativeExport writes anything; nothing is read outside the folder.
// Unconfirmed (U1, Figma forum threads only): Figma names a file `<layer name>.png` at 1x and `<layer name>@2x.png` at
// other scales, and a "/" in a layer name becomes a subfolder. Check it on the first real export.
import fs from 'node:fs';
import path from 'node:path';
import { cachedMetas, writeCache } from './cache.mjs';
import { UsageError } from './errors.mjs';

const EXPORT_NODES_FILE = 'nodes.json';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_EXTENSION = '.png';
const SCALE_SUFFIX = /@(\d+(?:\.\d+)?)x$/;
const MAX_FILES = 2000;
const MAX_FOLDER_DEPTH = 6;
const MAX_NAME_CHARS = 200;
const MAX_PNG_BYTES = 64 * 1024 * 1024;
const MAX_NAMES_LISTED = 20;

/** True when the folder has no `nodes.json`: it is Figma's own export, not the older nodes-API answer plus `<id>.png` files. */
export function isNativeExport(dir) {
  return !fs.existsSync(path.join(dir, EXPORT_NODES_FILE));
}

/** Names for a message: JSON-quoted (control characters escaped), at most MAX_NAMES_LISTED of them. */
function listNames(names) {
  const shown = names.slice(0, MAX_NAMES_LISTED).map((name) => JSON.stringify(name.slice(0, MAX_NAME_CHARS)));
  return shown.join(', ') + (names.length > shown.length ? ` and ${names.length - shown.length} more` : '');
}

/** Every `.png` under the folder as paths relative to it, folders in order; refuses links, too many files, too deep, too long. */
function listPngs(root, relative = [], found = []) {
  const entries = fs.readdirSync(path.join(root, ...relative), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    const here = [...relative, entry.name];
    if (entry.isSymbolicLink()) throw new UsageError(`--from-export: ${JSON.stringify(here.join('/'))} is a link; links in an export folder are not followed`);
    if (entry.isDirectory()) {
      if (here.length >= MAX_FOLDER_DEPTH) throw new UsageError(`--from-export: folders go deeper than ${MAX_FOLDER_DEPTH} levels at ${JSON.stringify(here.join('/'))}`);
      listPngs(root, here, found);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(PNG_EXTENSION)) {
      if (here.join('/').length > MAX_NAME_CHARS) throw new UsageError(`--from-export: a file name is longer than ${MAX_NAME_CHARS} characters: ${JSON.stringify(here.join('/').slice(0, MAX_NAME_CHARS))}...`);
      found.push(here);
    }
    if (found.length > MAX_FILES) throw new UsageError(`--from-export: more than ${MAX_FILES} PNG files in the folder`);
  }
  return found;
}

/** The layer name and scale a file name stands for: the stem, "/" for subfolders, and the `@Nx` suffix as the scale. */
function layerNameOf(relative, defaultScale) {
  const stem = relative.join('/').slice(0, -PNG_EXTENSION.length);
  const suffix = SCALE_SUFFIX.exec(stem);
  const candidates = [];
  if (suffix) candidates.push({ name: stem.slice(0, suffix.index), scale: Number(suffix[1]) });
  candidates.push({ name: stem, scale: defaultScale }); // a layer that is really called "Icon@2x"
  return candidates;
}

/** The cached layers of the file by layer name: Map name -> [{dir, meta}]. A cache folder without a readable spec is left out. */
function cachedLayers(fileKey) {
  const byName = new Map();
  for (const { dir, meta } of cachedMetas(fileKey)) {
    const specFile = path.join(dir, 'spec.json');
    if (!fs.existsSync(specFile)) continue;
    let name;
    try {
      name = JSON.parse(fs.readFileSync(specFile, 'utf8'))?.root?.name;
    } catch (error) {
      throw new UsageError(`${specFile} is not valid JSON: ${error.message}`);
    }
    if (typeof name !== 'string') continue;
    byName.set(name, [...(byName.get(name) ?? []), { dir, meta }]);
  }
  return byName;
}

/** The PNG bytes of one export file, checked: not empty, not over the cap, a real PNG. */
function readPng(root, relative) {
  const file = path.join(root, ...relative);
  const shown = JSON.stringify(relative.join('/'));
  const { size } = fs.statSync(file);
  if (size === 0) throw new UsageError(`--from-export: ${shown} is empty (0 bytes)`);
  if (size > MAX_PNG_BYTES) throw new UsageError(`--from-export: ${shown} is larger than ${MAX_PNG_BYTES} bytes`);
  const png = fs.readFileSync(file);
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new UsageError(`--from-export: ${shown} is not a PNG`);
  return png;
}

/**
 * Match every PNG of an export folder to a cached layer and check all of it; writes nothing.
 * @param {string} root export folder (absolute)
 * @param {string} fileKey Figma file key whose cache an earlier `figma-pull --bulk` filled
 * @param {number} defaultScale scale of a file with no `@Nx` suffix
 * @returns {{dir: string, meta: object, png: Buffer, scale: number, name: string}[]} one entry per matched layer
 * @throws {UsageError} no PNG, an empty or non-PNG file, no cache, a file with no layer, a layer name used by two
 *   cached layers, or two files for one layer; the message lists the names
 */
export function planNativeExport(root, fileKey, defaultScale) {
  const files = listPngs(root);
  if (files.length === 0) throw new UsageError(`--from-export: ${root} holds no PNG files`);
  const layers = cachedLayers(fileKey);
  if (layers.size === 0) throw new UsageError(`--from-export: no cache for file ${fileKey}; run \`figma-pull --bulk --file ${fileKey} --node <page or section>\` first, so the export's layer names can be matched to nodes`);
  const matches = new Map(); // cache dir -> {layer, files: []}
  const unmatched = [];
  const ambiguous = new Set();
  for (const relative of files) {
    const hit = layerNameOf(relative, defaultScale).find((candidate) => layers.has(candidate.name));
    if (hit === undefined) {
      unmatched.push(relative.join('/'));
      continue;
    }
    const layer = layers.get(hit.name);
    if (layer.length > 1) {
      ambiguous.add(hit.name);
      continue;
    }
    const [{ dir, meta }] = layer;
    const entry = matches.get(dir) ?? { dir, meta, name: hit.name, files: [] };
    entry.files.push({ relative, scale: hit.scale });
    matches.set(dir, entry);
  }
  if (ambiguous.size > 0) throw new UsageError(`--from-export: ${ambiguous.size} layer name${ambiguous.size === 1 ? ' is' : 's are'} used by more than one cached node, so the export cannot say which one: ${listNames([...ambiguous])}`);
  if (unmatched.length > 0) throw new UsageError(`--from-export: ${unmatched.length} file${unmatched.length === 1 ? ' has' : 's have'} no layer of that name in the cache of ${fileKey}: ${listNames(unmatched)}`);
  const twice = [...matches.values()].filter((entry) => entry.files.length > 1);
  if (twice.length > 0) throw new UsageError(`--from-export: more than one file for one layer: ${listNames(twice.map((entry) => `${entry.name} (${entry.files.map((file) => file.relative.join('/')).join(' + ')})`))}`);
  return [...matches.values()].map(({ dir, meta, name, files: [file] }) => ({ dir, meta, name, scale: file.scale, png: readPng(root, file.relative) }));
}

/**
 * Write the planned baselines: each cache folder keeps its spec.json and gets the exported baseline.png and a meta.json
 * with the export's scale and `source: "export"`.
 * @param {ReturnType<typeof planNativeExport>} plan the checked plan
 * @returns {number} cache folders written
 */
export function applyNativeExport(plan) {
  for (const { dir, meta, png, scale } of plan) {
    const spec = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8'));
    writeCache(dir, { png, spec, meta: { ...meta, scale, source: 'export', fetchedAt: new Date().toISOString() } });
  }
  return plan.length;
}
