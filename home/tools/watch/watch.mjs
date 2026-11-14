#!/usr/bin/env node
// Watches Claude Code sessions and prints one line per event that needs a human (for the Monitor tool: one line = one notification).
// Usage: watch.mjs <session-id | transcript.jsonl>... [--stall-min 20] [--log <dir>] [--guard-log <path>] [--once] [--exit-on-event [classes]]
// Prints (each line prefixed with the 8-character session label, flushed per line): OWNER prompts, COMPACT, tool/API ERROR and
// LIMIT lines, Stop hook feedback, MODEL MISMATCH of subagents, GUARD deny/timeout outcomes of the watched sessions, STALL
// (nothing written to the transcript or a subagent transcript for --stall-min minutes) then RESUMED, SESSION_END.
// --log <dir> also appends the full verbose stream (TOOL, AGENT, WORKFLOW, SKILL, USAGE, INPUT_MODE, ...) to <dir>/<label>.events.log.
// --exit-on-event [classes] prints only the first event of a listed class (default: owner, error, limit, api-error, guard, stall,
// watch-error; compact is opt-in) and exits 0, or 1 for a WATCH_ERROR: for a background command that wakes its starter once.
// --once processes what is in the files now and exits 0. Exit 2 on a usage error (bad flag, unknown session id).
// Problems of the watcher itself are lines too: `WATCH_ERROR <label> <reason>` (rate-limited) and `WATCH_NOTE`. A file that cannot be
// read exits 1 in --once; a fatal error prints a WATCH_ERROR line on stdout before exiting 1.
// Invariants: read-only on transcripts and the guard log; follows from the current end (polls every POLL_MS); no dependencies;
// everything printed or logged is masked;
// parsing and filtering live in lib/ (unit-tested), this file only wires arguments, files and stdout.
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { USAGE, UsageError, parseArgs } from './lib/args.mjs';
import { createErrorReporter, shortReason } from './lib/errors.mjs';
import { WATCH_ERROR_CLASS, internalClasses } from './lib/events.mjs';
import { maskText } from './lib/mask.mjs';
import { resolveTarget } from './lib/resolve.mjs';
import { createGuardFollower, createSessionWatcher } from './lib/watcher.mjs';

const POLL_MS = 1500;
const EXIT_USAGE = 2;
const CLAUDE_HOME = join(homedir(), '.claude');
const MS_PER_MINUTE = 60_000;

const out = (text) => process.stdout.write(`${maskText(text)}\n`);
// The reader (Monitor) closing its end of the pipe is a normal way to stop, not a failure.
process.stdout.on('error', (error) => process.exit(error.code === 'EPIPE' ? 0 : 1));

// Where action lines go. Plain mode prints every one. With --exit-on-event only the first line of a wanted class is printed, then
// the process exits (1 for a WATCH_ERROR, else 0) once stdout has taken the line; later lines are dropped.
function makeEmitter(exitOnEvent) {
  if (!exitOnEvent) return out;
  const wanted = internalClasses(exitOnEvent);
  let done = false;
  return (text, cls) => {
    if (done || !wanted.has(cls)) return;
    done = true;
    process.exitCode = cls === WATCH_ERROR_CLASS ? 1 : 0;
    process.stdout.write(`${maskText(text)}\n`, () => process.exit());
  };
}

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
  for (const arg of options.targets) {
    const target = await resolveTarget(arg, join(CLAUDE_HOME, 'projects'));
    if (target.note) out(target.note);
    targets.push(target);
  }
  const record = makeRecorder(options.logDir);
  const emit = makeEmitter(options.exitOnEvent);
  const reporter = createErrorReporter({ now: Date.now, emit, record });
  const watchers = targets.map((target) => createSessionWatcher({
    ...target, once: options.once, stallMs: options.stallMin * MS_PER_MINUTE, sessionsDir: join(CLAUDE_HOME, 'sessions'), now: Date.now, emit, record,
  }));
  const guard = createGuardFollower({
    path: options.guardLog ?? join(CLAUDE_HOME, 'logs', 'guard.jsonl'),
    watched: new Map(targets.map((target) => [target.sessionId, target.label])),
    fromStart: options.once,
    onError: (reason) => reporter.report('guard', reason),
  });
  const pollAll = async () => {
    for (const watcher of watchers) await watcher.poll();
    try { for (const line of await guard.poll()) emit(line, 'GUARD'); } catch (error) { reporter.report('guard', error); }
  };
  await pollAll();
  if (options.once) {
    watchers.forEach((watcher) => watcher.finish());
    if (watchers.some((watcher) => watcher.failed) || guard.failed) process.exitCode = 1;
    return undefined;
  }
  for (;;) { await delay(POLL_MS); await pollAll(); }
}

function die(error) {
  try { out(`WATCH_ERROR - fatal: ${shortReason(error)}`); } catch { /* stdout is gone: stderr below still says it */ }
  process.stderr.write(`watch: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
  process.exit();
}

process.on('uncaughtException', die);
process.on('unhandledRejection', die);
main().catch((error) => {
  if (!(error instanceof UsageError)) return die(error);
  process.stderr.write(`watch: ${error.message}\n${USAGE}\n`);
  process.exitCode = EXIT_USAGE;
  return undefined;
});
