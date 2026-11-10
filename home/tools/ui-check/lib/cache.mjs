// Purpose: locate and read the per-node Figma cache (baseline.png, spec.json, meta.json).
// Exports: cacheDir, readCache. Invariant: same layout whether filled by figma-pull or by the MCP fallback.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageError } from './errors.mjs';

const safeSegment = (value) => value.replace(/[^A-Za-z0-9_-]/g, '-'); // ":" is illegal in Windows paths

/** Cache directory for one Figma node: ~/.cache/figma/<fileKey>/<nodeId>. */
export function cacheDir(fileKey, nodeId) {
  return path.join(os.homedir(), '.cache', 'figma', safeSegment(fileKey), safeSegment(nodeId));
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
