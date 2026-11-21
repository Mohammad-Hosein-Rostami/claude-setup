#!/usr/bin/env node
// Purpose: the record of post-land audits. A lane that landed after a waived review (see README.md, "Waiver") gets its Opus-max
//   audit after the land; this CLI says whether a lane must be audited, records how each audit went, and closes sync and push
//   (`gate`) while an audit is pending, failed, or found a confirmed defect nobody has resolved.
// Usage: audit-log.mjs should-audit --tip <sha> [--escalate] [--json]
//        audit-log.mjs record --repo <abs> --tip <sha> --base <sha> [--reviewed <sha>] --state pending|done|error|sampled-out [--confirmed <n>]
//        audit-log.mjs resolve --repo <abs> --tip <sha> --fixed-by <sha>
//        audit-log.mjs gate --repo <abs> --tip <sha|HEAD>
//        audit-log.mjs stats [--json]
// Exit codes: 0 ok, 1 gate closed (or the log could not be written), 2 usage (bad flag, sha, folder, state).
// Exports: CALIBRATION_LANES, AUDIT_ONE_IN, decideAudit, run.
// Invariants:
//   - The log is ~/.claude/logs/review-audit.jsonl (REVIEW_AUDIT_LOG overrides), folder 0700, file 0600, one JSON line per call,
//     appended in one write, so concurrent callers never interleave. A line that is not valid JSON is skipped when reading; a torn
//     line (a crash mid-write, no newline) is cut off before the next record, which starts with `{"at":`.
//   - A repository is keyed by its real git common dir, so a subfolder or a linked worktree of it is the same repository.
//   - `--tip` is the key of a lane: callers record the sha that landed on the base branch (a rebase on a moved base changes the
//     reviewed tip, and only the landed sha is an ancestor of what is pushed). The audited range is `--base` .. `--reviewed` (the
//     reviewed tip T; default: the tip). A `done` record needs that range to be non-empty: an empty audit is not a clean one.
//   - `resolve` closes only an unresolved `done` record with findings, by a commit after the tip. A pending or error audit is
//     closed only by an audit record. Known limit: history rewritten after landing gives the commits new shas, and the old
//     entries then no longer match what is pushed; the audit workflow records right after an ff-only land, so it does not rewrite.
//   - Who records `pending`: home/workflows/land.js with `auditPending`, right after the ff-only land (build.js passes it for a waived
//     lane; the lead for any lane landed without its Opus pair), so a stopped audit runner can never leave the gate open.
//   - Streak = the newest consecutive `done` records with confirmed 0, one per tip (a tip recorded twice counts once); `done` with confirmed > 0 ends it; `pending`, `error` and
//     `sampled-out` neither count nor end it. A lane is audited while the streak is below CALIBRATION_LANES.
//   - Sampling after calibration is 1 in AUDIT_ONE_IN, drawn here with crypto.randomInt. AUDIT_ONE_IN stays 1 (every waived lane
//     audited) until the owner decides how far sampling may go (spec D1: change it here, nowhere else).
//   - `gate` looks at one entry per tip (its newest state) and only at tips that are an ancestor of, or equal to, a pushed tip
//     (the pre-push hook gates every commit git is about to send, not the folder's HEAD).
//     A tip git does not know in this repository cannot be on the pushed history and is skipped.
import { randomInt } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { UsageError, runGit } from '../git-tidy/lib/git.mjs';
import { appendLog } from './lib/log.mjs';

export const CALIBRATION_LANES = 29; // 29 clean audits in a row: ln(0.05) / ln(0.9), spec U1
export const AUDIT_ONE_IN = 1; // 1 = audit every waived lane; 4 would sample one in four (spec U2, owner decision D1)

const EXIT_GATE_CLOSED = 1;
const EXIT_USAGE = 2;
const STATES = ['pending', 'done', 'error', 'sampled-out'];
const BLOCKING_STATES = new Set(['pending', 'error']);
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const VALUE_FLAGS = new Set(['--tip', '--base', '--reviewed', '--repo', '--state', '--confirmed', '--fixed-by']);
const BOOLEAN_FLAGS = new Set(['--escalate', '--json']);
const USAGE = 'usage: audit-log.mjs should-audit|record|resolve|gate|stats ... (see the header of audit-log.mjs)';
const SHORT_SHA = 8;

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (BOOLEAN_FLAGS.has(flag)) flags[flag] = true;
    else if (VALUE_FLAGS.has(flag) && rest[index + 1] !== undefined && !rest[index + 1].startsWith('--')) flags[flag] = rest[(index += 1)];
    else throw new UsageError(`${flag} is not a flag of ${command} or needs a value. ${USAGE}`);
  }
  return { command, flags };
}

const logPath = (env) => env.REVIEW_AUDIT_LOG || join(homedir(), '.claude', 'logs', 'review-audit.jsonl');

/** Every valid line of the log, oldest first; a missing file is an empty log. */
function readEntries(file) {
  if (!existsSync(file)) return [];
  const entries = [];
  for (const line of readFileSync(file, 'utf8').split(/\n|(?=\{"at":)/)) {
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object' && typeof entry.tip === 'string') entries.push(entry);
    } catch {
      // a line that is not JSON (a torn write from a crash) is skipped; the split above keeps it from joining the next record
    }
  }
  return entries;
}

/** The newest consecutive `done` records with confirmed 0. */
function streakOf(entries) {
  const counted = new Set();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const { state, confirmed, repo, tip } = entries[index];
    if (state === 'done' && confirmed === 0) counted.add(`${repo}\n${tip}`);
    else if (state === 'done') break;
  }
  return counted.size;
}

/** The newest state of each (repo, tip): `{ repo, tip, base, state, confirmed, resolved }`; a `resolved` line closes the state before it. */
function latestPerTip(entries) {
  const latest = new Map();
  for (const entry of entries) {
    const key = `${entry.repo}\n${entry.tip}`;
    if (entry.state === 'resolved') {
      if (latest.has(key)) latest.get(key).resolved = true;
    } else if (STATES.includes(entry.state)) {
      latest.set(key, { ...entry, resolved: false });
    }
  }
  return [...latest.values()];
}

/** Whether a lane must be audited. `draw(bound)` returns an integer in [0, bound); injected so sampling is testable. */
export function decideAudit({ streak, escalate, oneIn, draw }) {
  if (streak < CALIBRATION_LANES) return { audit: true, reason: 'calibration', streak };
  if (escalate) return { audit: true, reason: 'escalate', streak };
  if (draw(oneIn) === 0) return { audit: true, reason: 'sample', streak };
  return { audit: false, reason: 'sampled-out', streak };
}

function requireFlag(flags, name) {
  if (flags[name] === undefined) throw new UsageError(`${name} is required. ${USAGE}`);
  return flags[name];
}

/** `folder`: where git commands run; `key`: the repository's real common git dir, the same from any subfolder or linked worktree. */
function repoOf(flags) {
  const repo = requireFlag(flags, '--repo');
  if (!isAbsolute(repo) || !existsSync(repo)) throw new UsageError(`--repo must be an existing absolute folder: ${repo}`);
  const folder = realpathSync.native(repo);
  const common = runGit(folder, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.status !== 0) throw new UsageError(`--repo is not inside a git repository: ${repo}`);
  return { folder, key: realpathSync.native(common.stdout.trim()) };
}

/** The full commit sha of `value` in `repo`; `HEAD` only when `allowHead`. A flag-like or unknown value is a usage error. */
function commitOf(repo, value, flag, allowHead = false) {
  if (!SHA_PATTERN.test(value) && !(allowHead && value === 'HEAD')) throw new UsageError(`${flag} must be a commit sha${allowHead ? ' or HEAD' : ''}: ${value}`);
  const found = runGit(repo, ['rev-parse', '--verify', '--quiet', `${value}^{commit}`]);
  if (found.status !== 0) throw new UsageError(`${flag} is not a commit of ${repo}: ${value}`);
  return found.stdout.trim();
}

/** git exits 0 for an ancestor and 1 for none; any other exit is a git failure, which must not read as "not an ancestor". */
function isAncestor(folder, ancestor, descendant) {
  const { status, stderr } = runGit(folder, ['merge-base', '--is-ancestor', ancestor, descendant]);
  if (status !== 0 && status !== 1) throw new Error(`git merge-base failed (exit ${status}): ${stderr.trim()}`);
  return status === 0;
}

function commandShouldAudit(flags, env) {
  const tip = requireFlag(flags, '--tip');
  if (!SHA_PATTERN.test(tip)) throw new UsageError(`--tip must be a commit sha: ${tip}`);
  const decision = decideAudit({ streak: streakOf(readEntries(logPath(env))), escalate: flags['--escalate'] === true, oneIn: AUDIT_ONE_IN, draw: randomInt });
  return { code: 0, out: flags['--json'] ? JSON.stringify(decision) : `audit: ${decision.audit} (${decision.reason}, streak ${decision.streak})` };
}

function parseConfirmed(flags, state) {
  const text = flags['--confirmed'];
  if (state !== 'done') {
    if (text !== undefined) throw new UsageError('--confirmed is only for --state done');
    return undefined;
  }
  if (text === undefined || !/^\d+$/.test(text)) throw new UsageError('--state done needs --confirmed <n> (a count, 0 or more)');
  return Number(text);
}

function appendEntry(entry, env) {
  const failure = appendLog({ at: new Date().toISOString(), ...entry }, { REVIEW_TIER_LOG: logPath(env) });
  return failure === null ? { code: 0, out: `audit-log: recorded ${entry.state} for ${entry.tip.slice(0, SHORT_SHA)}` } : { code: EXIT_GATE_CLOSED, err: failure };
}

function commandRecord(flags, env) {
  const state = requireFlag(flags, '--state');
  if (!STATES.includes(state)) throw new UsageError(`--state must be one of ${STATES.join(', ')}: ${state}`);
  const confirmed = parseConfirmed(flags, state);
  const { folder, key } = repoOf(flags);
  const tip = commitOf(folder, requireFlag(flags, '--tip'), '--tip');
  const base = commitOf(folder, requireFlag(flags, '--base'), '--base');
  const reviewed = flags['--reviewed'] === undefined ? undefined : commitOf(folder, flags['--reviewed'], '--reviewed');
  const rangeEnd = reviewed ?? tip;
  if (state === 'done' && (base === rangeEnd || !isAncestor(folder, base, rangeEnd))) throw new UsageError('--state done needs a non-empty range: --base must be a strict ancestor of the reviewed tip');
  return appendEntry({ repo: key, tip, base, ...(reviewed === undefined ? {} : { reviewed }), state, ...(confirmed === undefined ? {} : { confirmed }) }, env);
}

function commandResolve(flags, env) {
  const { folder, key } = repoOf(flags);
  const tip = commitOf(folder, requireFlag(flags, '--tip'), '--tip');
  const fixedBy = commitOf(folder, requireFlag(flags, '--fixed-by'), '--fixed-by');
  const open = latestPerTip(readEntries(logPath(env))).find((entry) => entry.repo === key && entry.tip === tip);
  if (!open || open.resolved || open.state !== 'done' || !(open.confirmed > 0)) throw new UsageError(`${tip.slice(0, SHORT_SHA)} has no unresolved audit with findings; a pending or error audit is closed by an audit record`);
  if (fixedBy === tip || !isAncestor(folder, tip, fixedBy)) throw new UsageError(`${fixedBy.slice(0, SHORT_SHA)} must be a commit after ${tip.slice(0, SHORT_SHA)}`);
  return appendEntry({ repo: key, tip, fixedBy, state: 'resolved' }, env);
}

const blocksGate = (entry) => !entry.resolved && (BLOCKING_STATES.has(entry.state) || (entry.state === 'done' && entry.confirmed > 0));

function commandGate(flags, env) {
  const { folder, key } = repoOf(flags);
  const pushed = commitOf(folder, requireFlag(flags, '--tip'), '--tip', true);
  const closing = latestPerTip(readEntries(logPath(env)))
    .filter((entry) => entry.repo === key && blocksGate(entry))
    .filter((entry) => runGit(folder, ['cat-file', '-e', `${entry.tip}^{commit}`]).status === 0 && isAncestor(folder, entry.tip, pushed));
  if (closing.length === 0) return { code: 0, out: 'audit-log gate: open' };
  const lines = closing.map((entry) => `  ${entry.tip.slice(0, SHORT_SHA)} ${entry.state}${entry.state === 'done' ? ` confirmed ${entry.confirmed}` : ''}`);
  const how = 'audit it (pending/error) or fix the finding and run `audit-log resolve --repo <repo> --tip <sha> --fixed-by <fix-sha>`';
  return { code: EXIT_GATE_CLOSED, err: `audit-log gate: closed, ${closing.length} audit(s) not settled:\n${lines.join('\n')}\n${how}` };
}

function commandStats(flags, env) {
  const entries = readEntries(logPath(env));
  const lanes = latestPerTip(entries);
  const countOf = (state) => lanes.filter((lane) => lane.state === state).length;
  const streak = streakOf(entries);
  const lastMiss = entries.findLast((entry) => entry.state === 'done' && entry.confirmed > 0)?.tip ?? null;
  const stats = { audited: countOf('done'), sampledOut: countOf('sampled-out'), errors: countOf('error'), pending: countOf('pending'), streak, calibration: streak < CALIBRATION_LANES, lastMiss };
  if (flags['--json']) return { code: 0, out: JSON.stringify(stats) };
  const phase = stats.calibration ? `calibration (${streak}/${CALIBRATION_LANES} clean in a row)` : 'sampling';
  return { code: 0, out: `audited ${stats.audited}, sampled out ${stats.sampledOut}, errors ${stats.errors}, pending ${stats.pending}; ${phase}; last miss ${lastMiss ?? 'none'}` };
}

const COMMANDS = { 'should-audit': commandShouldAudit, record: commandRecord, resolve: commandResolve, gate: commandGate, stats: commandStats };

/** Runs one command line; returns `{ code, out?, err? }` and never throws for a caller mistake. */
export function run(argv, env = process.env) {
  try {
    const { command, flags } = parseArguments(argv);
    if (!Object.hasOwn(COMMANDS, command)) throw new UsageError(USAGE);
    return COMMANDS[command](flags, env);
  } catch (error) {
    if (error instanceof UsageError) return { code: EXIT_USAGE, err: error.message };
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { code, out, err } = run(process.argv.slice(2));
  if (out) console.log(out);
  if (err) console.error(err);
  process.exitCode = code;
}
