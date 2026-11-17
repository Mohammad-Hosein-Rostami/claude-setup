#!/usr/bin/env node
// CLI of `disk-clean`: removes what Claude Code and this setup leave on the disk and nothing else. Dry run unless --apply.
// Usage: disk-clean.mjs [--apply] [--json] [--session <id>] [--claude-tmp <dir>] [--projects <dir>] [--tmp <dir>] [--sessions <dir>] [--now <ms>] [--budget-ms <n>] [--scan-ms <n>]
// Rules (lib/clean-rules.mjs): old session scratchpad folders, leftover test temp folders, throwaway-project folders in
//   ~/.claude/projects, old counters of the hooks in the temp folder. Never the current session (--session, else $CLAUDE_CODE_SESSION_ID
//   or $CLAUDE_SESSION_ID, and always the session with the newest transcript) and never a running one (~/.claude/sessions/*.json with a live pid).
//   Never follows a symlink; removes only what is owned by this user in folders closed to others (lib/safe-remove.mjs); refuses an unsafe root.
//   Everything is looked at again right before it is removed: a session resumed during the run keeps its folder.
//   A dry run stops looking after --scan-ms (default 30 s, a folder of a million entries is slow to read) and says so: the totals are then
//   a lower bound. --apply has no scan limit (it runs in the background).
// Output: what would go (or went) per rule with the item count and bytes; --json prints one line {apply, items, bytes, removed, changed, failed, refused, partial, rules}.
//   Measuring sizes stops at --budget-ms (default 20 s): later items are still counted and removed, their bytes are not added up and the totals say "partial".
// Exit codes: 0 ok, 1 something could not be removed, 2 usage error. An error on one item is listed and the run goes on with the next.
// Env: DISK_FREE_CLAUDE_TMP replaces the scratchpad root (as for disk-free). The flags replace the other roots (tests use fake ones).
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { claudeSessionRoot } from './disk-free.mjs';
import { treeBytes } from './lib/clean-scan.mjs';
import { rulesFor } from './lib/clean-rules.mjs';
import { removeInside } from './lib/safe-remove.mjs';

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const SAMPLE_PER_RULE = 5; // items listed per rule; the rest are only counted
const DEFAULT_BUDGET_MS = 20_000;
const DEFAULT_DRY_RUN_SCAN_MS = 30_000;
const BYTES_PER_GB = 1024 ** 3;
const USAGE = 'usage: disk-clean.mjs [--apply] [--json] [--session <id>] [--claude-tmp <dir>] [--projects <dir>] [--tmp <dir>] [--sessions <dir>] [--now <ms>] [--budget-ms <n>] [--scan-ms <n>]';
const VALUE_FLAGS = new Set(['--session', '--claude-tmp', '--projects', '--tmp', '--sessions', '--now', '--budget-ms', '--scan-ms']);
const TEXT_OPTION = { '--session': 'session', '--claude-tmp': 'claudeTmp', '--projects': 'projects', '--tmp': 'tmp', '--sessions': 'sessions' };
const NUMBER_OPTION = { '--now': 'nowMs', '--budget-ms': 'budgetMs', '--scan-ms': 'scanMs' };

class UsageError extends Error {}

function parseArgs(argv, env) {
  const claudeDir = join(homedir(), '.claude');
  const options = {
    apply: false, json: false, session: env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || undefined, claudeTmp: claudeSessionRoot(env),
    projects: join(claudeDir, 'projects'), sessions: join(claudeDir, 'sessions'), tmp: tmpdir(), nowMs: Date.now(), budgetMs: DEFAULT_BUDGET_MS, scanMs: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--apply') options.apply = true;
    else if (flag === '--json') options.json = true;
    else if (VALUE_FLAGS.has(flag) && argv[i + 1] !== undefined) {
      const value = argv[(i += 1)];
      if (TEXT_OPTION[flag] !== undefined) options[TEXT_OPTION[flag]] = value;
      else if (Number.isFinite(Number(value)) && Number(value) >= 0) options[NUMBER_OPTION[flag]] = Number(value);
      else throw new UsageError(`${flag} needs a number, got ${JSON.stringify(value)}`);
    } else throw new UsageError(USAGE);
  }
  return options;
}

/** Measures one found item and, with options.apply, removes it if it is still removable. An error is listed, never thrown. */
async function handleItem(item, found, summary, options, deadlineMs) {
  try {
    const { bytes, complete } = await treeBytes(item.path, deadlineMs);
    if (!complete) summary.partial = true;
    found.items += 1;
    found.bytes += bytes;
    if (found.sample.length < SAMPLE_PER_RULE) found.sample.push({ path: item.path, bytes });
    if (!options.apply) return;
    await options.beforeRemove?.(item.path);
    if (!(await item.stillRemovable())) {
      summary.changed += 1;
      return;
    }
    removeInside(item.root, item.path);
    summary.removed += 1;
  } catch (error) {
    summary.failed.push(`${item.path}: ${error.message}`);
  }
}

async function runRule(rule, context, summary) {
  const found = { name: rule.name, label: rule.label, items: 0, bytes: 0, sample: [] };
  try {
    for await (const item of rule.find(context)) {
      if (context.timeUp()) break;
      await handleItem(item, found, summary, context, context.deadlineMs);
    }
  } catch (error) {
    summary.failed.push(`${rule.label}: stopped, ${error.message}`);
  }
  summary.items += found.items;
  summary.bytes += found.bytes;
  summary.rules.push(found);
}

/**
 * Runs the rules; with options.apply also removes what they find.
 * @param {object} options as parseArgs makes them (claudeTmp, projects, tmp, sessions, session, nowMs, budgetMs, scanMs, apply); beforeRemove(path) is a test hook called before each removal
 * @returns {Promise<{ items: number, bytes: number, removed: number, changed: number, failed: string[], refused: string[], partial: boolean, rules: object[] }>}
 */
export async function runClean(options) {
  const deadlineMs = Date.now() + options.budgetMs;
  const scanEndsAt = Date.now() + (options.scanMs ?? (options.apply ? Infinity : DEFAULT_DRY_RUN_SCAN_MS));
  let scanCutShort = false;
  const refused = [];
  const context = { ...options, home: options.home ?? homedir(), refused, deadlineMs, timeUp: () => (scanCutShort ||= Date.now() > scanEndsAt) };
  const summary = { items: 0, bytes: 0, removed: 0, changed: 0, failed: [], refused, rules: [], partial: false };
  for (const rule of rulesFor()) {
    await runRule(rule, context, summary);
    if (scanCutShort) break;
  }
  summary.partial ||= scanCutShort;
  return summary;
}

const gb = (bytes) => (bytes >= BYTES_PER_GB / 10 ? `${(bytes / BYTES_PER_GB).toFixed(2)} GB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);

function report(summary, apply) {
  const lines = [`disk-clean${apply ? '' : ' (dry run)'}: ${summary.items} items, ${gb(summary.bytes)}${summary.partial ? ' or more' : ''} ${apply ? `found, ${summary.removed} removed` : 'can be removed'}`];
  for (const rule of summary.rules) {
    lines.push(`  ${rule.label}: ${rule.items} items, ${gb(rule.bytes)}`);
    for (const item of rule.sample) lines.push(`    ${item.path} (${gb(item.bytes)})`);
    if (rule.items > rule.sample.length) lines.push(`    ... and ${rule.items - rule.sample.length} more`);
  }
  for (const failure of summary.failed) lines.push(`  NOT removed: ${failure}`);
  for (const reason of summary.refused) lines.push(`  SKIPPED: ${reason}`);
  if (summary.changed > 0) lines.push(`  ${summary.changed} item(s) changed during the run (a session was resumed) and were kept.`);
  if (summary.partial) lines.push('Some totals are a lower bound: the scan or size-measuring time limit was reached (use --scan-ms and --budget-ms for more).');
  if (!apply && summary.items > 0) lines.push('Run again with --apply to remove them.');
  return lines.join('\n');
}

async function main(argv, env) {
  try {
    const options = parseArgs(argv, env);
    const summary = await runClean(options);
    if (options.json) {
      const rules = Object.fromEntries(summary.rules.map((rule) => [rule.name, { items: rule.items, bytes: rule.bytes }]));
      console.log(JSON.stringify({ apply: options.apply, items: summary.items, bytes: summary.bytes, removed: summary.removed, changed: summary.changed, failed: summary.failed.length, refused: summary.refused.length, partial: summary.partial, rules }));
    } else console.log(report(summary, options.apply));
    return summary.failed.length > 0 ? EXIT_FAILED : 0;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    return EXIT_USAGE;
  }
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2), process.env);
