// Purpose: write the skeleton of a new matrix: locales, widths and surfaces from the command line, TODO placeholders for
// everything the task has to find out, and a todo cell for every surface x locale x width, so `check` rejects it with
// `todo` problems only until the placeholders are replaced.
// Exports: initMatrix({locales, widths, surfaces}), parseLocales(text), parseWidths(text), parseSurfaces(text).
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

/**
 * The skeleton matrix, expanded to todo cells.
 * @param {{locales: {tag: string, dir: string}[], widths: number[], surfaces: string[]}} input parsed command-line values
 * @returns {object} a matrix that passes the structure check and fails `check` with `todo` problems
 * @throws {TypeError} when the values do not form a sound matrix (for example a duplicate surface id)
 */
export function initMatrix({ locales, widths, surfaces }) {
  const matrix = {
    locales,
    widths,
    searched: { backend: [TODO_SEARCH], siblings: [TODO_SEARCH], reference: [TODO_SEARCH] },
    deliverable: { reviewUrl: 'TODO: URL or path of the live review page', mockExcluded: 'TODO: the build and grep command that proves no dev-only mock ships, with its output' },
    surfaces: surfaces.map((id) => ({ id, kind: 'screen', source: TODO_SOURCE, controls: [] })),
  };
  const problems = validateStructure(matrix);
  if (problems.length > 0) throw new TypeError(problems.map((p) => p.message).join('; '));
  return expandMatrix(matrix);
}
