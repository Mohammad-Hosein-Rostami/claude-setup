#!/usr/bin/env node
// Purpose: run long, unattended Claude Code jobs: each step of a job file is one `claude -p` boss session, driven by a LangGraph
//   graph with a SQLite checkpoint per run, so crashes, reboots, usage limits and the owner's pauses, takeovers and messages are
//   continued in the same session. See README.md beside this file.
// Usage: node ~/.claude/tools/long-run/long-run.mjs <command> ... (`help` lists the commands).
// Exports: none (a CLI). Exit codes: 0 ok, 1 refused or failed (the message says why and what to do), 2 usage, 3 no such run or
//   step, 4 run busy.
// Invariants: every error is one line with its fix; no command prints a token, a raw log (unless --raw) or a journal; the state
//   folder is `~/.claude/state/long-run` (LONG_RUN_STATE_DIR for tests).
import { readFileSync } from 'node:fs';
import { JobError } from './lib/job.mjs';
import { AccountRefusal } from './lib/run-account.mjs';
import { RunBusy, listRunIds, runPaths, stateRoot } from './lib/run-store.mjs';
import { NotFound, Refusal, UsageError, driverDeps, openRun } from './lib/cli-common.mjs';
import { checkCommand, resumeCommand, resumeStale, rerunCommand, startCommand } from './lib/cli-run.mjs';
import { pauseOrStop, takeoverCommand, tellCommand } from './lib/cli-control.mjs';
import { drive } from './lib/driver.mjs';
import { pruneCommand } from './lib/prune.mjs';
import { followEvents, readEventLines, waitNextEvents } from './lib/events.mjs';
import { notify, removeNtfy, setupNtfy } from './lib/notify.mjs';
import { addSchedule, autostart, listSchedules, readSchedule, removeSchedule } from './lib/os-schedule.mjs';
import { startAccount } from './lib/run-account.mjs';
import { loadJob } from './lib/job.mjs';
import { runView, statusLines, writeSummary } from './lib/view.mjs';
import { LOG_TAIL_DEFAULT, logLines, watchRun } from './lib/watch.mjs';

const EXIT = { ok: 0, refused: 1, usage: 2, notFound: 3, busy: 4 };
const VALUE_FLAGS = new Set(['account', 'answer', 'answer-file', 'item', 'reload-job', 'from', 'run', 'since', 'after', 'tail', 'server', 'at', 'on', 'schedule', 'delay', 'message-file', 'max-wait', 'older-than']);
const STATUS_RUNS = 20;
const EVENTS_SINCE_DEFAULT = 20;
const WAIT_NEXT_DEFAULT_SECONDS = 2 * 60 * 60;
const SECOND_MS = 1000;
const HELP = `long-run <command>
  check <job.json>                      validate a job and print its plan (spends nothing)
  check --deps                          load LangGraph and the SQLite module only; prints ok (doctor)
  start <job.json> [--foreground]       start a run (the driver runs detached)
  status [<run>] [--json]               all runs, or one run's steps and boss sessions
  watch <run> [<step>]                  follow the live log (Ctrl-C ends the watching only)
  log <run> [<step>] [--tail N] [--raw] the last N readable lines (default ${LOG_TAIL_DEFAULT}, 0 = all)
  pause | stop <run> [<step>]           end a boss cleanly (pause keeps it ready; stop fails the step)
  takeover <run> <step>                 pause a step and print the lines that open its session by hand
  tell <run> <step> "<message>"         send a step a message (--message-file <f>)
  resume <run> [--account <name>] [--answer <t> | --answer-file <f>] [--item <id>] [--retry | --skip | --abandon] [--reload-job <f>] [--force] [--foreground]
  resume --stale [--delay <s>]          resume every run whose driver died (autostart)
  rerun <run> --from <step> [--reload-job <f>]
  summary <run>                         print summary.md
  prune [--older-than <days>]           remove done and abandoned runs that ended that long ago (default 30 days)
  events [--run <id>] [--since <n>] [--follow] [--after <n>] [--wait-next [--max-wait <s>]]
  notify setup [--server <url>] | test | off
  autostart on | off | status
  schedule <job.json> --at HH:MM [--daily | --on YYYY-MM-DD] | schedule list | schedule remove <name>`;

/** `{ command, positional, flags }`; a flag in VALUE_FLAGS takes the next argument. */
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (!VALUE_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    if (rest[i + 1] === undefined) throw new UsageError(`--${name} needs a value`);
    flags[name] = rest[i + 1];
    i += 1;
  }
  return { command, positional, flags };
}

const intFlag = (value, fallback, name) => {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value))) throw new UsageError(`--${name} takes a whole number`);
  return Number(value);
};

function statusCommand({ positional, flags, root, write }) {
  const views = positional[0] ? [runView(openRun(root, positional[0]))] : listRunIds(root).slice(0, STATUS_RUNS).map((runId) => runView(runPaths(root, runId)));
  if (flags.json) write(JSON.stringify(positional[0] ? views[0] : views, null, 2));
  else for (const line of statusLines(views, Boolean(positional[0]))) write(line);
}

function untilInterrupt(run) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  return run(controller.signal);
}

async function eventsCommand({ flags, root, write }) {
  const after = flags.after === undefined ? null : intFlag(flags.after, 0, 'after');
  const run = flags.run ?? null;
  if (flags['wait-next']) {
    await waitNextEvents({ root, after, run, write, maxWaitMs: intFlag(flags['max-wait'], WAIT_NEXT_DEFAULT_SECONDS, 'max-wait') * SECOND_MS });
    return;
  }
  if (!flags.follow || flags.since) {
    const since = intFlag(flags.since, EVENTS_SINCE_DEFAULT, 'since');
    const lines = readEventLines(root, { run });
    if (!flags.follow || after === null) for (const line of lines.slice(-since)) write(line);
  }
  if (flags.follow) await untilInterrupt((signal) => followEvents({ root, after, run, write, signal }));
}

async function notifyCommand({ positional, flags, env, write }) {
  const action = positional[0];
  if (action === 'setup') write(`phone push on; subscribe in the ntfy app to: ${setupNtfy({ env, server: flags.server })}`);
  else if (action === 'off') write(removeNtfy(env) ? 'phone push off' : 'phone push was off');
  else if (action === 'test') {
    const failures = await notify({ desktop: 'test note', phone: 'long-run: test' }, { env });
    write(failures.length === 0 ? 'sent a test note' : failures.join('; '));
  } else throw new UsageError('notify setup [--server <url>] | test | off');
}

function scheduleCommand({ positional, flags, env, root, write }) {
  if (positional[0] === 'list') {
    const all = listSchedules(root);
    for (const one of all) write(`${one.name} at ${one.at} ${one.on ? `on ${one.on}` : 'daily'} account=${one.account} job=${one.job}`);
    if (all.length === 0) write('no schedules');
    return;
  }
  if (positional[0] === 'remove') {
    write(removeSchedule(root, positional[1] ?? '') ? `schedule ${positional[1]} removed` : `no schedule ${positional[1]}`);
    return;
  }
  if (!positional[0] || !flags.at || (flags.daily && flags.on) || (!flags.daily && !flags.on)) throw new UsageError('schedule <job.json> --at HH:MM (--daily | --on YYYY-MM-DD)');
  const { job, path } = loadJob(positional[0]);
  const account = startAccount(env);
  write(`scheduled ${job.name} (account ${account}): ${addSchedule({ root, name: job.name, jobPath: path, account, at: flags.at, on: flags.on ?? null })}`);
}

async function startScheduled(context) {
  const schedule = readSchedule(context.root, context.flags.schedule);
  if (!schedule) throw new Refusal(`no schedule ${context.flags.schedule}`);
  try {
    await startCommand({ ...context, positional: [schedule.job], env: { ...context.env, CLAUDE_ACCOUNT: schedule.account } });
  } catch (error) {
    await notify({ desktop: `scheduled start of ${schedule.name} refused`, phone: `${schedule.name}: scheduled start refused` }, { env: context.env });
    throw error;
  } finally {
    if (schedule.on) removeSchedule(context.root, schedule.name); // a one-date schedule fires once
  }
}

const COMMANDS = {
  help: ({ write }) => write(HELP),
  check: checkCommand,
  start: (context) => (context.flags.schedule ? startScheduled(context) : startCommand(context)),
  status: statusCommand,
  watch: (context) => untilInterrupt((signal) => watchRun({ paths: openRun(context.root, context.positional[0]), step: context.positional[1] ?? null, write: context.write, signal })),
  log: ({ positional, flags, root, write }) => {
    for (const line of logLines(openRun(root, positional[0]), { step: positional[1] ?? null, raw: Boolean(flags.raw), tail: intFlag(flags.tail, LOG_TAIL_DEFAULT, 'tail') })) write(line);
  },
  pause: (context) => pauseOrStop('pause', { ...context, runId: context.positional[0], stepId: context.positional[1] }),
  stop: (context) => pauseOrStop('stop', { ...context, runId: context.positional[0], stepId: context.positional[1] }),
  takeover: (context) => takeoverCommand({ ...context, runId: context.positional[0], stepId: context.positional[1] }),
  tell: (context) => tellCommand({ ...context, runId: context.positional[0], stepId: context.positional[1], positional: context.positional.slice(2) }),
  resume: (context) => (context.flags.stale ? resumeStale({ ...context, sleep: driverDeps(context.env).sleep }) : resumeCommand({ ...context, runId: context.positional[0] })),
  rerun: (context) => rerunCommand({ ...context, runId: context.positional[0] }),
  summary: ({ positional, root, write }) => {
    const paths = openRun(root, positional[0]);
    writeSummary(paths, { nextCommand: `long-run status ${paths.runId}` });
    write(readFileSync(paths.summary, 'utf8').trimEnd());
  },
  prune: pruneCommand,
  events: eventsCommand,
  notify: notifyCommand,
  autostart: ({ positional, env, write }) => {
    if (!['on', 'off', 'status'].includes(positional[0])) throw new UsageError('autostart on | off | status');
    write(autostart(positional[0], { env }));
  },
  schedule: scheduleCommand,
  drive: async ({ positional, env, root, write }) => write(`run ${positional[0]} ${await drive(openRun(root, positional[0]), driverDeps(env))}`),
};

function exitCodeOf(error) {
  if (error instanceof UsageError) return EXIT.usage;
  if (error instanceof NotFound) return EXIT.notFound;
  if (error instanceof RunBusy) return EXIT.busy;
  if (error instanceof Refusal || error instanceof JobError || error instanceof AccountRefusal) return EXIT.refused;
  return null;
}

async function main(argv) {
  const write = (line) => process.stdout.write(`${line}\n`);
  try {
    const { command, positional, flags } = parseArgs(argv);
    const run = COMMANDS[command ?? 'help'];
    if (!run) throw new UsageError(`unknown command ${command}\n${HELP}`);
    await run({ positional, flags, env: process.env, root: stateRoot(), write });
    return EXIT.ok;
  } catch (error) {
    const code = exitCodeOf(error);
    console.error(`long-run: ${code === null ? error.stack ?? error.message : error.message}`);
    return code ?? EXIT.refused;
  }
}

process.exitCode = await main(process.argv.slice(2));
