// Mutant runs of test-pass: apply each mutant patch to a private copy of the working tree, run the keep-green command, and count
// the mutants it kills from the exit codes (ALIGN-3 A108: the count is never typed by a model).
// Exports: runMutants({ repo, patches, command, timeoutMs }) -> { killed, n, results, error? }.
// Invariants: the real working tree is never changed (the copy is a temp folder without `.git`, removed afterwards); the command
//   must pass in the copy before any patch, else no count is given; a patch that does not apply counts in n as not killed (a mutant
//   that never ran proves nothing); a run that times out counts as killed (the mutant hung the tests), and says so.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const SKIPPED_IN_COPY = new Set(['.git']); // a copied .git file of a worktree would point at the real index
const OUTPUT_LIMIT = 256 << 20;

/** Runs `command` (argv, no shell) in `folder`; { exit, timedOut }. */
function runIn(folder, command, timeoutMs) {
  const result = spawnSync(command[0], command.slice(1), { cwd: folder, stdio: 'pipe', timeout: timeoutMs, maxBuffer: OUTPUT_LIMIT });
  const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM';
  return { exit: result.status ?? 1, timedOut };
}

/** git apply (or its reverse) of one patch in the copy, which has no .git: git applies it as a plain patch. The ceiling keeps git
 *  from finding a repository above the temp folder and applying the patch relative to that one. */
const applyPatch = (folder, patch, reverse) => spawnSync('git', ['apply', ...(reverse ? ['-R'] : []), resolve(patch)],
  { cwd: folder, stdio: 'pipe', env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(folder) } }).status === 0;

/** One mutant: apply, run, revert; { patch, outcome: killed|survived|not-applied|not-reverted, exit?, timedOut? }. */
function runOne(copy, patch, command, timeoutMs) {
  if (!applyPatch(copy, patch, false)) return { patch: basename(patch), outcome: 'not-applied' };
  const { exit, timedOut } = runIn(copy, command, timeoutMs);
  const outcome = exit !== 0 || timedOut ? 'killed' : 'survived';
  if (!applyPatch(copy, patch, true)) return { patch: basename(patch), outcome, exit, timedOut, notReverted: true };
  return { patch: basename(patch), outcome, exit, timedOut };
}

/**
 * Runs every mutant patch against the keep-green command in one private copy of the repo's working tree.
 * @param {{repo: string, patches: string[], command: string[], timeoutMs: number}} options repo: the top folder; command: argv
 * @returns {{killed: number, n: number, results: object[], error?: string}} error: why no count was given (then killed and n are 0)
 */
export function runMutants({ repo, patches, command, timeoutMs }) {
  const copy = mkdtempSync(join(tmpdir(), 'test-pass-mutants-'));
  try {
    cpSync(repo, copy, { recursive: true, verbatimSymlinks: true, filter: (source) => !SKIPPED_IN_COPY.has(basename(source)) });
    const unmutated = runIn(copy, command, timeoutMs);
    if (unmutated.exit !== 0) return { killed: 0, n: 0, results: [], error: `the keep-green command exits ${unmutated.exit} in the private copy before any mutant: no count (fix the command or the copy first)` };
    const results = [];
    for (const patch of patches) {
      const result = runOne(copy, patch, command, timeoutMs);
      results.push(result);
      if (result.notReverted) return { killed: 0, n: 0, results, error: `mutant ${result.patch} could not be reverted in the copy: the later mutants would run on a changed tree, no count` };
    }
    return { killed: results.filter((result) => result.outcome === 'killed').length, n: patches.length, results };
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}
