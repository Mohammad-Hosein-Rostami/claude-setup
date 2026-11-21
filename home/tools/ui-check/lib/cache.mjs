// Purpose: locate, read and write the per-node Figma cache (baseline.png, spec.json, meta.json).
// Exports: CACHE_FILES, cacheDir, isCached, writeCache, cachedMetas, readCache.
// Invariants: same layout whether filled by figma-pull (one node, --bulk or --from-export) or by the MCP fallback;
// cacheDir's optional root only moves the layout (figma-refresh writes its fresh copies under a temp root, never the cache).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageError } from './errors.mjs';

/** The three files of one complete cache folder. */
export const CACHE_FILES = ['baseline.png', 'spec.json', 'meta.json'];
const JSON_INDENT = 2;

const safeSegment = (value) => value.replace(/[^A-Za-z0-9_-]/g, '-'); // ":" is illegal in Windows paths
const defaultRoot = () => path.join(os.homedir(), '.cache', 'figma');

/**
 * Cache directory for one Figma node: <root>/<fileKey>/<nodeId> (root defaults to ~/.cache/figma).
 * @param {string} fileKey Figma file key
 * @param {string} nodeId node id (`12:40`; `:` becomes `-` in the path)
 * @param {string} [root] another cache root, e.g. a temp folder
 * @returns {string} the folder path (not created)
 */
export function cacheDir(fileKey, nodeId, root = defaultRoot()) {
  return path.join(root, safeSegment(fileKey), safeSegment(nodeId));
}

/** True when the folder holds all three cache files. */
export function isCached(dir) {
  return CACHE_FILES.every((name) => fs.existsSync(path.join(dir, name)));
}

/**
 * Write one cache folder (created when missing; existing files are replaced).
 * @param {string} dir target folder
 * @param {{png: Buffer, spec: object, meta: object}} entry baseline bytes, flattened spec and meta
 * @returns {string} dir
 */
export function writeCache(dir, { png, spec, meta }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'baseline.png'), png);
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(spec, null, JSON_INDENT));
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, JSON_INDENT));
  return dir;
}

/**
 * The meta.json of every cached node of one file (folders without a meta.json are left out).
 * @param {string} fileKey Figma file key
 * @returns {{dir: string, meta: object}[]} empty when the file has no cache folder
 * @throws {UsageError} when a meta.json is not valid JSON (named in the message)
 */
export function cachedMetas(fileKey) {
  const fileRoot = path.dirname(cacheDir(fileKey, 'node'));
  if (!fs.existsSync(fileRoot)) return [];
  return fs.readdirSync(fileRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(fileRoot, entry.name, 'meta.json')))
    .map((entry) => {
      const file = path.join(fileRoot, entry.name, 'meta.json');
      try {
        return { dir: path.dirname(file), meta: JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch (error) {
        throw new UsageError(`${file} is not valid JSON: ${error.message}`);
      }
    });
}

/**
 * Read and validate a cache directory.
 * @param {string} dir directory holding baseline.png, spec.json and meta.json
 * @returns {{dir: string, baseline: string, spec: object, meta: {scale: number, width: number, height: number}}}
 * @throws {UsageError} when a file is missing or meta.json is malformed
 */
export function readCache(dir) {
  const abs = path.resolve(dir);
  const read = (name) => {
    const file = path.join(abs, name);
    if (!fs.existsSync(file)) throw new UsageError(`cache is missing ${name}: ${abs} (run figma-pull first)`);
    return file;
  };
  const baseline = read('baseline.png');
  const spec = JSON.parse(fs.readFileSync(read('spec.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(read('meta.json'), 'utf8'));
  for (const key of ['scale', 'width', 'height']) {
    if (!(Number.isFinite(meta[key]) && meta[key] > 0)) throw new UsageError(`meta.json: "${key}" must be a positive number`);
  }
  return { dir: abs, baseline, spec, meta };
}
