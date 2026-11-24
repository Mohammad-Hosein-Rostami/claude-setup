// Pins HOME and USERPROFILE to a fixed directory outside the temp dir, so guard tests do not depend on the real HOME or
// on a HOME that lives inside os.tmpdir() (the guard treats paths under the temp dir as safe to delete, which would make
// "cd ~ && rm -rf x" pass). Import it FIRST in a test file: modules such as guard-log.mjs and remote.mjs read homedir()
// when they load. Exports: PINNED_HOME. Each test file runs in its own process, so the mutation stays local.
// It also drops the session's CLAUDE_* switches and markers (clean-env.mjs OUR_SWITCH) from this process: an imported guard reads
// CLAUDE_CODE_SESSION_ID and CLAUDE_GUARD_ASK from process.env, and a session's TMPDIR may lie in that session's own folder, which
// the guard frees, so "rm -rf $TMPDIR/.." would run unasked there.
import { resolve } from 'node:path';
import { OUR_SWITCH } from './clean-env.mjs';

export const PINNED_HOME = resolve('/home/guard-test');
process.env.HOME = PINNED_HOME;
process.env.USERPROFILE = PINNED_HOME;
for (const name of Object.keys(process.env)) if (OUR_SWITCH.test(name)) delete process.env[name];
