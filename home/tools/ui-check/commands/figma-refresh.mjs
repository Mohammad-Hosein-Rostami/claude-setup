// Purpose: `figma-refresh` - re-fetch the frames and component-set variants under a Figma node into a temp folder and
// say, per frame, whether the cache still matches Figma (spec deep-equal, baseline bytes equal).
// Exports: options, compareEntry, run.
// Invariants: NEVER writes to the cache (fresh copies go under a new os.tmpdir() folder, printed at the end); one nodes
// call and one images call (figma-pull's fetchTargets); FIGMA_TOKEN is never printed. Exit 0 when every frame is
// unchanged, 1 when any is changed, new or gone, 2 on a usage or API error (cli.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse, need, toNumber } from '../lib/args.mjs';
import { cacheDir, cachedMetas, isCached, writeCache } from '../lib/cache.mjs';
import { tableRow } from '../lib/report.mjs';
import { apiNodeId } from './figma-frames.mjs';
import { fetchTargets } from './figma-pull.mjs';

export const options = {
  file: { type: 'string' },
  node: { type: 'string' },
  scale: { type: 'string', default: '1' },
};

const MIN_SCALE = 0.01;
const TEMP_PREFIX = 'ui-check-refresh-';
const HEAD = ['node', 'kind', 'name', 'status', 'what differs'];

// A spec as JSON stores it: the fresh object can hold `undefined` fields, which JSON.stringify drops.
const asStored = (spec) => JSON.parse(JSON.stringify(spec));

/**
 * Compare one freshly fetched entry with the cache folder of the same node.
 * @param {string} fileKey Figma file key
 * @param {{target: {node: string, name: string, kind: string}, png: Buffer, spec: object}} entry from fetchTargets
 * @returns {{node: string, kind: string, name: string, status: 'unchanged'|'changed'|'new', differs: string}}
 */
export function compareEntry(fileKey, entry) {
  const { node, name, kind } = entry.target;
  const dir = cacheDir(fileKey, node);
  if (!isCached(dir)) return { node, kind, name, status: 'new', differs: 'not in the cache' };
  const cachedSpec = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8'));
  const differs = [
    ...(isDeepStrictEqual(cachedSpec, asStored(entry.spec)) ? [] : ['spec']),
    ...(fs.readFileSync(path.join(dir, 'baseline.png')).equals(entry.png) ? [] : ['baseline bytes']),
  ];
  return { node, kind, name, status: differs.length === 0 ? 'unchanged' : 'changed', differs: differs.join(', ') };
}

/** Cache folders that an earlier --bulk pull of this node wrote but that Figma no longer has under it (or hides). */
function goneRows(fileKey, node, freshNodes) {
  return cachedMetas(fileKey)
    .filter(({ meta }) => meta.pulledFrom === node && !freshNodes.has(meta.nodeId))
    .map(({ meta }) => ({ node: meta.nodeId, kind: meta.kind ?? '', name: '', status: 'gone', differs: 'cached, no longer under the node' }));
}

const tally = (rows) => Object.entries(Object.groupBy(rows, (row) => row.status)).map(([status, list]) => `${list.length} ${status}`).join(', ');

/** Run figma-refresh. @returns {Promise<number>} exit code: 0 all unchanged, 1 something changed */
export async function run(argv) {
  const values = parse(argv, options);
  need(values, 'file', 'node');
  const scale = toNumber(values.scale, 'scale', MIN_SCALE);
  const node = apiNodeId(values.node);
  const { entries } = await fetchTargets(values.file, node, scale);
  const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX)); // unique per run; the cache is never a target
  for (const entry of entries) writeCache(cacheDir(values.file, entry.target.node, freshRoot), entry);
  const rows = [...entries.map((entry) => compareEntry(values.file, entry)), ...goneRows(values.file, node, new Set(entries.map((entry) => entry.target.node)))];
  console.log(tableRow(HEAD));
  console.log(tableRow(HEAD.map(() => '---')));
  for (const row of rows) console.log(tableRow([row.node, row.kind, row.name, row.status, row.differs]));
  console.log(`refresh ${node}: ${tally(rows)}; fresh copies: ${freshRoot} (the cache was not changed; figma-pull --bulk --refresh updates it)`);
  return rows.every((row) => row.status === 'unchanged') ? 0 : 1;
}
