// Purpose: read the allow-lists that let a project keep a dumping-ground name on purpose: the personal
//   `.claude/readable.local.json` (never committed) and the team's `.readable.json` (only when the team adopted the tool).
// Exports: parseAllowList(text, fileName), readAllowLists(root), LOCAL_ALLOW_FILE, TEAM_ALLOW_FILE.
// Invariants: format is {"allow": [{"path": "src/data", "reason": "why this name is fine"}]}; a file that is not valid
//   JSON, has a key other than "allow", or has an entry without a path or a reason throws UsageError (exit 2), so the list
//   can never hide a finding by accident. A leading "./" and a trailing "/" on a path are ignored.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError } from './errors.mjs';

export const LOCAL_ALLOW_FILE = '.claude/readable.local.json';
export const TEAM_ALLOW_FILE = '.readable.json';

const cleanPath = (path) => path.replace(/^\.\//, '').replace(/\/+$/, '');

/**
 * @param {string} text content of one allow-list file
 * @param {string} fileName shown in error messages
 * @returns {string[]} the allowed paths
 * @throws {UsageError} when the file is malformed or an entry has no reason
 */
export function parseAllowList(text, fileName) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) { throw new UsageError(`${fileName} is not valid JSON (${error.message}).`); }
  const unknownKeys = Object.keys(parsed ?? {}).filter((key) => key !== 'allow');
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || unknownKeys.length > 0 || !Array.isArray(parsed.allow)) {
    throw new UsageError(`${fileName} must look like {"allow": [{"path": "src/data", "reason": "why"}]}${unknownKeys.length ? ` (unknown key "${unknownKeys[0]}")` : ''}.`);
  }
  return parsed.allow.map((entry) => {
    const path = typeof entry?.path === 'string' ? cleanPath(entry.path.trim()) : '';
    const reason = typeof entry?.reason === 'string' ? entry.reason.trim() : '';
    if (path === '') throw new UsageError(`${fileName} has an allow entry with no "path".`);
    if (reason === '') throw new UsageError(`${fileName} allows "${path}" without a "reason"; add one or remove the entry.`);
    return path;
  });
}

/** Reads the local file first, then the team file, and returns every allowed path. */
export function readAllowLists(root) {
  const allowed = new Set();
  for (const name of [LOCAL_ALLOW_FILE, TEAM_ALLOW_FILE]) {
    const file = join(root, name);
    if (existsSync(file)) for (const path of parseAllowList(readFileSync(file, 'utf8'), name)) allowed.add(path);
  }
  return allowed;
}
