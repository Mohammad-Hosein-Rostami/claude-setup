#!/usr/bin/env node
// done-check: run the always-on code checks by hand, read the last result, read the ledger numbers, label a run (design sections 3.5-3.7, 6).
// Usage (full text in README.md):
//   done-check run --worktree <abs> [--base <40-hex>] [--where land|manual] [--json]
//   done-check last [--worktree <abs>] [--json]
//   done-check stats [--days <n>] [--json] [--doctor]   (per check kind: counts, labels and ignored blocks on lines of their own;
//                                                        then per model and effort of the agent that stopped)
//   done-check label <run-id> --as false-alarm|real|missed --check <kind> [--note <up to 200 chars>]
// Exit codes: 0 ok, reused or nothing to check; 1 new failures or weakened tests; 2 usage; 3 internal error (the message is on stdout, as
//   JSON `{"error": ...}` with --json). Importing this file runs nothing: the hook imports lib/check-change.mjs only.
// Exports: main(argv, env) -> Promise<number> (the exit code; output goes to process.stdout and process.stderr).
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gitOut, worktreeOf } from '../../hooks/lib/gated-folder.mjs';
import { checkChange, repoIdOf } from './lib/check-change.mjs';
import { CHECK_KINDS } from './lib/contract.mjs';
import { appendLabel, ledgerUsage, lastRun, readLedger, stats, statsByModel } from './lib/ledger.mjs';
import { rangeChange } from './lib/scope.mjs';
import { lineOf } from './lib/verdict-text.mjs';

const FULL_COMMIT = /^[0-9a-f]{40}$/;
const WHERES = ['land', 'manual'];
const LABELS = ['false-alarm', 'real', 'missed'];
const MAX_NOTE_CHARS = 200;
const DEFAULT_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const WARN_RATE = 0.10; // Google's bar for a noisy check (design 3.7): over this share of false alarms ...
const WARN_MIN_BLOCKS = 10; // ... counted only once a check has blocked this often
const GIT_TIMEOUT_MS = 10_000;
const EXIT = { ok: 0, fail: 1, usage: 2, internal: 3 };

class UsageError extends Error {}

const SHAPES = {
  run: { worktree: { type: 'string' }, base: { type: 'string' }, where: { type: 'string' }, json: { type: 'boolean' } },
  last: { worktree: { type: 'string' }, json: { type: 'boolean' } },
  stats: { days: { type: 'string' }, json: { type: 'boolean' }, doctor: { type: 'boolean' } },
  label: { as: { type: 'string' }, check: { type: 'string' }, note: { type: 'string' } },
};

/** Reads the arguments of one subcommand; unknown flags and wrong positionals are usage errors. */
function parseCommand(argv) {
  const [name, ...rest] = argv;
  if (!Object.hasOwn(SHAPES, name ?? '')) throw new UsageError('usage: done-check run|last|stats|label ... (see README.md)');
  try {
    const { values, positionals } = parseArgs({ args: rest, options: SHAPES[name], allowPositionals: name === 'label', strict: true });
    if (positionals.length !== (name === 'label' ? 1 : 0)) throw new UsageError(`done-check ${name}: ${name === 'label' ? 'give one run id' : 'no positional arguments'}`);
    return { name, values, runId: positionals[0] };
  } catch (error) {
    throw error instanceof UsageError ? error : new UsageError(`done-check ${name}: ${error.message}`);
  }
}

/** An absolute folder that exists, as given. */
function folderOf(value, flag) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new UsageError(`done-check: ${flag} must be an absolute folder`);
  if (!existsSync(value) || !statSync(value).isDirectory()) throw new UsageError(`done-check: ${flag} ${value} is not a folder`);
  return realpathSync(value);
}

const print = (text) => process.stdout.write(`${text}\n`);

async function runCommand({ worktree, base, where = 'manual', json }, env) {
  if (worktree === undefined) throw new UsageError('done-check run: --worktree <abs> is required');
  const top = folderOf(worktree, '--worktree');
  if (!WHERES.includes(where)) throw new UsageError(`done-check run: --where must be ${WHERES.join(' or ')}`);
  if (base !== undefined && !FULL_COMMIT.test(base)) throw new UsageError('done-check run: --base must be a full 40-hex commit id');
  if (worktreeOf(top) === null) throw new UsageError(`done-check run: ${top} is not a git worktree (with at least one commit)`);
  const baseCommit = base ?? (gitOut(top, ['rev-parse', '--verify', 'HEAD'], GIT_TIMEOUT_MS) ?? '').trim();
  if (!FULL_COMMIT.test(baseCommit)) throw new UsageError('done-check run: the worktree has no commit to compare with; give --base');
  const verdict = await checkChange(await rangeChange(top, baseCommit), { where, session: '', agent: '', env });
  print(json ? JSON.stringify(verdict) : [verdict.line, verdict.reason].filter(Boolean).join('\n'));
  return verdict.verdict === 'block' ? EXIT.fail : EXIT.ok;
}

function lastCommand({ worktree, json }, env) {
  const repoId = worktree === undefined ? undefined : repoIdOf(folderOf(worktree, '--worktree'));
  const row = lastRun({ repoId, env });
  if (row === null) print(json ? 'null' : 'no runs yet');
  else print(json ? JSON.stringify({ line: lineOf(row), row }) : lineOf(row));
  return EXIT.ok;
}

const percent = (rate) => `${Math.round(rate * 100)}%`;
const secondsOf = (ms) => `${(ms / 1000).toFixed(1)} s`;

/**
 * Three text lines per check kind: its counts, false-alarm rate and times; then the owner's labels; then the blocks ignored with no
 * label. Labels and ignored blocks are on lines of their own so neither reads as the other.
 */
function statsLines(entry) {
  const notRun = Object.entries(entry.notRun).map(([why, count]) => `${why} ${count}`).join(', ');
  const { falseAlarm, real, missed } = entry.labels;
  return [
    `${entry.kind}: ${entry.runs} runs, ${entry.blocks} blocks (acted on ${entry.actedOn}), false-alarm rate ${percent(entry.falseAlarmRate)}, median ${secondsOf(entry.medianMs)}, p90 ${secondsOf(entry.p90Ms)}${notRun ? `, not run: ${notRun}` : ''}`,
    `  labelled: ${falseAlarm} false-alarm, ${real} real, ${missed} missed; ${entry.passedByLabel} runs passed by a false-alarm label`,
    `  ignored: ${entry.ignored} blocks stopped again with the same change and no label`,
  ];
}

/** One text line per (model, effort) group: its runs, blocks, left-open stops and median run time. */
function modelLine(group) {
  return `${group.model} ${group.effort}: ${group.runs} runs, ${group.blocks} blocks, ${group.leftOpen} left open, median ${secondsOf(group.medianMs)}`;
}

function statsCommand({ days = String(DEFAULT_DAYS), json, doctor }, env) {
  const count = Number(days);
  if (!Number.isInteger(count) || count <= 0) throw new UsageError('done-check stats: --days must be a positive whole number');
  const ledger = readLedger({ sinceMs: Date.now() - count * MS_PER_DAY, env });
  const entries = stats(ledger);
  const byModel = statsByModel(ledger.runs);
  const usage = ledgerUsage({ env });
  const warnings = [
    ...entries.filter((entry) => entry.blocks >= WARN_MIN_BLOCKS && entry.falseAlarmRate > WARN_RATE)
      .map((entry) => `WARN done-check: ${entry.kind} false-alarm rate ${percent(entry.falseAlarmRate)} over ${entry.blocks} blocks (limit ${percent(WARN_RATE)})`),
    ...(usage.full ? ['WARN done-check: the ledger is full, new runs are not recorded'] : []),
  ];
  if (json) print(JSON.stringify({ days: count, entries, byModel, usage, warnings: doctor ? warnings : undefined }));
  else {
    const modelPart = byModel.length === 0 ? [] : ['by model and effort:', ...byModel.map(modelLine)];
    print(entries.length === 0 && byModel.length === 0 ? 'no runs yet' : [`last ${count} days:`, ...entries.flatMap(statsLines),...modelPart].join('\n'));
    if (doctor) for (const warning of warnings) print(warning);
  }
  return EXIT.ok;
}

function labelCommand({ as, check, note = '' }, runId, env) {
  if (!LABELS.includes(as)) throw new UsageError(`done-check label: --as must be one of ${LABELS.join(', ')}`);
  if (!CHECK_KINDS.includes(check)) throw new UsageError(`done-check label: --check must be one of ${CHECK_KINDS.join(', ')}`);
  if (note.length > MAX_NOTE_CHARS) throw new UsageError(`done-check label: --note is at most ${MAX_NOTE_CHARS} characters`);
  if (!readLedger({ env }).runs.some((row) => row.id === runId)) throw new UsageError(`done-check label: no run with id ${runId} in the ledger`);
  if (!appendLabel({ v: 1, label: as, run: runId, check, at: new Date().toISOString(), note }, { env })) throw new Error('the ledger could not be written (full or not writable)');
  print(`labelled ${runId} ${check} as ${as}`);
  return EXIT.ok;
}

/**
 * Runs one command line.
 * @param {string[]} argv the arguments after the script name
 * @param {NodeJS.ProcessEnv} [env] where HOME points (the ledger and caches) and DONE_CHECK_SKIP
 * @returns {Promise<number>} the exit code: 0 ok, 1 blocked, 2 usage, 3 internal error
 */
export async function main(argv, env = process.env) {
  const json = argv.includes('--json');
  try {
    const { name, values, runId } = parseCommand(argv);
    if (name === 'run') return await runCommand(values, env);
    if (name === 'last') return lastCommand(values, env);
    if (name === 'stats') return statsCommand(values, env);
    return labelCommand(values, runId, env);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT.usage;
    }
    print(json ? JSON.stringify({ error: error.message }) : `checks: internal error: ${error.message}`);
    return EXIT.internal;
  }
}

const isMain = process.argv[1] !== undefined && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) process.exitCode = await main(process.argv.slice(2));
