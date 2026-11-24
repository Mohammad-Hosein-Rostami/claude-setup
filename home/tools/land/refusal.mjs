// Purpose: the refusal `land` prints, and the checks both land.mjs and test-gate.mjs make before anything moves.
// Exports: LandRefusal, firstLine, refuseUnclean.
// Invariants: a check that cannot read a fact refuses; it never takes an unreadable status as clean.
import { changedFileCount, inProgressOperation } from '../git-tidy/lib/repo.mjs';

/** A check that failed, or a step that stopped; the message says why and what to do. The CLI prints it and exits 1. */
export class LandRefusal extends Error {}

/** git's first message line; a progress line ends in a carriage return, so CR counts as a line end too. */
export const firstLine = (text) => text.split(/[\r\n]+/).find((line) => line.trim() !== '')?.trim() ?? '';

/**
 * Refuses when the checkout at `dir` has an unfinished operation or any changed or untracked file.
 * @param {string} what names the checkout in the message ("the base checkout")
 * @param {string} dir the checkout's folder
 * @throws {LandRefusal} when it is not clean, or git cannot read its status
 */
export function refuseUnclean(what, dir) {
  const operation = inProgressOperation(dir);
  if (operation !== null) throw new LandRefusal(`${what} (${dir}) has an unfinished ${operation}; finish or abort it first`);
  const changed = changedFileCount(dir);
  if (changed === null) throw new LandRefusal(`git cannot read the status of ${what} (${dir})`);
  if (changed > 0) throw new LandRefusal(`${what} (${dir}) has ${changed} changed or untracked file(s); commit or move them first`);
}
