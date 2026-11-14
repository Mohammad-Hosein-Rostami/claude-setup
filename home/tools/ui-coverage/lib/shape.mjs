// Purpose: validate a matrix.json with hand-written schema rules (no dependency) and return problems, never throw.
// Exports: problem(code, message), isText(v), isReason(v), isValidWidth(v), noneReason(v), validateStructure(matrix),
//   validateRules(matrix), SURFACE_KINDS, STATUSES, REST_STATE, MIN_REASON_CHARS, controlsOf(surface).
// Invariants: validateStructure checks only what the cell logic needs to run (locales, widths, stateWidths, surface and
//   control ids, control class, cell widths); when it returns problems the caller must stop. validateRules assumes a
//   sound structure and reports the content rules (component, states, reference, default states, searched, deliverable,
//   reasons). A width is a positive integer or null. A reason has at least MIN_REASON_CHARS non-space characters.
import { defaultStatesFor, isKnownClass, knownClassNames } from './states.mjs';

export const SURFACE_KINDS = ['screen', 'email', 'server-page', 'pdf', 'notification', 'other'];
export const STATUSES = ['pass', 'fail', 'na', 'deferred', 'todo'];
export const REST_STATE = 'rest';
export const MIN_REASON_CHARS = 15;
const NONE_PREFIX = 'none:';
const DIRECTIONS = ['ltr', 'rtl'];

/** Builds a problem record; `code` is stable (tests and callers match on it), `message` is for people. */
export const problem = (code, message) => ({ code, message });

/** True for a string with a non-blank character. */
export const isText = (value) => typeof value === 'string' && value.trim() !== '';

/** True for a string with at least MIN_REASON_CHARS non-space characters: a real reason, not "n/a". */
export const isReason = (value) => typeof value === 'string' && value.replace(/\s/g, '').length >= MIN_REASON_CHARS;

/** True for a positive integer, null or undefined (no width). Strings, NaN, zero and negatives are not widths. */
export const isValidWidth = (value) => value === null || value === undefined || (Number.isInteger(value) && value > 0);

/** Returns the text after "none:" when `value` starts with it, else null. */
export const noneReason = (value) => (typeof value === 'string' && value.trim().startsWith(NONE_PREFIX) ? value.trim().slice(NONE_PREFIX.length) : null);

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Returns the controls of a surface: [] for "none: <reason>" or a malformed value. */
export const controlsOf = (surface) => (Array.isArray(surface.controls) ? surface.controls : []);

function localeProblems(locales) {
  if (!Array.isArray(locales) || locales.length === 0) return [problem('shape', 'locales must be a non-empty array of {tag, dir}')];
  const tags = new Set();
  return locales.flatMap((locale) => {
    if (!isObject(locale) || !isText(locale.tag) || !DIRECTIONS.includes(locale.dir)) return [problem('shape', `locale needs a tag and dir ltr|rtl: ${JSON.stringify(locale)}`)];
    const tag = locale.tag.toLowerCase(); // tags are compared ignoring letter case, so `fa` and `FA` would be one cell
    if (tags.has(tag)) return [problem('shape', `duplicate locale tag: ${locale.tag}`)];
    tags.add(tag);
    return [];
  });
}

function widthProblems(widths, stateWidths) {
  if (!Array.isArray(widths) || widths.length === 0) return [problem('shape', 'widths must be a non-empty array of positive integers')];
  const bad = widths.filter((w) => !Number.isInteger(w) || w <= 0).map((w) => problem('shape', `bad width: ${JSON.stringify(w)}`));
  if (stateWidths === undefined) return bad;
  const subset = Array.isArray(stateWidths) && stateWidths.length > 0 && stateWidths.every((w) => widths.includes(w));
  return subset ? bad : [...bad, problem('shape', 'stateWidths must be a non-empty subset of widths')];
}

function controlStructure(surface) {
  const seen = new Set();
  return surface.controls.flatMap((control) => {
    if (!isObject(control) || !isText(control.id)) return [problem('shape', `surface ${surface.id}: a control needs an id`)];
    const found = [];
    if (seen.has(control.id)) found.push(problem('shape', `surface ${surface.id}: duplicate control id ${control.id}`));
    seen.add(control.id);
    if (!isKnownClass(control.class)) {
      found.push(problem('shape', `surface ${surface.id} control ${control.id}: class "${control.class}" is not a known class; use one of ${knownClassNames().join(', ')}`));
    }
    return found;
  });
}

function surfaceStructure(surface, seenIds) {
  if (!isObject(surface) || !isText(surface.id)) return [problem('shape', 'every surface needs an id')];
  if (seenIds.has(surface.id)) return [problem('shape', `duplicate surface id: ${surface.id}`)];
  seenIds.add(surface.id);
  const found = [];
  if (!SURFACE_KINDS.includes(surface.kind)) found.push(problem('shape', `surface ${surface.id}: kind must be one of ${SURFACE_KINDS.join('|')}`));
  if (!isText(surface.source)) found.push(problem('shape', `surface ${surface.id}: source is empty`));
  if (Array.isArray(surface.controls)) found.push(...controlStructure(surface));
  else if (noneReason(surface.controls) === null) found.push(problem('shape', `surface ${surface.id}: controls must be an array or "none: <reason>"`));
  return found;
}

function cellStructure(cells) {
  if (cells === undefined) return [];
  if (!Array.isArray(cells) || !cells.every(isObject)) return [problem('shape', 'cells must be an array of objects')];
  return cells.filter((cell) => !isValidWidth(cell.width)).map((cell) => problem('shape', `cell has a bad width (positive integer or null): ${JSON.stringify([cell.surface, cell.state, cell.locale, cell.width])}`));
}

/**
 * Checks the skeleton the cell logic relies on.
 * @param {unknown} matrix the parsed matrix.json
 * @returns {{code:string,message:string}[]} problems with code `shape`; empty when the matrix can be processed
 */
export function validateStructure(matrix) {
  if (!isObject(matrix)) return [problem('shape', 'the matrix must be a JSON object')];
  const common = [...localeProblems(matrix.locales), ...widthProblems(matrix.widths, matrix.stateWidths)];
  if (!Array.isArray(matrix.surfaces) || matrix.surfaces.length === 0) return [problem('shape', 'surfaces must be a non-empty array'), ...common];
  const seenIds = new Set();
  return [...common, ...matrix.surfaces.flatMap((surface) => surfaceStructure(surface, seenIds)), ...cellStructure(matrix.cells)];
}

const componentOk = (component) => isText(component) || (isObject(component) && isReason(component.new));

function referenceProblem(reference) {
  if (!isText(reference)) return 'needs a path or "none: <reason>"';
  const reason = noneReason(reference);
  return reason === null || isReason(reason) ? null : `"none:" needs a reason of at least ${MIN_REASON_CHARS} characters`;
}

function controlRules(surface, control) {
  const where = `${surface.id} ${control.id}`;
  const states = Array.isArray(control.states) ? control.states : [];
  const dropped = isObject(control.dropped) ? control.dropped : {};
  const found = [];
  if (!componentOk(control.component)) found.push(problem('control-component', `${where}: component needs a path or {new: "<reason of ${MIN_REASON_CHARS}+ characters>"}`));
  if (states.length === 0) found.push(problem('control-states', `${where}: states is empty`));
  const badReference = referenceProblem(control.reference);
  if (badReference) found.push(problem('control-reference', `${where}: reference ${badReference}`));
  if (states.length > 0) {
    for (const state of defaultStatesFor(control.class)) {
      if (!states.includes(state) && !isReason(dropped[state])) found.push(problem('default-state', `${where}: default ${control.class} state "${state}" is neither covered nor dropped with a reason`));
    }
  }
  return found;
}

function surfaceRules(surface) {
  if (typeof surface.controls === 'string') {
    return isReason(noneReason(surface.controls)) ? [] : [problem('surface-controls', `${surface.id}: controls must be "none: <reason of ${MIN_REASON_CHARS}+ characters>" when empty`)];
  }
  return surface.controls.flatMap((control) => controlRules(surface, control));
}

/**
 * Checks the content rules of a structurally sound matrix.
 * @param {object} matrix a matrix that passed validateStructure
 * @returns {{code:string,message:string}[]} problems (control-*, default-state, surface-controls, state-widths, no-search, deliverable)
 */
export function validateRules(matrix) {
  const found = matrix.surfaces.flatMap(surfaceRules);
  const backend = matrix.searched?.backend;
  if (!Array.isArray(backend) || !backend.some(isText)) found.push(problem('no-search', 'searched.backend is empty: record the backend search commands and hit counts'));
  const deliverable = matrix.deliverable ?? {};
  if (!isText(deliverable.reviewUrl)) found.push(problem('deliverable', 'deliverable.reviewUrl is empty'));
  if (!isReason(deliverable.mockExcluded)) found.push(problem('deliverable', `deliverable.mockExcluded needs the quoted build/grep proof (${MIN_REASON_CHARS}+ characters)`));
  if (matrix.stateWidths !== undefined && !isReason(matrix.stateWidthsReason)) found.push(problem('state-widths', `stateWidths needs stateWidthsReason (${MIN_REASON_CHARS}+ characters)`));
  return found;
}
