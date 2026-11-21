// Purpose: minimal Figma REST client (node trees + PNG exports). Never logs or returns the token.
// Exports: fetchNode(fileKey, nodeId, depth?), fetchNodes(fileKey, nodeIds, depth?), fetchBaseline, fetchImages.
// Invariants: error messages carry status codes only; fetchNodes and fetchImages each make ONE API call however many
// ids they get (the image downloads that follow go to Figma's signed URLs, which take no token).
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

const idList = (nodeIds) => nodeIds.map(encodeURIComponent).join(',');

/**
 * Fetch several node documents with one call to /v1/files/:key/nodes.
 * @param {string} fileKey Figma file key
 * @param {string[]} nodeIds API node ids (`12:40`)
 * @param {number} [depth] levels of children to return (the whole subtree when omitted)
 * @returns {Promise<Map<string, object>>} node id -> document, in the order asked
 * @throws {Error} on an API error or when a node is missing from the answer
 */
export async function fetchNodes(fileKey, nodeIds, depth) {
  const limit = depth === undefined ? '' : `&depth=${depth}`;
  const body = await getJson(`${API}/files/${encodeURIComponent(fileKey)}/nodes?ids=${idList(nodeIds)}${limit}`);
  const documents = new Map();
  for (const nodeId of nodeIds) {
    const document = body.nodes?.[nodeId]?.document;
    if (!document) throw new Error(`node ${nodeId} not found in file ${fileKey}`);
    documents.set(nodeId, document);
  }
  return documents;
}

/** Fetch one node's document from /v1/files/:key/nodes; `depth` limits how many levels of children come back (the whole subtree when omitted). */
export async function fetchNode(fileKey, nodeId, depth) {
  return (await fetchNodes(fileKey, [nodeId], depth)).get(nodeId);
}

async function download(imageUrl, nodeId) {
  if (!imageUrl) throw new Error(`Figma returned no image for node ${nodeId}`);
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`image download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Export several nodes as exact-bounds PNGs with one call to /v1/images, then download each image.
 * @param {string} fileKey Figma file key
 * @param {string[]} nodeIds API node ids; an empty list makes no call
 * @param {number} scale export scale (1 = CSS pixels)
 * @returns {Promise<Map<string, Buffer>>} node id -> PNG bytes
 * @throws {Error} on an API error, a node Figma rendered no image for, or a failed download
 */
export async function fetchImages(fileKey, nodeIds, scale) {
  const images = new Map();
  if (nodeIds.length === 0) return images;
  const query = `ids=${idList(nodeIds)}&scale=${scale}&format=png&use_absolute_bounds=true`;
  const body = await getJson(`${API}/images/${encodeURIComponent(fileKey)}?${query}`);
  for (const nodeId of nodeIds) images.set(nodeId, await download(body.images?.[nodeId], nodeId));
  return images;
}

/** Download the exact-bounds PNG export of a node at the given scale. */
export async function fetchBaseline(fileKey, nodeId, scale) {
  return (await fetchImages(fileKey, [nodeId], scale)).get(nodeId);
}
