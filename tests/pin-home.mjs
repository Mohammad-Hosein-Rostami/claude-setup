// Pins HOME and USERPROFILE to a fixed directory outside the temp dir, so guard tests do not depend on the real HOME or
// on a HOME that lives inside os.tmpdir() (the guard treats paths under the temp dir as safe to delete, which would make
// "cd ~ && rm -rf x" pass). Import it FIRST in a test file: modules such as guard-log.mjs and remote.mjs read homedir()
// when they load. Exports: PINNED_HOME. Each test file runs in its own process, so the mutation stays local.
import { resolve } from 'node:path';

export const PINNED_HOME = resolve('/home/guard-test');
process.env.HOME = PINNED_HOME;
process.env.USERPROFILE = PINNED_HOME;
