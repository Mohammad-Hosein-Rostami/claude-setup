// Purpose: find Playwright's chromium launcher. Playwright is not a dependency of ui-check, so it is looked up in, in order: the --project
// folder (default: the current directory), the folder named by env UI_CHECK_PROJECT, then the tool's own node_modules.
// Exports: loadChromium, resolutionPlaces. Invariants: installs nothing; the browser binaries are NOT found here - Playwright looks them up
// itself in its cache (~/Library/Caches/ms-playwright, ~/.cache/ms-playwright or %LOCALAPPDATA%\ms-playwright, or PLAYWRIGHT_BROWSERS_PATH)
// by the revision its own version needs, so any copy of that version works once its Chromium is in the cache.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError } from './errors.mjs';

const PACKAGES = ['playwright', '@playwright/test', 'playwright-core'];
const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The places Playwright is looked up, in order, each with the label the error message shows.
 * @param {string|undefined} project value of --project (undefined: the current directory, as before)
 * @param {Record<string, string|undefined>} env process environment (UI_CHECK_PROJECT)
 * @param {string} toolDir folder of the tool itself
 * @returns {{label: string, dir: string|null}[]} dir is null for a place that is not set; a folder named twice appears once
 */
export function resolutionPlaces(project, env, toolDir) {
  const first = project === undefined ? { label: `current directory ${process.cwd()} (no --project given)`, dir: process.cwd() } : { label: `--project ${path.resolve(project)}`, dir: path.resolve(project) };
  const fromEnv = env.UI_CHECK_PROJECT ? { label: `UI_CHECK_PROJECT ${path.resolve(env.UI_CHECK_PROJECT)}`, dir: path.resolve(env.UI_CHECK_PROJECT) } : { label: 'UI_CHECK_PROJECT (not set)', dir: null };
  const own = { label: `the tool's own node_modules (${toolDir})`, dir: path.resolve(toolDir) };
  const seen = new Set();
  return [first, fromEnv, own].filter(({ dir }) => dir === null || !seen.has(dir) && seen.add(dir));
}

function chromiumFrom(dir) {
  const require = createRequire(path.join(dir, 'package.json'));
  for (const name of PACKAGES) {
    let resolved;
    try {
      resolved = require.resolve(name);
    } catch (error) {
      if (error.code === 'MODULE_NOT_FOUND') continue;
      throw error;
    }
    return require(resolved).chromium;
  }
  return null;
}

function notFound(places, toolDir) {
  const tried = places.map((p, i) => `  ${i + 1}. ${p.label}${p.dir ? ': no playwright, @playwright/test or playwright-core resolves from there' : ''}`);
  return new UsageError([
    'Playwright not found. Places tried, in order:', ...tried,
    'Fix, either of:',
    '  - point at a folder that has it: set UI_CHECK_PROJECT=<folder whose node_modules has playwright> (or pass --project <folder>)',
    `  - give the tool its own copy: npm install --no-save --prefix "${toolDir}" playwright && "${path.join(toolDir, 'node_modules', '.bin', 'playwright')}" install chromium`,
  ].join('\n'));
}

/**
 * Find Playwright's chromium launcher.
 * @param {string} [project] value of --project; undefined means the current directory
 * @param {{env?: Record<string, string|undefined>, toolDir?: string}} [where] test hooks: environment and the tool's folder
 * @returns {object} Playwright's `chromium`
 * @throws {UsageError} when no place has Playwright; the message lists every place tried and the fix commands
 */
export function loadChromium(project, { env = process.env, toolDir = TOOL_DIR } = {}) {
  const places = resolutionPlaces(project, env, toolDir);
  for (const { dir } of places) {
    const chromium = dir === null ? null : chromiumFrom(dir);
    if (chromium) return chromium;
  }
  throw notFound(places, path.resolve(toolDir));
}
