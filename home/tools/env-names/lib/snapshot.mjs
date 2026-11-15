// Reads a saved snapshot (the JSON `list --save` writes) back, and refuses anything else.
// Exports: parseSnapshot(text) -> snapshot object; throws UsageError with a plain reason.
// Invariants: strict shape and version check, no guessing. A reason names the field only: it never repeats a value found in
//   the file, and the JSON parser's own message (which quotes the start of the text) is never used, so passing an env file
//   by mistake cannot print any of it.
import { UsageError } from './usage-error.mjs';

const SUPPORTED_VERSION = 1;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringList = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');

const isEnvFileEntry = (entry) =>
  isObject(entry) && typeof entry.path === 'string' && isStringList(entry.names) && entry.names.every((name) => NAME_PATTERN.test(name))
  && Number.isInteger(entry.otherLines) && entry.otherLines >= 0 && (entry.status === undefined || typeof entry.status === 'string')
  && (entry.hiddenNames === undefined || (Number.isInteger(entry.hiddenNames) && entry.hiddenNames >= 0));

/** A map of variable name -> list of `file:line` strings. */
const isReferenceMap = (value) => isObject(value) && Object.entries(value).every(([name, refs]) => NAME_PATTERN.test(name) && isStringList(refs));

const FIELD_CHECKS = [
  ['envFiles', (value) => Array.isArray(value) && value.every(isEnvFileEntry), 'is not a list of { path, names, otherLines }'],
  ['readByCode', isReferenceMap, 'is not a map of variable name to a list of file:line'],
  ['deploy', isReferenceMap, 'is not a map of variable name to a list of file:line'],
];

/**
 * @param {string} text the snapshot file content
 * @returns the snapshot (version 1: envFiles, readByCode, deploy and the rest of what `list --json` prints)
 */
export function parseSnapshot(text) {
  let snapshot;
  try {
    snapshot = JSON.parse(text);
  } catch {
    throw new UsageError('the snapshot is not valid JSON (save one with `list --save <file>`)');
  }
  if (!isObject(snapshot)) throw new UsageError('the snapshot is not an object (save one with `list --save <file>`)');
  if (snapshot.version !== SUPPORTED_VERSION) throw new UsageError(`the snapshot version is not ${SUPPORTED_VERSION}, this tool reads version ${SUPPORTED_VERSION} only`);
  for (const [field, isValid, reason] of FIELD_CHECKS) {
    if (!isValid(snapshot[field])) throw new UsageError(`the snapshot field ${field} ${reason}`);
  }
  return snapshot;
}
