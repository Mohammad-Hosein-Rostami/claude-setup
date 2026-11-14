// Purpose: read and validate the `batch --states` file and select surfaces for `--only`.
// Exports: loadStatesFile, parseStates, selectSurfaces (an empty states list is valid here; `batch` turns it into exit 1). Invariants: pure apart from reading the file and any steps file it names;
// every schema error is a UsageError that names the state index and field (`states[2].locale: ...`); unknown fields are rejected;
// nothing is defaulted silently except what `defaults` states.
import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from './cache.mjs';
import { COLOR_SCHEMES, DIRECTIONS, mergeEntries, validateChoice, validateEntries, validateLocale, validateWidths } from './context.mjs';
import { UsageError } from './errors.mjs';
import { loadSteps, validateSteps } from './steps.mjs';

const DEFAULT_KEYS = ['baseUrl', 'locale', 'colorScheme', 'widths', 'storage', 'cookies'];
const STATE_KEYS = ['surface', 'state', 'locale', 'url', 'steps', 'expectDir', 'storage', 'cookies', 'widths', 'figma'];
const FIGMA_KEYS = ['file', 'node', 'map', 'root'];
const URL_PROTOCOLS = new Set(['http:', 'https:', 'file:']);
const DEFAULT_ROOT = 'body';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function checkKeys(value, allowed, label) {
  if (!isObject(value)) throw new UsageError(`${label}: must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new UsageError(`${label}: unknown field ${unknown.map((key) => JSON.stringify(key)).join(', ')} (allowed: ${allowed.join(', ')})`);
}

function text(value, label) {
  if (typeof value !== 'string' || value === '') throw new UsageError(`${label}: must be a non-empty string`);
  return value;
}

function resolveUrl(value, baseUrl, label) {
  let url;
  try {
    url = new URL(text(value, label), baseUrl);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`${label}: cannot resolve ${JSON.stringify(value)} (give an absolute URL or set defaults.baseUrl)`);
  }
  if (!URL_PROTOCOLS.has(url.protocol)) throw new UsageError(`${label}: ${url.protocol} URLs are not supported`);
  return url.href;
}

function readDefaults(raw) {
  const defaults = raw ?? {};
  checkKeys(defaults, DEFAULT_KEYS, 'defaults');
  const has = (key) => defaults[key] !== undefined;
  if (has('baseUrl')) resolveUrl(defaults.baseUrl, undefined, 'defaults.baseUrl');
  return {
    baseUrl: defaults.baseUrl,
    locale: has('locale') ? validateLocale(defaults.locale, 'defaults.locale') : undefined,
    colorScheme: has('colorScheme') ? validateChoice(defaults.colorScheme, COLOR_SCHEMES, 'defaults.colorScheme') : 'light',
    widths: has('widths') ? validateWidths(defaults.widths, 'defaults.widths') : undefined,
    storage: validateEntries(defaults.storage, 'defaults.storage', 'storage'),
    cookies: validateEntries(defaults.cookies, 'defaults.cookies', 'cookie'),
  };
}

function readSteps(value, baseDir, label) {
  if (value === undefined) return [];
  try {
    return typeof value === 'string' ? loadSteps(path.resolve(baseDir, value)) : validateSteps(value);
  } catch (error) {
    if (error instanceof UsageError) throw new UsageError(`${label}: ${error.message}`);
    throw error;
  }
}

function readFigma(raw, baseDir, label) {
  if (raw === undefined) return null;
  checkKeys(raw, FIGMA_KEYS, label);
  const file = text(raw.file, `${label}.file`);
  const node = text(raw.node, `${label}.node`);
  return {
    cache: cacheDir(file, node),
    map: raw.map === undefined ? null : path.resolve(baseDir, text(raw.map, `${label}.map`)),
    root: raw.root === undefined ? DEFAULT_ROOT : text(raw.root, `${label}.root`),
  };
}

function readState(raw, index, defaults, baseDir) {
  const label = `states[${index}]`;
  checkKeys(raw, STATE_KEYS, label);
  const locale = raw.locale === undefined ? defaults.locale : validateLocale(raw.locale, `${label}.locale`);
  const expectDir = raw.expectDir === undefined ? undefined : validateChoice(raw.expectDir, DIRECTIONS, `${label}.expectDir`);
  const widths = raw.widths === undefined ? defaults.widths : validateWidths(raw.widths, `${label}.widths`);
  const state = {
    index, surface: text(raw.surface, `${label}.surface`), state: text(raw.state, `${label}.state`), locale: locale ?? null,
    url: resolveUrl(raw.url, defaults.baseUrl, `${label}.url`), steps: readSteps(raw.steps, baseDir, `${label}.steps`),
    widths: widths ?? null, figma: readFigma(raw.figma, baseDir, `${label}.figma`),
    context: {
      locale, colorScheme: defaults.colorScheme, expectDir,
      storage: mergeEntries(defaults.storage, validateEntries(raw.storage, `${label}.storage`, 'storage')),
      cookies: mergeEntries(defaults.cookies, validateEntries(raw.cookies, `${label}.cookies`, 'cookie')),
    },
  };
  if (!state.figma && !state.widths) throw new UsageError(`${label}: needs figma or widths (set widths on the state or in defaults)`);
  return state;
}

/**
 * Validate a parsed states file and resolve it against its folder.
 * @param {unknown} raw parsed JSON: { defaults?: {baseUrl, locale, colorScheme, widths, storage, cookies}, states: [{ surface, state, url, locale?, steps?, expectDir?, storage?, cookies?, widths?, figma?: {file, node, map?, root?} }] }
 * @param {string} baseDir folder that relative steps and map paths resolve against
 * @returns {object[]} one normalised state each: { index, surface, state, locale, url, steps, widths, figma, context }; url is absolute, context is the openPage context
 * @throws {UsageError} naming the state index and field of the first mistake
 */
export function parseStates(raw, baseDir) {
  checkKeys(raw, ['defaults', 'states'], 'states file');
  if (!Array.isArray(raw.states)) throw new UsageError('states: must be an array');
  const defaults = readDefaults(raw.defaults);
  const seen = new Set();
  return raw.states.map((entry, index) => {
    const state = readState(entry, index, defaults, baseDir);
    const key = JSON.stringify([state.surface, state.state, state.locale]);
    if (seen.has(key)) throw new UsageError(`states[${index}]: duplicate surface/state/locale (${state.surface} / ${state.state} / ${state.locale ?? 'no locale'})`);
    seen.add(key);
    return state;
  });
}

/** Read, parse and validate a states file. @param {string} file path given to --states @throws {UsageError} on an unreadable file, bad JSON or schema errors */
export function loadStatesFile(file) {
  const abs = path.resolve(file);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (error) {
    throw new UsageError(`--states ${file}: ${error.message}`);
  }
  return parseStates(raw, path.dirname(abs));
}

/**
 * Keep the states whose surface is listed in --only.
 * @param {object[]} states output of parseStates
 * @param {string|undefined} only comma-separated surfaces; undefined keeps all
 * @returns {object[]} the selected states; empty when no listed surface exists (the caller reports "nothing to run")
 * @throws {UsageError} when some listed surfaces exist and others do not (a typo that would silently skip a surface)
 */
export function selectSurfaces(states, only) {
  if (only === undefined) return states;
  const wanted = only.split(',').map((name) => name.trim()).filter(Boolean);
  const known = new Set(states.map((s) => s.surface));
  const selected = states.filter((s) => wanted.includes(s.surface));
  const missing = wanted.filter((name) => !known.has(name));
  if (missing.length > 0 && selected.length > 0) throw new UsageError(`--only: unknown surface ${JSON.stringify(missing.join(','))} (known: ${[...known].join(', ')})`);
  return selected;
}
