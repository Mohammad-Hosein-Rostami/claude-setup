// Purpose: validate a matrix.json with hand-written schema rules (no dependency) and return problems, never throw.
// Exports: problem(code, message), isText(v), NONE_WITH_REASON, validateStructure(matrix), validateRules(matrix),
//   SURFACE_KINDS, STATUSES, REST_STATE, controlsOf(surface).
// Invariants: validateStructure checks only what the cell logic needs to run (locales, widths, surface and control ids);
//   when it returns problems the caller must stop. validateRules assumes a sound structure and reports the content
//   rules (component, states, reference, default states, searched, deliverable). All functions are pure.
import { defaultStatesFor } from './states.mjs';

export const SURFACE_KINDS = ['screen', 'email', 'server-page', 'pdf', 'notification', 'other'];
export const STATUSES = ['pass', 'fail', 'na', 'deferred', 'todo'];
export const REST_STATE = 'rest';
export const NONE_WITH_REASON = /^none:\s*\S/;
const DIRECTIONS = ['ltr', 'rtl'];

/** Builds a problem record; `code` is stable (tests and callers match on it), `message` is for people. */
export const problem = (code, message) => ({ code, message });

/** True for a string with a non-blank character. */
export const isText = (value) => typeof value === 'string' && value.trim() !== '';

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Returns the controls of a surface: [] for "none: <reason>" or a malformed value. */
export const controlsOf = (surface) => (Array.isArray(surface.controls) ? surface.controls : []);

function localeProblems(locales) {
  if (!Array.isArray(locales) || locales.length === 0) return [problem('shape', 'locales must be a non-empty array of {tag, dir}')];
  const tags = new Set();
  return locales.flatMap((locale) => {
    if (!isObject(locale) || !isText(locale.tag) || !DIRECTIONS.includes(locale.dir)) return [problem('shape', `locale needs a tag and dir ltr|rtl: ${JSON.stringify(locale)}`)];
    if (tags.has(locale.tag)) return [problem('shape', `duplicate locale tag: ${locale.tag}`)];
    tags.add(locale.tag);
    return [];
  });
}

function widthProblems(widths) {
  if (!Array.isArray(widths) || widths.length === 0) return [problem('shape', 'widths must be a non-empty array of positive integers')];
  return widths.filter((w) => !Number.isInteger(w) || w <= 0).map((w) => problem('shape', `bad width: ${JSON.stringify(w)}`));
}

function controlStructure(surface) {
  const seen = new Set();
  return surface.controls.flatMap((control) => {
    if (!isObject(control) || !isText(control.id)) return [problem('shape', `surface ${surface.id}: a control needs an id`)];
    if (seen.has(control.id)) return [problem('shape', `surface ${surface.id}: duplicate control id ${control.id}`)];
    seen.add(control.id);
    return [];
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
  else if (typeof surface.controls !== 'string' || !surface.controls.trim().startsWith('none:')) found.push(problem('shape', `surface ${surface.id}: controls must be an array or "none: <reason>"`));
  return found;
}

/**
 * Checks the skeleton the cell logic relies on.
 * @param {unknown} matrix the parsed matrix.json
 * @returns {{code:string,message:string}[]} problems with code `shape`; empty when the matrix can be processed
 */
export function validateStructure(matrix) {
  if (!isObject(matrix)) return [problem('shape', 'the matrix must be a JSON object')];
  if (!Array.isArray(matrix.surfaces) || matrix.surfaces.length === 0) return [problem('shape', 'surfaces must be a non-empty array'), ...localeProblems(matrix.locales), ...widthProblems(matrix.widths)];
  const seenIds = new Set();
  const cellsOk = matrix.cells === undefined || (Array.isArray(matrix.cells) && matrix.cells.every(isObject));
  return [
    ...localeProblems(matrix.locales),
    ...widthProblems(matrix.widths),
    ...matrix.surfaces.flatMap((surface) => surfaceStructure(surface, seenIds)),
    ...(cellsOk ? [] : [problem('shape', 'cells must be an array of objects')]),
  ];
}

const componentOk = (component) => isText(component) || (isObject(component) && isText(component.new));
const referenceOk = (reference) => isText(reference) && (!reference.trim().startsWith('none:') || NONE_WITH_REASON.test(reference.trim()));

function controlRules(surface, control) {
  const where = `${surface.id} ${control.id}`;
  const states = Array.isArray(control.states) ? control.states : [];
  const dropped = isObject(control.dropped) ? control.dropped : {};
  const found = [];
  if (!componentOk(control.component)) found.push(problem('control-component', `${where}: component needs a path or {new: "<reason>"}`));
  if (states.length === 0) found.push(problem('control-states', `${where}: states is empty`));
  if (!referenceOk(control.reference)) found.push(problem('control-reference', `${where}: reference needs a path or "none: <reason>"`));
  if (states.length > 0) {
    for (const state of defaultStatesFor(control.class)) {
      if (!states.includes(state) && !isText(dropped[state])) found.push(problem('default-state', `${where}: default ${control.class} state "${state}" is neither covered nor dropped with a reason`));
    }
  }
  return found;
}

function surfaceRules(surface) {
  if (typeof surface.controls === 'string') {
    return NONE_WITH_REASON.test(surface.controls.trim()) ? [] : [problem('surface-controls', `${surface.id}: controls must be "none: <reason>" when empty`)];
  }
  return surface.controls.flatMap((control) => controlRules(surface, control));
}

/**
 * Checks the content rules of a structurally sound matrix.
 * @param {object} matrix a matrix that passed validateStructure
 * @returns {{code:string,message:string}[]} problems (control-*, default-state, surface-controls, no-search, deliverable)
 */
export function validateRules(matrix) {
  const found = matrix.surfaces.flatMap(surfaceRules);
  const backend = matrix.searched?.backend;
  if (!Array.isArray(backend) || !backend.some(isText)) found.push(problem('no-search', 'searched.backend is empty: record the backend search commands and hit counts'));
  const deliverable = matrix.deliverable ?? {};
  for (const field of ['reviewUrl', 'mockExcluded']) {
    if (!isText(deliverable[field])) found.push(problem('deliverable', `deliverable.${field} is empty`));
  }
  return found;
}
