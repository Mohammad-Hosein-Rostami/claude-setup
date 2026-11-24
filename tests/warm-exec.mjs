// Purpose: run a freshly written fake executable once so the OS first-exec scan (macOS XProtect/syspolicy, ~3 s) does not land inside a timed test.
// Exports: warmExec(path), warmExecInert(path). Invariant: each fake script must exit 0 at its top when FAKE_WARM is set, so the
// warm-up has no side effects; warmExecInert also warms a script that does not know FAKE_WARM (a copy of a real hook).
import { spawnSync } from 'node:child_process';
import { cleanEnv } from './clean-env.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

/**
 * @param {string} path executable the test just wrote and chmod-ed
 * @returns {void}
 */
export function warmExec(path) {
  spawnSync(path, [], { env: cleanEnv({ FAKE_WARM: '1' }), stdio: 'ignore' });
}

let emptyFolder; // made on first use: a PATH entry and a working folder that hold nothing

/**
 * Warms `path` without letting it do anything: PATH is one empty folder and the working folder is empty, so a `#!/usr/bin/env`
 * script stops at once (env finds no interpreter) and a `#!/bin/sh` script finds no command. The OS checks the file when it is
 * executed, before its interpreter starts, so the next run is fast all the same (measured on macOS: 250 ms, then 3-20 ms).
 * @param {string} path executable just written and chmod-ed
 * @returns {void}
 */
export function warmExecInert(path) {
  emptyFolder ??= makeTempDir('warm-empty-');
  spawnSync(path, [], { cwd: emptyFolder, env: cleanEnv({ FAKE_WARM: '1', PATH: emptyFolder }), stdio: 'ignore' });
}
