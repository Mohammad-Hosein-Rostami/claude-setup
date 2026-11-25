// The real git binary first on a test's PATH, on macOS where `git` is Apple's /usr/bin/git. Exports: fastGitPath(env).
// Why: /usr/bin/git is an xcrun shim that looks up the developer folder and then runs the real git; that lookup costs more than a
// small git command itself (a git-tidy test file measured 16.8 s through the shim, 6.3 s with the real git first). The shim runs that
// same binary, so a test still runs the git the machine has; it only skips the lookup.
// How: once per process, `/usr/bin/git --exec-path` names the real git's folder; a folder made by makeTempDir holds one symlink `git`
// to that binary, and fastGitPath puts the folder first on PATH. Nothing else is in that folder, so no other tool changes.
// Invariants: only on macOS, only when the first git on the given PATH is the shim (a git the owner put earlier on PATH stays the
// one that runs), and never when the lookup fails; then the PATH is returned unchanged.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync, symlinkSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { cleanEnv } from './clean-env.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const XCRUN_SHIM = '/usr/bin/git';
let linkFolder; // undefined: not looked up yet; null: no shim, or the lookup failed

/** @returns {string | null} the real path of `file` when it is there and runnable, else null */
function runnable(file) {
  try {
    accessSync(file, constants.X_OK);
    return realpathSync(file);
  } catch {
    return null;
  }
}

/** @returns {string | null} the real path of the first runnable `git` on `path`, or null when there is none */
function firstGit(path) {
  for (const folder of path.split(delimiter)) {
    const found = folder === '' ? null : runnable(join(folder, 'git'));
    if (found !== null) return found;
  }
  return null;
}

/** @returns {string | null} a folder holding only a `git` link to the binary the shim runs, made at the first call */
function realGitFolder() {
  if (linkFolder !== undefined) return linkFolder;
  linkFolder = null;
  const lookup = spawnSync(XCRUN_SHIM, ['--exec-path'], { encoding: 'utf8', env: cleanEnv() });
  if (lookup.status !== 0) return linkFolder;
  const real = runnable(join(lookup.stdout.trim(), 'git'));
  if (real === null || real === runnable(XCRUN_SHIM)) return linkFolder;
  const folder = makeTempDir('fast-git-');
  symlinkSync(real, join(folder, 'git'));
  linkFolder = folder;
  return linkFolder;
}

/**
 * @param {Record<string, string | undefined>} env a child's environment
 * @returns {{ PATH?: string }} `{ PATH }` with the real git's folder first when `env.PATH` would run the macOS shim, else `{}`
 */
export function fastGitPath(env) {
  if (process.platform !== 'darwin' || typeof env.PATH !== 'string') return {};
  const shim = runnable(XCRUN_SHIM);
  if (shim === null || firstGit(env.PATH) !== shim) return {};
  const folder = realGitFolder();
  return folder === null ? {} : { PATH: `${folder}${delimiter}${env.PATH}` };
}
