// Purpose: heuristic readers whose answer is a hint (kind ends in `?`): paths in package.json scripts, and relative
//   string literals in *.config.* and eslint files. They guess from shape, so they can be wrong; they never fail a run.
// Exports: readScriptPaths, readConfigPaths.
// Invariants: a script token counts when it starts with ./ or ../, or has a `/` and a file extension; tokens with `$`,
//   `*`, `=` and URLs are skipped. A config string counts when it starts with ./ or ../ and has no `*` or `${`. Paths
//   a string that is a property name (`'./Name': ...`) or the value of an output or cache key is skipped. Paths
//   are relative to the package folder (scripts) or to the file (configs). A config import without an extension also
//   matches a file with a code extension, like the bundler resolves it.
import { dirname } from 'node:path';
import { objectGet, parseJsonc } from './jsonc.mjs';
import { stringLiterals } from './js-strings.mjs';
import { codePathExists, resolveRef } from './ref-path.mjs';
import { scanYaml } from './yaml-lines.mjs';

// A value under a key like outDir or cacheDir is where something is written, so it may not exist yet.
const OUTPUT_KEY = /out|cache|dist|report|coverage|te?mp|^dir$/i;
const SHELL_SEPARATORS = /[\s;|&<>()]+/;
const SKIPPED_TOKEN = /[$*=]|:\/\//;
const isRelativeStart = (value) => value.startsWith('./') || value.startsWith('../');

function isScriptPath(token) {
  if (token === '' || SKIPPED_TOKEN.test(token) || token.startsWith('@')) return false;
  return isRelativeStart(token) || (token.includes('/') && /\.[A-Za-z0-9]+$/.test(token));
}

/**
 * @param {{abs: string, text: string}} file a package.json
 * @param {{disk: import('./disk.mjs').Disk}} context
 */
export function readScriptPaths(file, { disk }) {
  const folder = dirname(file.abs);
  const scripts = objectGet(parseJsonc(file.text), 'scripts');
  return (scripts?.entries ?? [])
    .filter((script) => script.node.kind === 'string')
    .flatMap((script) => script.node.value.split(SHELL_SEPARATORS)
      .map((token) => token.replace(/^["']+|["']+$/g, ''))
      .filter((token) => isScriptPath(token) && !disk.exists(resolveRef(folder, token)))
      .map((token) => ({ kind: 'script-path?', value: token, line: script.node.line })));
}

function configCandidates(file) {
  if (/\.ya?ml$/.test(file.rel)) return scanYaml(file.text).filter((entry) => entry.value !== null).map((entry) => ({ value: entry.value, line: entry.line, key: entry.key }));
  return stringLiterals(file.text).filter((literal) => !literal.isKey);
}

/**
 * @param {{abs: string, rel: string, text: string}} file a *.config.* or eslint file
 * @param {{disk: import('./disk.mjs').Disk}} context
 */
export function readConfigPaths(file, { disk }) {
  const folder = dirname(file.abs);
  return configCandidates(file)
    .filter(({ key }) => !OUTPUT_KEY.test(key ?? ''))
    .filter(({ value }) => isRelativeStart(value) && !value.includes('*') && !value.includes('${') && !/\s/.test(value))
    .filter(({ value }) => !codePathExists(disk, resolveRef(folder, value)))
    .map(({ value, line }) => ({ kind: 'config-path?', value, line }));
}
