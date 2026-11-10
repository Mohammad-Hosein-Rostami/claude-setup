// Purpose: `figma-pull` - cache a Figma node's baseline PNG, flattened spec and meta (zero MCP tokens).
// Exports: options, run. Invariant: skips the network when the cache is complete unless --refresh.
import fs from 'node:fs';
import { parse, need, toNumber } from '../lib/args.mjs';
import { cacheDir } from '../lib/cache.mjs';
import { fetchNode, fetchBaseline } from '../lib/figma-api.mjs';
import { flattenSpec } from '../lib/spec.mjs';

export const options = {
  file: { type: 'string' },
  node: { type: 'string' },
  scale: { type: 'string', default: '1' },
  refresh: { type: 'boolean', default: false },
};

const FILES = ['baseline.png', 'spec.json', 'meta.json'];

/** Run figma-pull. @returns {Promise<number>} exit code */
export async function run(argv) {
  const values = parse(argv, options);
  need(values, 'file', 'node');
  const scale = toNumber(values.scale, 'scale', 0.01);
  const dir = cacheDir(values.file, values.node);
  if (!values.refresh && FILES.every((f) => fs.existsSync(`${dir}/${f}`))) {
    console.log(`cached: ${dir} (use --refresh to refetch)`);
    return 0;
  }
  const document = await fetchNode(values.file, values.node);
  const spec = flattenSpec(document);
  const png = await fetchBaseline(values.file, values.node, scale);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/baseline.png`, png);
  fs.writeFileSync(`${dir}/spec.json`, JSON.stringify(spec, null, 2));
  const meta = { fileKey: values.file, nodeId: values.node, scale, width: spec.root.w, height: spec.root.h, fetchedAt: new Date().toISOString() };
  fs.writeFileSync(`${dir}/meta.json`, JSON.stringify(meta, null, 2));
  console.log(`pulled ${spec.nodes.length} nodes -> ${dir}`);
  return 0;
}
