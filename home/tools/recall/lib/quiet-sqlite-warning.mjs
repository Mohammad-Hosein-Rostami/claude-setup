// Purpose: keep stderr clean on Node 22, where the first use of node:sqlite prints "ExperimentalWarning: SQLite is an
// experimental feature and might change at any time" (two lines, every run, also inside hook output). Node 23 and later
// print nothing, so there this file does nothing.
// It wraps process.emitWarning and drops exactly that one warning (type ExperimentalWarning, message mentions SQLite);
// every other warning goes through unchanged, so deprecations and other experimental features still print.
// Invariants: MUST be the first import of every file that loads node:sqlite, and that file must load it with
// `process.getBuiltinModule('node:sqlite')` in its body, never with `import ... from 'node:sqlite'`: Node loads a static
// builtin import (and prints the warning) before any module body runs, even one imported earlier, so only a load in the
// body comes after this file ran. Today: lib/store.mjs (so every recall command, the checkpoint job and the tests) and
// hooks/recall-digest.mjs. tests/quiet-sqlite-warning.test.mjs checks both rules for every file that mentions node:sqlite.
// A `process.on('warning')` listener does not see the dropped warning; that is intended.
// Exports: none (the import is the effect).
const original = process.emitWarning;

/** Type and message of the arguments process.emitWarning takes: (warning, type | options, ...) with warning a string or Error. */
function describeWarning(warning, typeOrOptions) {
  const message = warning instanceof Error ? warning.message : String(warning);
  if (typeof typeOrOptions === 'string') return { type: typeOrOptions, message };
  if (typeOrOptions?.type) return { type: typeOrOptions.type, message };
  return { type: warning instanceof Error ? warning.name : 'Warning', message };
}

process.emitWarning = function emitWarningWithoutSqliteNotice(warning, typeOrOptions, ...rest) {
  const { type, message } = describeWarning(warning, typeOrOptions);
  if (type === 'ExperimentalWarning' && /sqlite/i.test(message)) return undefined;
  return Reflect.apply(original, this, [warning, typeOrOptions, ...rest]);
};
