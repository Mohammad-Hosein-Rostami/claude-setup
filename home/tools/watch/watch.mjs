#!/usr/bin/env node
// Watches Claude Code sessions and prints one line per event that needs a human (for the Monitor tool: one line = one notification).
// Usage: watch.mjs <session-id | transcript.jsonl>... [--stall-min 20] [--log <dir>] [--guard-log <path>] [--once]
// Prints (each line prefixed with the 8-character session label, flushed per line): OWNER prompts, COMPACT, tool/API ERROR and
// LIMIT lines, Stop hook feedback, MODEL MISMATCH of subagents, GUARD deny/timeout outcomes of the watched sessions, STALL
// (nothing written to the transcript or a subagent transcript for --stall-min minutes) then RESUMED, SESSION_END.
// --log <dir> also appends the full verbose stream (TOOL, AGENT, WORKFLOW, SKILL, USAGE, INPUT_MODE, ...) to <dir>/<label>.events.log.
// --once processes what is in the files now and exits 0. Exit 2 on a usage error (bad flag, unknown session id).
// Invariants: read-only on transcripts and the guard log; follows from the current end (polls every POLL_MS); no dependencies;
// parsing and filtering live in lib/ (unit-tested), this file only wires arguments, files and stdout.
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { USAGE, UsageError, parseArgs } from './lib/args.mjs';
import { resolveTarget } from './lib/resolve.mjs';
import { createGuardFollower, createSessionWatcher } from './lib/watcher.mjs';

const POLL_MS = 1500;
const EXIT_USAGE = 2;
const CLAUDE_HOME = join(homedir(), '.claude');
const MS_PER_MINUTE = 60_000;

const out = (text) => process.stdout.write(`${text}\n`);
// The reader (Monitor) closing its end of the pipe is a normal way to stop, not a failure.
process.stdout.on('error', (error) => process.exit(error.code === 'EPIPE' ? 0 : 1));

function makeRecorder(logDir) {
  let chain = Promise.resolve();
  return (label, text) => {
    if (!logDir) return;
    const file = join(logDir, `${label}.events.log`);
    chain = chain.then(() => appendFile(file, `${text}\n`)).catch((error) => process.stderr.write(`watch: log write failed: ${error.message}\n`));
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return out(USAGE);
  if (options.logDir) await mkdir(options.logDir, { recursive: true });
  const targets = [];
  for (const arg of options.targets) targets.push(await resolveTarget(arg, join(CLAUDE_HOME, 'projects')));
  const record = makeRecorder(options.logDir);
  const watchers = targets.map((target) => createSessionWatcher({
    ...target,
    once: options.once,
    stallMs: options.stallMin * MS_PER_MINUTE,
    sessionsDir: join(CLAUDE_HOME, 'sessions'),
    now: Date.now,
    emit: out,
    record,
  }));
  const guard = createGuardFollower({
    path: options.guardLog ?? join(CLAUDE_HOME, 'logs', 'guard.jsonl'),
    watched: new Map(targets.map((target) => [target.sessionId, target.label])),
    fromStart: options.once,
  });
  const pollAll = async () => {
    for (const watcher of watchers) await watcher.poll();
    for (const line of await guard.poll()) out(line);
  };
  await pollAll();
  if (options.once) { watchers.forEach((watcher) => watcher.finish()); return undefined; }
  for (;;) { await delay(POLL_MS); await pollAll(); }
}

main().catch((error) => {
  if (error instanceof UsageError) {
    process.stderr.write(`watch: ${error.message}\n${USAGE}\n`);
    process.exitCode = EXIT_USAGE;
    return;
  }
  process.stderr.write(`watch: ${error.stack ?? error}\n`);
  process.exitCode = 1;
});
