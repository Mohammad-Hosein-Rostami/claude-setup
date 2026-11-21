// Purpose: validate a matrix.json with hand-written schema rules (no dependency) and return problems, never throw.
// Exports: problem(code, message, extra), normalizeNode(node), namesNode(text, node), isText(v), isReason(v), isPlaceholder(v), isValidWidth(v), noneReason(v),
//   validateStructure(matrix), validateRules(matrix), figmaWidthRules(matrix), SURFACE_KINDS, STATUSES, REST_STATE, MIN_REASON_CHARS, RULES, SCHEMES, controlsOf(surface).
//   Run keys (optional): rule (default|strict), breakpoints (theme breakpoints), schemes (light|dark), settled (the owner's "do not report again" list).
// Invariants: validateStructure checks only what the cell logic needs to run (locales, widths, stateWidths, surface and
//   control ids, control class, cell widths); when it returns problems the caller must stop. validateRules assumes a
//   sound structure and reports the content rules (component, states, reference, default states, searched, deliverable,
//   reasons, `todo` placeholders). The optional Figma keys are checked for shape only: `figma` is {file, framesFile} and
//   `frames` is a list of {node, name, width, cells} or {node, name, width, notBuilt} with unique nodes, and `accepted` a list
//   of {node, surface, state, locale, findings, owner} (the owner is judged by `check`, not here). A width is a positive integer or null. A reason has at least MIN_REASON_CHARS non-space
//   characters. A problem may carry `cell` (the cell label) and `cause` (the root-cause key `check` groups by).
import { defaultStatesFor, isKnownClass, knownClassNames } from './states.mjs';

export const SURFACE_KINDS = ['screen', 'email', 'server-page', 'pdf', 'notification', 'other'];
export const STATUSES = ['pass', 'fail', 'na', 'deferred', 'todo'];
export const REST_STATE = 'rest';
export const MIN_REASON_CHARS = 15;
const NONE_PREFIX = 'none:';
export const RULES = ['default', 'strict'];
export const SCHEMES = ['light', 'dark'];
const DIRECTIONS = ['ltr', 'rtl'];

/** Builds a problem record; `code` is stable (tests and callers match on it), `message` is for people; `extra` may hold `cell` and `cause`. */
export const problem = (code, message, extra = {}) => ({ code, message, ...extra });

/** True for a string that still starts with the TODO placeholder `init` writes. */
export const isPlaceholder = (value) => typeof value === 'string' && /^\s*TODO\b/.test(value);

/** True for a string with a non-blank character. */
export const isText = (value) => typeof value === 'string' && value.trim() !== '';

/** True for a string with at least MIN_REASON_CHARS non-space characters: a real reason, not "n/a". */
export const isReason = (value) => typeof value === 'string' && value.replace(/\s/g, '').length >= MIN_REASON_CHARS;

/** True for a positive integer, null or undefined (no width). Strings, NaN, zero and negatives are not widths. */
export const isValidWidth = (value) => value === null || value === undefined || (Number.isInteger(value) && value > 0);

/** Returns the text after "none:" when `value` starts with it, else null. */
export const noneReason = (value) => (typeof value === 'string' && value.trim().startsWith(NONE_PREFIX) ? value.trim().slice(NONE_PREFIX.length) : null);

/** A Figma node id in its API form: the URL form `12-40` becomes `12:40`; anything else (`I1:2;3:4`) is kept. */
export const normalizeNode = (node) => String(node).trim().replace(/^(\d+)-(\d+)$/, '$1:$2');

/** True when `text` names the node id as a whole token: not inside a longer id (`112:4`, `12:40` for `12:4`, `12:4;5:6`). A colon followed by a space or the end is punctuation, not an id part. */
export function namesNode(text, node) {
  const escaped = normalizeNode(node).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^0-9:;-])${escaped}($|[^0-9:;-]|:(?=\\s|$))`).test(String(text));
}

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

function frameCellProblems(frame) {
  const cells = frame.cells === undefined ? [] : frame.cells;
  const where = `frame ${frame.node}`;
  if (!Array.isArray(cells) || !cells.every((cell) => isObject(cell) && [cell.surface, cell.state, cell.locale].every(isText))) return [problem('shape', `${where}: cells must be an array of {surface, state, locale}`)];
  if (cells.length === 0) return [];
  const found = [];
  if (!Number.isInteger(frame.width) || frame.width <= 0) found.push(problem('shape', `${where}: cells need the frame width as a positive integer`));
  if (isText(frame.notBuilt)) found.push(problem('shape', `${where} has both cells and notBuilt: keep one`));
  return found;
}

function frameStructure(frames) {
  if (frames === undefined) return [];
  if (!Array.isArray(frames) || !frames.every(isObject)) return [problem('shape', 'frames must be an array of objects')];
  const seen = new Set();
  return frames.flatMap((frame) => {
    if (!isText(frame.node)) return [problem('shape', `a frame needs a node id: ${JSON.stringify(frame)}`)];
    const duplicate = seen.has(normalizeNode(frame.node)) ? [problem('shape', `duplicate frame node: ${frame.node}`)] : [];
    seen.add(normalizeNode(frame.node));
    const notBuilt = frame.notBuilt === undefined || typeof frame.notBuilt === 'string' ? [] : [problem('shape', `frame ${frame.node}: notBuilt must be a text`)];
    return [...duplicate, ...notBuilt, ...frameCellProblems(frame)];
  });
}

const isFindingRule = (finding) => isObject(finding) && ((finding.check === 'element' && isText(finding.element)) || (finding.check === 'pixel' && Number.isFinite(finding.maxPercent) && finding.maxPercent >= 0));

function acceptedStructure(accepted) {
  if (accepted === undefined) return [];
  if (!Array.isArray(accepted) || !accepted.every(isObject)) return [problem('shape', 'accepted must be an array of objects')];
  return accepted.flatMap((entry) => {
    const named = [entry.node, entry.surface, entry.state, entry.locale].every(isText);
    const rules = Array.isArray(entry.findings) && entry.findings.length > 0 && entry.findings.every(isFindingRule);
    return [
      ...(named ? [] : [problem('shape', `an accepted entry needs node, surface, state and locale: ${JSON.stringify(entry)}`)]),
      ...(rules ? [] : [problem('shape', `accepted entry for frame ${entry.node}: findings must be a non-empty list of {check:"element",element} or {check:"pixel",maxPercent}`)]),
    ];
  });
}

// The run keys of r9-ui-matrix: the pass rule, the theme breakpoints, the colour schemes and the owner's settled list.
function runKeyStructure(matrix) {
  const found = [];
  if (matrix.rule !== undefined && !RULES.includes(matrix.rule)) found.push(problem('shape', `rule must be ${RULES.join(' or ')}`));
  if (matrix.breakpoints !== undefined && !(Array.isArray(matrix.breakpoints) && matrix.breakpoints.length > 0 && matrix.breakpoints.every((bp) => Number.isInteger(bp) && bp > 1))) found.push(problem('shape', 'breakpoints must be a non-empty list of integers above 1 (the theme breakpoints, e.g. MUI 600, 900, 1200, 1536)'));
  if (matrix.schemes !== undefined && !(Array.isArray(matrix.schemes) && matrix.schemes.length > 0 && matrix.schemes.every((scheme) => SCHEMES.includes(scheme)))) found.push(problem('shape', `schemes must be a non-empty list of ${SCHEMES.join(', ')}`));
  if (matrix.settled !== undefined && !(Array.isArray(matrix.settled) && matrix.settled.every((entry) => isObject(entry) && isText(entry.surface) && isText(entry.state) && isText(entry.what) && isText(entry.owner)))) found.push(problem('shape', 'settled must be a list of {surface, state, locale?, what, owner}: what the owner settled and the reference to his decision'));
  return found;
}

function figmaStructure(figma) {
  if (figma === undefined) return [];
  return isObject(figma) && isText(figma.file) && isText(figma.framesFile) ? [] : [problem('shape', 'figma must be {file, framesFile}: the Figma file key and the path of the frames file')];
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
  return [...common, ...matrix.surfaces.flatMap((surface) => surfaceStructure(surface, seenIds)), ...cellStructure(matrix.cells), ...figmaStructure(matrix.figma), ...frameStructure(matrix.frames), ...acceptedStructure(matrix.accepted), ...runKeyStructure(matrix)];
}

const componentOk = (component) => isText(component) || (isObject(component) && isReason(component.new));

function referenceProblem(reference) {
  if (!isText(reference)) return 'needs a path or "none: <reason>"';
  const reason = noneReason(reference);
  return reason === null || isReason(reason) ? null : `"none:" needs a reason of at least ${MIN_REASON_CHARS} characters after the "none:" prefix (the prefix does not count)`;
}

const UNPROVEN_REFERENCE_CAUSE = 'reference is "none:" but searched.reference is empty';

function controlRules(surface, control, referenceSearched) {
  const where = `${surface.id} ${control.id}`;
  const states = Array.isArray(control.states) ? control.states : [];
  const dropped = isObject(control.dropped) ? control.dropped : {};
  const found = [];
  if (!componentOk(control.component)) found.push(problem('control-component', `${where}: component needs a path or {new: "<reason of ${MIN_REASON_CHARS}+ characters>"}`));
  if (states.length === 0) found.push(problem('control-states', `${where}: states is empty`));
  const badReference = referenceProblem(control.reference);
  if (badReference) found.push(problem('control-reference', `${where}: reference ${badReference}`));
  else if (noneReason(control.reference) !== null && !referenceSearched) {
    found.push(problem('unproven-reference', `${where}: reference is "none:" but searched.reference is empty: list the commands you ran to look for a reference app or API, each with its hit count`, { cause: UNPROVEN_REFERENCE_CAUSE }));
  }
  if (states.length > 0) {
    for (const state of defaultStatesFor(control.class)) {
      if (!states.includes(state) && !isReason(dropped[state])) found.push(problem('default-state', `${where}: default ${control.class} state "${state}" is neither covered nor dropped with a reason`));
    }
  }
  return found;
}

function surfaceRules(surface, referenceSearched) {
  if (typeof surface.controls === 'string') {
    return isReason(noneReason(surface.controls)) ? [] : [problem('surface-controls', `${surface.id}: controls must be "none: <reason of ${MIN_REASON_CHARS}+ characters>" when empty (the "none:" prefix does not count)`)];
  }
  if (surface.controls.length === 0) {
    return [problem('todo', `${surface.id}: controls is empty: list its controls or write "none: <reason>"`, { cause: 'surface with an empty controls list' })];
  }
  return surface.controls.flatMap((control) => controlRules(surface, control, referenceSearched));
}

// Values `init` fills with a TODO placeholder; a matrix that still has one is not finished.
function placeholderProblems(matrix) {
  const fields = [
    ...matrix.surfaces.map((surface) => [`surface ${surface.id}: source`, surface.source]),
    ...['backend', 'siblings', 'reference'].flatMap((name) => (Array.isArray(matrix.searched?.[name]) ? matrix.searched[name] : []).map((value) => [`searched.${name}`, value])),
    ['deliverable.reviewUrl', matrix.deliverable?.reviewUrl],
    ['deliverable.mockExcluded', matrix.deliverable?.mockExcluded],
  ];
  return fields.filter(([, value]) => isPlaceholder(value)).map(([name]) => problem('todo', `${name} is still a TODO placeholder`, { cause: 'placeholder text still in the matrix' }));
}

/**
 * Checks the content rules of a structurally sound matrix.
 * @param {object} matrix a matrix that passed validateStructure
 * @returns {{code:string,message:string}[]} problems (control-*, unproven-reference, default-state, surface-controls, state-widths, no-search, deliverable, todo)
 */
export function validateRules(matrix) {
  const reference = matrix.searched?.reference;
  const referenceSearched = Array.isArray(reference) && reference.some((value) => isText(value) && !isPlaceholder(value));
  const found = [...matrix.surfaces.flatMap((surface) => surfaceRules(surface, referenceSearched)), ...placeholderProblems(matrix)];
  const backend = matrix.searched?.backend;
  if (!Array.isArray(backend) || !backend.some(isText)) found.push(problem('no-search', 'searched.backend is empty: record the backend search commands and hit counts'));
  const deliverable = matrix.deliverable ?? {};
  if (!isText(deliverable.reviewUrl)) found.push(problem('deliverable', 'deliverable.reviewUrl is empty'));
  if (!isReason(deliverable.mockExcluded)) found.push(problem('deliverable', `deliverable.mockExcluded needs the quoted build/grep proof (${MIN_REASON_CHARS}+ characters)`));
  if (matrix.stateWidths !== undefined && !isReason(matrix.stateWidthsReason)) found.push(problem('state-widths', `stateWidths needs stateWidthsReason (${MIN_REASON_CHARS}+ characters)`));
  return [...found, ...figmaWidthRules(matrix)];
}

/**
 * A matrix with a Figma source compares every frame width (G2: the `frames` inventory is required) and holds each theme
 * breakpoint -1 and +0 among its widths (R118), where the invariant checks run between the frames.
 * @param {object} matrix a structurally sound matrix
 * @returns {{code:string,message:string}[]} frames-missing, breakpoint-widths
 */
export function figmaWidthRules(matrix) {
  if (matrix.figma === undefined) return [];
  const found = [];
  if (!Array.isArray(matrix.frames) || matrix.frames.length === 0) found.push(problem('frames-missing', 'the matrix has a Figma source but no frames inventory: run ui-check figma-frames, then ui-coverage expand, so every frame width is compared'));
  if (matrix.breakpoints === undefined) return found; // init writes them for a Figma matrix (R118 default); a matrix without them demands none
  const widths = new Set(matrix.widths);
  const lacking = matrix.breakpoints.flatMap((bp) => [bp - 1, bp]).filter((width) => !widths.has(width));
  if (lacking.length > 0) found.push(problem('breakpoint-widths', `widths lack ${lacking.join(', ')}: each breakpoint needs its -1 and +0 width (add them to widths, then run expand)`));
  return found;
}
