// Purpose: the tick land prints after a landing (land.mjs): `board tick` of the base checkout with the plans its ticks remember
//   (../board/lib/tick.mjs runTick, run in this process), on the session's board after one forced refresh, so the boss sees the
//   next round without a second call.
// Exports: sessionBoard(env) -> board | null, tickAfterLand(repoDir, env) -> { lines, error }, printTickAfterLand(checkout).
// Invariants: the tick writes only what `board tick` writes (the remembered plans list); it never sets land's exit code. A tick
//   that fails (runTick's exit 2) returns its first stderr line as `error` and no lines; a tick with findings (exit 1) is a tick.
//   It runs only when the base that moved is the base the tick reads, so it never shows another branch's round as this one's.
import { format } from 'node:util';
import { isSessionId } from '../../hooks/lib/session-store.mjs';
import { findTranscript, readBoard, refreshBoard } from '../board/lib/refresh.mjs';
import { runTick } from '../board/lib/tick.mjs';
import { openRepo } from '../git-tidy/lib/repo.mjs';
import { firstLine } from './refusal.mjs';

const TICK_FAILED = 2; // runTick: 2 is usage or an unexpected failure; 1 means findings, which still prints a whole tick

/**
 * The board a tick reads: one forced refresh first, so a just-finished agent shows as done (the same as board.mjs freshBoard).
 * @param {Record<string, string | undefined>} [env] CLAUDE_CODE_SESSION_ID, and HOME for the board folder
 * @returns {object | null} the session's board, or null with no session id or no board file
 */
export function sessionBoard(env = process.env) {
  const session = env.CLAUDE_CODE_SESSION_ID;
  if (!isSessionId(session)) return null;
  refreshBoard({ session, transcriptPath: findTranscript(session), cwd: process.cwd() }, { env, force: true });
  return readBoard(session, env);
}

/**
 * Runs `board tick --repo <repoDir>` in this process and returns what it printed, so land can print it after its own lines.
 * @param {string} repoDir the absolute base checkout the land moved
 * @param {Record<string, string | undefined>} [env] passed to sessionBoard
 * @returns {{ lines: string[], error: string | null }} the tick's stdout lines; or no lines and the first line of its error
 */
export function tickAfterLand(repoDir, env = process.env) {
  const printed = { out: [], err: [] };
  const { log, error } = console;
  // runTick prints with console.log and console.error; held here, so a failed tick becomes one `tick failed:` line in land
  console.log = (...args) => printed.out.push(format(...args));
  console.error = (...args) => printed.err.push(format(...args));
  let code;
  try {
    code = runTick(['--repo', repoDir], () => sessionBoard(env));
  } finally {
    console.log = log;
    console.error = error;
  }
  if (code === TICK_FAILED) return { lines: [], error: firstLine(printed.err.join('\n')) };
  return { lines: printed.out.join('\n').split('\n'), error: null };
}

/**
 * Prints `tick:` and the tick after a landing on `base`, or one `tick skipped:` line when the main checkout, whose branch is the
 * base the tick reads (openRepo), is on another branch (a land in a linked checkout); a failed tick is one stderr line.
 * @param {{dir: string, base: string}} checkout the base checkout the land moved
 * @throws {Error} when the tick's base cannot be read (a main checkout with no branch); land prints it as `tick failed:`
 */
export function printTickAfterLand({ dir, base }) {
  const tickBase = openRepo(dir, null).base;
  if (tickBase !== base) {
    console.log(`tick skipped: landed on ${base}, the main checkout is on ${tickBase}`);
    return;
  }
  const { lines, error } = tickAfterLand(dir);
  if (error !== null) {
    console.error(`tick failed: ${error}`);
    return;
  }
  console.log(['tick:', ...lines].join('\n'));
}
