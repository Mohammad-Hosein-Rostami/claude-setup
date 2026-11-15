// Purpose: small path rules shared by the readers: turn a value written in a config into a path to check.
// Exports: resolveRef, hasGlobChars, folderBeforeWildcard.
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
