// Purpose: minimal Figma REST client (node tree + PNG export). Never logs or returns the token.
// Exports: fetchNode, fetchBaseline. Invariant: error messages carry status codes only.
import { UsageError } from './errors.mjs';

const API = 'https://api.figma.com/v1';

function token() {
  const value = process.env.FIGMA_TOKEN;
  if (!value) throw new UsageError('FIGMA_TOKEN is not set (see docs/setup.md); or use the MCP fallback cache layout');
  return value;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'X-Figma-Token': token() } });
  if (!res.ok) throw new Error(`Figma API ${res.status} for ${new URL(url).pathname}`);
  return res.json();
}

/** Fetch one node's document from /v1/files/:key/nodes. */
export async function fetchNode(fileKey, nodeId) {
  const url = `${API}/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}`;
  const body = await getJson(url);
  const entry = body.nodes?.[nodeId];
  if (!entry?.document) throw new Error(`node ${nodeId} not found in file ${fileKey}`);
  return entry.document;
}

/** Download the exact-bounds PNG export of a node at the given scale. */
export async function fetchBaseline(fileKey, nodeId, scale) {
  const query = `ids=${encodeURIComponent(nodeId)}&scale=${scale}&format=png&use_absolute_bounds=true`;
  const body = await getJson(`${API}/images/${encodeURIComponent(fileKey)}?${query}`);
  const imageUrl = body.images?.[nodeId];
  if (!imageUrl) throw new Error(`Figma returned no image for node ${nodeId}`);
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`image download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
