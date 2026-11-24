// Purpose: read and validate the `batch --states` file and select surfaces for `--only`.
// Exports: loadStatesFile, parseStates, selectSurfaces (an empty states list is valid here; `batch` turns it into exit 1). Invariants: pure apart from reading the file and any steps file it names;
// every schema error is a UsageError that names the state index and field (`states[2].locale: ...`); unknown fields are rejected;
// nothing is defaulted silently except what `defaults` states. Diagnostic states (P3c: diagnostic, proves) alone may use the page-changing
// steps (hide, remove, replace) and ignoreBands; size is a frame-in-page viewport; maxFocusStops raises the focus-walk cap with a reason.
import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from './cache.mjs';
import { COLOR_SCHEMES, DIRECTIONS, mergeEntries, validateChoice, validateEntries, validateLocale, validateWidths } from './context.mjs';
import { UsageError } from './errors.mjs';
import { DIAGNOSTIC_ACTIONS, loadSteps, validateSteps } from './steps.mjs';

const DEFAULT_KEYS = ['baseUrl', 'locale', 'colorScheme', 'widths', 'storage', 'cookies', 'sameInAllLocales', 'bypassCSP'];
const STATE_KEYS = ['surface', 'state', 'locale', 'url', 'steps', 'expectDir', 'storage', 'cookies', 'widths', 'figma', 'sameInAllLocales', 'diagnostic', 'proves', 'ignoreBands', 'size', 'maxFocusStops'];
const MIN_WHY_CHARS = 15;
const FIGMA_KEYS = ['file', 'node', 'map', 'root'];
const URL_PROTOCOLS = new Set(['http:', 'https:', 'file:']);
const DEFAULT_ROOT = 'body';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

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

/** Terms that are the same in every language: an array of non-empty strings. */
function readTerms(value, label) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((term) => typeof term !== 'string' || term.trim() === '')) throw new UsageError(`${label}: must be an array of non-empty strings (example: ["Acme", "Google"])`);
  return value.map((term) => term.trim());
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
    sameInAllLocales: readTerms(defaults.sameInAllLocales, 'defaults.sameInAllLocales') ?? [],
    bypassCSP: readFlag(defaults.bypassCSP, 'defaults.bypassCSP'),
  };
}

function readFlag(value, label) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new UsageError(`${label}: must be true or false`);
  return value;
}

/** A capture-only CSP bypass is for development servers: every state URL must be loopback (localhost, *.localhost, 127.0.0.1, ::1) or file:. */
function checkBypassHosts(states) {
  for (const state of states) {
    const url = new URL(state.url);
    const host = url.hostname.toLowerCase();
    const loopback = url.protocol === 'file:' || LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost');
    if (!loopback) throw new UsageError(`defaults.bypassCSP: states[${state.index}] is on ${host}, not a loopback host (localhost, *.localhost, 127.0.0.1, ::1) or file:; the CSP bypass is for development servers only`);
  }
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

const positiveInt = (value) => Number.isInteger(value) && value > 0;
const isWhy = (value) => typeof value === 'string' && value.replace(/\s/g, '').length >= MIN_WHY_CHARS;

/** P3c: a diagnostic state (`diagnostic: true`, `proves: {surface, state}`) may change the page; a gate state may not. */
function readDiagnostic(raw, steps, label) {
  if (raw.diagnostic !== undefined && typeof raw.diagnostic !== 'boolean') throw new UsageError(`${label}.diagnostic: must be true or false`);
  const diagnostic = raw.diagnostic === true;
  if (diagnostic && !(isObject(raw.proves) && typeof raw.proves.surface === 'string' && typeof raw.proves.state === 'string')) throw new UsageError(`${label}.proves: a diagnostic state names the gate state it proves: {"surface": "...", "state": "..."}`);
  if (!diagnostic && raw.proves !== undefined) throw new UsageError(`${label}.proves: only a diagnostic state (diagnostic: true) proves another state`);
  const changes = steps.filter((step) => DIAGNOSTIC_ACTIONS.has(step.action)).map((step) => step.action);
  if (!diagnostic && (changes.length > 0 || raw.ignoreBands !== undefined)) throw new UsageError(`${label}: ${[...changes, ...(raw.ignoreBands === undefined ? [] : ['ignoreBands'])].join(', ')} change the page: only a diagnostic state may use them`);
  return diagnostic ? { diagnostic: true, proves: { surface: raw.proves.surface, state: raw.proves.state } } : { diagnostic: false, proves: null };
}

/** ignoreBands (diagnostic only): horizontal bands {y, h} in CSS px masked in both images; size: the viewport of a frame that is part of a page. */
function readFrameOptions(raw, label) {
  const bands = raw.ignoreBands;
  if (bands !== undefined && !(Array.isArray(bands) && bands.every((b) => isObject(b) && Number.isFinite(b.y) && b.y >= 0 && Number.isFinite(b.h) && b.h > 0))) throw new UsageError(`${label}.ignoreBands: a list of {"y": <px>, "h": <px>}`);
  const size = raw.size;
  if (size !== undefined && !(isObject(size) && positiveInt(size.width) && positiveInt(size.height))) throw new UsageError(`${label}.size: {"width": <px>, "height": <px>} (positive integers)`);
  const stops = raw.maxFocusStops;
  if (stops !== undefined && !(isObject(stops) && positiveInt(stops.count) && isWhy(stops.why))) throw new UsageError(`${label}.maxFocusStops: {"count": <n>, "why": "<reason of ${MIN_WHY_CHARS}+ characters>"}`);
  return { ignoreBands: bands ?? [], size: size ?? null, maxFocusStops: stops ?? null };
}

/** Every `proves` names a gate state (same surface and state) of the file. @throws {UsageError} naming the diagnostic state */
function checkProves(states) {
  const gates = new Set(states.filter((s) => !s.diagnostic).map((s) => JSON.stringify([s.surface, s.state])));
  for (const s of states.filter((x) => x.diagnostic)) {
    if (!gates.has(JSON.stringify([s.proves.surface, s.proves.state]))) throw new UsageError(`states[${s.index}].proves: names no gate state (${s.proves.surface} / ${s.proves.state})`);
  }
}

function readState(raw, index, defaults, baseDir) {
  const label = `states[${index}]`;
  checkKeys(raw, STATE_KEYS, label);
  const steps = readSteps(raw.steps, baseDir, `${label}.steps`);
  const locale = raw.locale === undefined ? defaults.locale : validateLocale(raw.locale, `${label}.locale`);
  const expectDir = raw.expectDir === undefined ? undefined : validateChoice(raw.expectDir, DIRECTIONS, `${label}.expectDir`);
  const widths = raw.widths === undefined ? defaults.widths : validateWidths(raw.widths, `${label}.widths`);
  const state = {
    index, surface: text(raw.surface, `${label}.surface`), state: text(raw.state, `${label}.state`), locale: locale ?? null,
    url: resolveUrl(raw.url, defaults.baseUrl, `${label}.url`), steps,
    sameInAllLocales: readTerms(raw.sameInAllLocales, `${label}.sameInAllLocales`) ?? defaults.sameInAllLocales,
    widths: widths ?? null, figma: readFigma(raw.figma, baseDir, `${label}.figma`), bypassCSP: defaults.bypassCSP,
    ...readDiagnostic(raw, steps, label), ...readFrameOptions(raw, label),
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
 * @param {unknown} raw parsed JSON: { defaults?: {baseUrl, locale, colorScheme, widths, storage, cookies, sameInAllLocales, bypassCSP}, states: [{ surface, state, url, locale?, steps?, expectDir?, storage?, cookies?, widths?, sameInAllLocales?, figma?: {file, node, map?, root?} }] }
 * @param {string} baseDir folder that relative steps and map paths resolve against
 * @returns {object[]} one normalised state each: { index, surface, state, locale, url, steps, sameInAllLocales, widths, figma, bypassCSP, context }; url is absolute, context is the openPage context;
 *   bypassCSP (defaults.bypassCSP, capture only) is allowed only when every state URL is loopback or file:
 * @throws {UsageError} naming the state index and field of the first mistake
 */
export function parseStates(raw, baseDir) {
  checkKeys(raw, ['defaults', 'states'], 'states file');
  if (!Array.isArray(raw.states)) throw new UsageError('states: must be an array');
  const defaults = readDefaults(raw.defaults);
  const seen = new Set();
  const states = raw.states.map((entry, index) => {
    const state = readState(entry, index, defaults, baseDir);
    // A diagnostic state may repeat its gate state's names; it is told apart by its index.
    const key = JSON.stringify([state.surface, state.state, state.locale, state.diagnostic ? index : null]);
    if (seen.has(key)) throw new UsageError(`states[${index}]: duplicate surface/state/locale (${state.surface} / ${state.state} / ${state.locale ?? 'no locale'})`);
    seen.add(key);
    return state;
  });
  if (defaults.bypassCSP) checkBypassHosts(states);
  checkProves(states);
  return states;
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
