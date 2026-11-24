// PreToolUse(Agent|Task) and PreToolUse(SendMessage) hook entry: loads the guard (lib/agent-model-gates.mjs: the no-Fable gate, the route, the cap, the brief
// and writer gates, the model routing; for SendMessage the resume cap) and runs it. Exports: nothing.
// Why an entry of its own: a static import that fails (a lib with a syntax error, one that throws while it loads, a missing file,
// as a half-synced home/ can have) ends node with exit 1 before any code here runs, and Claude Code lets the call run on exit 1.
// Loaded inside a try, any such failure, and any crash of the guard, prints a deny instead.
// Invariants: only node built-ins are imported statically; the hook never lets an Agent call through without the guard's answer.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAX_MESSAGE_CHARS = 300;

/** The deny line printed when the guard cannot run or crashes; the message is cut to one line of printable text. */
function crashDeny(error) {
  const message = String(error?.message).replace(/\s+/g, ' ').replace(/[^\x20-\x7e]/g, '').replace(/`/g, "'").slice(0, MAX_MESSAGE_CHARS);
  process.stderr.write(`agent-model-guard: ${message}\n`);
  const reason = `agent-model-guard failed (${message}), so the call is denied; send it again, or fix the hook`;
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`;
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const { runGuard } = await import('./lib/agent-model-gates.mjs');
    await runGuard();
  } catch (error) {
    process.stdout.write(crashDeny(error)); // fail closed: the no-Fable gate never passes by a crash
  }
}
