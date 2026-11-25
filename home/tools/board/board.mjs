// The board tool. `refresh` is the status line's detached board refresh (spec-p5 `r9-board`): it rewrites the session's board
// file (lib/refresh.mjs), the agents and git facts the status line draws, and prints nothing. The status line starts it after
// claiming a due refresh (claimBoardRefresh). `show` prints the board file as plain lines (lib/show.mjs) and writes nothing unless
// asked to refresh first: `board <session> at <iso> <fresh|stale N s>`, then per agent
// `agent <id> <type> <running|done|quiet N min> branch <branch|-> folder <wt|-> <doing|->`; `--refresh` runs one forced
// refresh first, `--json` prints the board file's JSON instead.
// Usage: node board.mjs refresh --session <id> [--force]
//        node board.mjs show [--session <id>] [--refresh] [--json]   (session default CLAUDE_CODE_SESSION_ID)
// Exit: refresh 0 after a refresh (written or not: a refresh never fails loudly); show 0 shown, 1 no board file for the session
// (it prints the refresh command to run); 2 usage.
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isSessionId } from '../../hooks/lib/session-store.mjs';
import { findTranscript, readBoard, refreshBoard } from './lib/refresh.mjs';
import { showLines } from './lib/show.mjs';

const USAGE = 'usage: board.mjs refresh --session <id> [--force]\n       board.mjs show [--session <id>] [--refresh] [--json]';
const SCRIPT = fileURLToPath(import.meta.url);

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

function main(args) {
  const session = flagValue(args, '--session') ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (args[0] === 'show') return show(session, args);
  if (args[0] !== 'refresh') {
    console.error(USAGE);
    return 2;
  }
  refreshNow(session, args.includes('--force'));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
