// Purpose: build the skeleton of a `ui-check batch --states` file from a coverage matrix, so the state names, surfaces,
// locales and widths agree with the matrix by construction (what `ui-coverage check --results` matches on).
// Exports: scaffoldStates(matrix, existing).
// Invariants: pure (inputs are never mutated). One entry per surface + state + locale (letter case of the locale ignored)
// that still has an open cell (anything but pass, na or deferred); its widths are the open widths, in matrix order. An
// existing states file keeps every entry and its `defaults` exactly as they are; only missing entries are appended.
import { cellKey, expandMatrix, expectedCells, normalizeLocale } from './cells.mjs';

const DONE = new Set(['pass', 'na', 'deferred']);

const entryKey = (entry) => JSON.stringify([entry.surface, entry.state, normalizeLocale(entry.locale ?? null)]);

/**
 * The entries a matrix still needs, one per surface + state + locale with its open widths grouped.
 * @param {object} matrix a structurally sound matrix (cells optional; missing cells count as todo)
 * @returns {{surface: string, state: string, locale: string, widths: number[], url: string, steps: []}[]}
 */
function openEntries(matrix) {
  const wanted = new Set(expectedCells(matrix).map(cellKey));
  const open = expandMatrix(matrix).cells.filter((cell) => wanted.has(cellKey(cell)) && !DONE.has(cell.status));
  const grouped = new Map();
  for (const { surface, state, locale, width } of open) {
    const key = entryKey({ surface, state, locale });
    const entry = grouped.get(key) ?? { surface, state, locale, widths: [], url: '', steps: [] };
    entry.widths.push(width);
    grouped.set(key, entry);
  }
  return [...grouped.values()];
}

/**
 * Skeleton states file for the open cells of a matrix.
 * @param {object} matrix a structurally sound matrix
 * @param {{defaults?: object, states?: object[]}|null} [existing] parsed states file to keep and extend
 * @returns {{defaults: object, states: object[], added: number}} the file content (`defaults` for the agent to fill) and how many entries were added
 */
export function scaffoldStates(matrix, existing = null) {
  const kept = existing?.states ?? [];
  const have = new Set(kept.map(entryKey));
  const added = openEntries(matrix).filter((entry) => !have.has(entryKey(entry)));
  return { defaults: existing?.defaults ?? {}, states: [...kept, ...added], added: added.length };
}
