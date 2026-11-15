// Purpose: small path rules shared by the readers: turn a value written in a config into a path to check.
// Exports: resolveRef, hasGlobChars, folderBeforeWildcard, codePathExists.
// Invariants: a Windows `\` separator in a value is read as `/`; the value printed in a finding stays as written.
import { resolve } from 'node:path';

/** The absolute path a value points to, from the folder `base`. */
export const resolveRef = (base, value) => resolve(base, value.replaceAll('\\', '/'));

/** True when the value holds a glob character. */
export const hasGlobChars = (value) => /[*?[{]/.test(value);

/** For `src/app/*` or `src/app*`: the folder part before the first `*` (`src/app/`, `src/`), so a path with a wildcard can still be checked. */
export function folderBeforeWildcard(value) {
  const prefix = value.replaceAll('\\', '/').split('*')[0];
  return prefix.slice(0, prefix.lastIndexOf('/') + 1);
}

const CODE_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json'];
const TYPESCRIPT_FOR = { '.js': '.ts', '.mjs': '.mts', '.cjs': '.cts', '.jsx': '.tsx' };

/** True when the path exists as written or the way a bundler resolves it: plus a code extension, `/index` plus one, or `.js` for a `.ts` source. */
export function codePathExists(disk, path) {
  const swapped = Object.entries(TYPESCRIPT_FOR).find(([from]) => path.endsWith(from));
  const candidates = [path, ...CODE_EXTENSIONS.map((extension) => path + extension), ...CODE_EXTENSIONS.map((extension) => `${path}/index${extension}`)];
  if (swapped) candidates.push(path.slice(0, -swapped[0].length) + swapped[1]);
  return candidates.some((candidate) => disk.exists(candidate));
}
