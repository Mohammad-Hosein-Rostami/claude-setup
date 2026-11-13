// Purpose: run a freshly written fake executable once so the OS first-exec scan (macOS XProtect/syspolicy, ~3 s) does not land inside a timed test.
// Exports: warmExec(path). Invariant: each fake script must exit 0 at its top when FAKE_WARM is set, so the warm-up has no side effects.
import { spawnSync } from 'node:child_process';

/**
 * @param {string} path executable the test just wrote and chmod-ed
 * @returns {void}
 */
export function warmExec(path) {
  spawnSync(path, [], { env: { ...process.env, FAKE_WARM: '1' }, stdio: 'ignore' });
}
