// Purpose: write the skeleton of a new matrix: locales, widths and surfaces from the command line, TODO placeholders for
// everything the task has to find out, and a todo cell for every surface x locale x width, so `check` rejects it with
// `todo` problems only until the placeholders are replaced.
// Exports: initMatrix({locales, widths, surfaces, framesSource, rule, breakpoints, schemes}), parseLocales(text), parseWidths(text), parseSurfaces(text),
//   parseBreakpoints(text), parseRule(text), parseSchemes(text), DEFAULT_BREAKPOINTS.
// Invariants: pure; the parse functions throw a TypeError with a message for the person (the CLI turns it into exit 2).
//   Every placeholder starts with `TODO` (see isPlaceholder in shape.mjs); surfaces start as `screen` with `controls: []`.
import { expandMatrix } from './cells.mjs';
import { validateStructure } from './shape.mjs';

const TODO_SOURCE = 'TODO: path of the file that renders this surface';
const TODO_SEARCH = 'TODO: the search command you ran, with its hit count (even 0 hits)';
const splitList = (text) => String(text ?? '').split(',').map((part) => part.trim()).filter(Boolean);

/** Parses `en:ltr,fa:rtl` into `[{tag, dir}]`. */
export function parseLocales(text) {
  const locales = splitList(text).map((entry) => {
    const [tag, dir, ...extra] = entry.split(':');
    if (!tag || !['ltr', 'rtl'].includes(dir) || extra.length > 0) throw new TypeError(`--locales entries look like en:ltr or fa:rtl, got "${entry}"`);
    return { tag, dir };
  });
  if (locales.length === 0) throw new TypeError('--locales needs at least one entry like en:ltr');
  return locales;
}

/** Parses `320,768,1280` into positive integers. */
export function parseWidths(text) {
  const widths = splitList(text).map(Number);
  if (widths.length === 0 || !widths.every((width) => Number.isInteger(width) && width > 0)) throw new TypeError(`--widths needs positive integers like 320,768,1280, got "${text ?? ''}"`);
  return widths;
}

/** Parses `login,signup` into surface ids. */
export function parseSurfaces(text) {
  const ids = splitList(text);
  if (ids.length === 0) throw new TypeError('--surfaces needs at least one surface id like login,signup');
  return ids;
}

/** The R118 default breakpoints (MUI 600, 900, 1200, 1536), used when a Figma matrix gets no --breakpoints (UNCONFIRMED: owner question 7). */
export const DEFAULT_BREAKPOINTS = Object.freeze([600, 900, 1200, 1536]);

/** Parses `600,900` into breakpoints (integers above 1). */
export function parseBreakpoints(text) {
  const values = splitList(text).map(Number);
  if (values.length === 0 || !values.every((bp) => Number.isInteger(bp) && bp > 1)) throw new TypeError(`--breakpoints needs integers above 1 like 600,900,1200,1536, got "${text ?? ''}"`);
  return values;
}

/** Parses `strict` or `default`. */
export function parseRule(text) {
  if (!['default', 'strict'].includes(text)) throw new TypeError(`--rule is strict (the owner said exact or pixel perfect) or default, got "${text ?? ''}"`);
  return text;
}

/** Parses `light,dark` into the matrix colour schemes. */
export function parseSchemes(text) {
  const schemes = splitList(text);
  if (schemes.length === 0 || !schemes.every((scheme) => ['light', 'dark'].includes(scheme))) throw new TypeError(`--schemes lists light and/or dark, got "${text ?? ''}"`);
  return schemes;
}

/** Widths of a new matrix: the given ones, every frame width, and each breakpoint -1 and +0, ascending and unique. */
function matrixWidths(widths, frames, breakpoints) {
  const all = [...(widths ?? []), ...frames.map((frame) => frame.width), ...breakpoints.flatMap((bp) => [bp - 1, bp])];
  return [...new Set(all.filter((width) => Number.isInteger(width) && width > 0))].sort((a, b) => a - b);
}

/**
 * The skeleton matrix, expanded to todo cells.
 * @param {{locales: {tag: string, dir: string}[], widths?: number[], surfaces: string[], framesSource?: {path: string, data: {file: string, frames: object[]}}, rule?: string, breakpoints?: number[], schemes?: string[]}} input
 *   widths = the given widths plus every frame width plus each breakpoint -1 and +0 (breakpoints default to DEFAULT_BREAKPOINTS when a frames file is given);
 *   parsed command-line values; `framesSource` is the frames file (its path as the matrix will name it, relative to the matrix, and its parsed content):
 *   the matrix then gets a `figma` section and every frame with `cells: []`
 * @returns {object} a matrix that passes the structure check and fails `check` with `todo` problems
 * @throws {TypeError} when the values do not form a sound matrix (for example a duplicate surface id)
 */
export function initMatrix({ locales, widths, surfaces, framesSource, rule, breakpoints, schemes }) {
  const frames = framesSource?.data.frames ?? [];
  const bps = breakpoints ?? (framesSource ? DEFAULT_BREAKPOINTS : []);
  const all = matrixWidths(widths, frames, bps);
  if (all.length === 0) throw new TypeError('--widths needs positive integers like 320,768,1280 (or give --frames)');
  const matrix = {
    locales,
    widths: all,
    ...(rule ? { rule } : {}),
    ...(bps.length > 0 ? { breakpoints: [...bps] } : {}),
    ...(schemes ? { schemes } : {}),
    searched: { backend: [TODO_SEARCH], siblings: [TODO_SEARCH], reference: [TODO_SEARCH] },
    deliverable: { reviewUrl: 'TODO: URL or path of the live review page', mockExcluded: 'TODO: the build and grep command that proves no dev-only mock ships, with its output' },
    surfaces: surfaces.map((id) => ({ id, kind: 'screen', source: TODO_SOURCE, controls: [] })),
    ...(framesSource ? { figma: { file: framesSource.data.file, framesFile: framesSource.path } } : {}),
  };
  const problems = validateStructure(matrix);
  if (problems.length > 0) throw new TypeError(problems.map((p) => p.message).join('; '));
  return expandMatrix(matrix, frames);
}
