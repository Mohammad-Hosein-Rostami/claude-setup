// The board tool. `refresh` is the status line's detached board refresh (spec-p5 `r9-board`): it rewrites the session's board
// file (lib/refresh.mjs), the agents and git facts the status line draws, and prints nothing. The status line starts it after
// claiming a due refresh (claimBoardRefresh). `show` prints the board file as plain lines (lib/show.mjs) and writes nothing unless
// asked to refresh first: `board <session> at <iso> <fresh|stale N s>`, then per agent
// `agent <id> <type> <running|done|quiet N min> branch <branch|-> folder <wt|-> <doing|->`; `--refresh` runs one forced
// refresh first, `--json` prints the board file's JSON instead. `tick` is the boss's read-only sync after every agent report and
// every land (lib/tick.mjs): main, the lanes in flight with their agents (from one forced refresh), overlaps, strays, the plan's
// queue, features due for tess and a suggested next step. `done` is tess's record that it returned: its verdict goes into the
// feature's tess mark at that sha (lib/tick-plan.mjs writeDone), and only an `ok` there checks the feature. `start` claims the
// lane of a startable plan piece, or a snapshot for tess (then its mark), and prints the brief to send (lib/start.mjs).
// Usage: node board.mjs refresh --session <id> [--force]
//        node board.mjs show [--session <id>] [--refresh] [--json]   (session default CLAUDE_CODE_SESSION_ID)
//        node board.mjs tick --repo <abs> [--plan <abs pieces.json>] [--session <id>] [--json]
//        node board.mjs tick --repo <abs> --plan <abs> --mark-tess <feature> --sha <40-hex>
//        node board.mjs done --repo <abs> --job <slug> --tess <feature> --sha <40-hex> --verdict ok|must-fix
//        node board.mjs start --repo <abs> --piece <id> [--job <slug>]   |   --tess <feature> [--job <slug>] [--qa <level>]
// Exit: refresh 0 after a refresh (written or not: a refresh never fails loudly); show 0 shown, 1 no board file for the session
// (it prints the refresh command to run); tick 0 shown, 1 findings, 2 usage or a bad plan (lib/tick.mjs); done 0 recorded, 1 no
// tess mark of that feature at that sha, 2 usage or marks that cannot be read or written; start 0 started or brief again, 1
// refused, 2 usage (lib/start.mjs); 2 usage.
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isSessionId } from '../../hooks/lib/session-store.mjs';
import { cleanText } from './lib/cells.mjs';
import { findTranscript, readBoard, refreshBoard } from './lib/refresh.mjs';
import { showLines } from './lib/show.mjs';

const USAGE = 'usage: board.mjs refresh --session <id> [--force]\n       board.mjs show [--session <id>] [--refresh] [--json]\n'
  + '       board.mjs tick --repo <abs> [--plan <abs pieces.json>] [--session <id>] [--json] (run `board.mjs tick` for all of it)\n'
  + '       board.mjs done --repo <abs> --job <slug> --tess <feature> --sha <40-hex> --verdict ok|must-fix\n'
  + '       board.mjs start --repo <abs> --piece <id> [--job <slug>] | --tess <feature> [--job <slug>] [--qa <level>]';
const SCRIPT = fileURLToPath(import.meta.url);
const SHORT_SHA = 8;
const DONE_EXIT = Object.freeze({ recorded: 0, noMark: 1, usage: 2 });
// cleanText reads only `ascii` from a look: plain lines keep non-ASCII names as they are and carry no colour
const PLAIN_LOOK = { ascii: false };

function flagValue(args, name) {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

const refreshNow = (session, force) => refreshBoard({ session, transcriptPath: findTranscript(session), cwd: process.cwd() }, { force });

/** The `show` command: prints the session's board; returns the exit code. */
function show(session, args) {
  if (!isSessionId(session)) {
    console.error(USAGE);
    return 2;
  }
  if (args.includes('--refresh')) refreshNow(session, true);
  const board = readBoard(session);
  if (board === null) {
    console.error(`no board file for session ${session}; write one with: node ${SCRIPT} refresh --session ${session} --force`);
    return 1;
  }
  console.log(args.includes('--json') ? JSON.stringify(board) : showLines(board, Date.now()).join('\n'));
  return 0;
}

/** The board `tick` reads: one forced refresh first, so a just-finished agent shows as done; null with no session id. */
function freshBoard(session) {
  if (!isSessionId(session)) return null;
  refreshNow(session, true);
  return readBoard(session);
}

/**
 * The `tick` command; returns the exit code. Imported only when run: tick reads the land ledger (../land/ledger.mjs), and
 * `refresh`, which the status line starts every few seconds, must never fail on a module only tick needs.
 */
async function tick(session, args) {
  const { runTick } = await import('./lib/tick.mjs');
  return runTick(args, () => freshBoard(session));
}

/**
 * The `done` command, tess's record that it returned: writes tess's verdict into the job's tess mark of the feature at
 * that sha (tick-plan.mjs writeDone, under the marks lock) and prints `done <feature> at <sha8>: <verdict>`. Imported only when
 * run, as tick is: refresh must never fail on a module only these commands need.
 * @param {string[]} args the arguments after `done`
 * @returns {Promise<number>} the exit code (DONE_EXIT)
 */
async function done(args) {
  const [{ UsageError }, { openRepo }, { writeDone }] = await Promise.all([
    import('../git-tidy/lib/git.mjs'), import('../git-tidy/lib/repo.mjs'), import('./lib/tick-plan.mjs'),
  ]);
  const [repoDir, job, feature, sha, verdict] = ['--repo', '--job', '--tess', '--sha', '--verdict'].map((name) => flagValue(args, name));
  try {
    if (!isAbsolute(repoDir ?? '')) throw new UsageError(`done needs --repo <absolute path of the main checkout>. ${USAGE}`);
    // writeDone checks job, feature, sha and verdict first, so the names printed below are plain ones
    const file = writeDone({ repo: openRepo(repoDir, null), job, feature, sha, verdict });
    if (file === null) {
      console.error(`no tess mark for ${feature} at ${sha.slice(0, SHORT_SHA)}`);
      return DONE_EXIT.noMark;
    }
    console.log(`done ${feature} at ${sha.slice(0, SHORT_SHA)}: ${verdict}`);
    return DONE_EXIT.recorded;
  } catch (error) {
    // a git message may quote a path: clean each line, as tick does
    const why = error.message.split('\n').map((line) => cleanText(line, PLAIN_LOOK)).join('\n');
    console.error(`board done: ${error instanceof UsageError ? '' : 'unexpected failure: '}${why}`);
    return DONE_EXIT.usage;
  }
}

/**
 * The `start` command: claims a piece's lane or a tess snapshot and prints the brief (lib/start.mjs runStart). Imported only
 * when run, as tick is: refresh must never fail on a module only start needs.
 */
async function start(session, args) {
  const { runStart } = await import('./lib/start.mjs');
  return runStart(args, session);
}

function main(args) {
  const session = flagValue(args, '--session') ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (args[0] === 'show') return show(session, args);
  if (args[0] === 'tick') return tick(session, args.slice(1));
  if (args[0] === 'done') return done(args.slice(1));
  if (args[0] === 'start') return start(session, args.slice(1));
  if (args[0] !== 'refresh') {
    console.error(USAGE);
    return 2;
  }
  refreshNow(session, args.includes('--force'));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
