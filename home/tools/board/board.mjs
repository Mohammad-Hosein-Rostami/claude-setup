// The status line's detached board refresh (spec-p5 `r9-board`): rewrites the session's board file (lib/refresh.mjs), the agents and
// git facts the status line draws, and prints nothing. The status line starts it after claiming a due refresh (claimBoardRefresh).
// Usage: node board.mjs refresh --session <id> [--force]   (session default CLAUDE_CODE_SESSION_ID)
// Exit: 0 after a refresh (written or not: a refresh never fails loudly), 2 usage.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { findTranscript, refreshBoard } from './lib/refresh.mjs';

const USAGE = 'usage: board.mjs refresh --session <id> [--force]';

function flagValue(args, name) {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

function main(args) {
  if (args[0] !== 'refresh') {
    console.error(USAGE);
    return 2;
  }
  const session = flagValue(args, '--session') ?? process.env.CLAUDE_CODE_SESSION_ID;
  refreshBoard({ session, transcriptPath: findTranscript(session), cwd: process.cwd() }, { force: args.includes('--force') });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
