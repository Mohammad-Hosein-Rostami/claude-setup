#!/usr/bin/env node
// CLI of `disk-clean`: removes what Claude Code and this setup leave on the disk and nothing else. Dry run unless --apply.
// Usage: disk-clean.mjs [--apply] [--json] [--session <id>] [--claude-tmp <dir>] [--projects <dir>] [--tmp <dir>] [--now <ms>] [--budget-ms <n>] [--scan-ms <n>]
// Rules (lib/clean-rules.mjs): old session scratchpad folders, leftover test temp folders, throwaway-project folders in
//   ~/.claude/projects, old counters of the hooks in the temp folder. Never the current session (--session, else $CLAUDE_SESSION_ID,
//   and always the session with the newest transcript). Never follows a symlink; never removes outside the root of its rule.
//   A dry run stops looking after --scan-ms (default 30 s, a folder of a million entries is slow to read) and says so: the totals are then
//   a lower bound. --apply has no scan limit (it runs in the background).
// Output: what would go (or went) per rule with the item count and bytes; --json prints one line {apply, items, bytes, removed, failed, partial, rules}.
//   Measuring sizes stops at --budget-ms (default 20 s): later items are still counted and removed, their bytes are not added up.
// Exit codes: 0 ok, 1 something could not be removed, 2 usage error.
// Env: DISK_FREE_CLAUDE_TMP replaces the scratchpad root (as for disk-free). The flags replace the other roots (tests use fake ones).
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { claudeSessionRoot } from './disk-free.mjs';
import { treeBytes, removeInside } from './lib/clean-scan.mjs';
import { rulesFor } from './lib/clean-rules.mjs';

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const SAMPLE_PER_RULE = 5; // items listed per rule; the rest are only counted
const DEFAULT_BUDGET_MS = 20_000;
const DEFAULT_DRY_RUN_SCAN_MS = 30_000;
const BYTES_PER_GB = 1024 ** 3;
const USAGE = 'usage: disk-clean.mjs [--apply] [--json] [--session <id>] [--claude-tmp <dir>] [--projects <dir>] [--tmp <dir>] [--now <ms>] [--budget-ms <n>] [--scan-ms <n>]';
const VALUE_FLAGS = new Set(['--session', '--claude-tmp', '--projects', '--tmp', '--now', '--budget-ms', '--scan-ms']);

const NUMBER_OPTION = { '--now': 'nowMs', '--budget-ms': 'budgetMs', '--scan-ms': 'scanMs' };

class UsageError extends Error {}

function parseArgs(argv, env) {
  const options = { apply: false, json: false, session: env.CLAUDE_SESSION_ID, claudeTmp: claudeSessionRoot(env), projects: join(homedir(), '.claude', 'projects'), tmp: tmpdir(), nowMs: Date.now(), budgetMs: DEFAULT_BUDGET_MS, scanMs: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--apply') options.apply = true;
    else if (flag === '--json') options.json = true;
    else if (VALUE_FLAGS.has(flag) && argv[i + 1] !== undefined) {
      const value = argv[(i += 1)];
      if (flag === '--session') options.session = value;
      else if (flag === '--claude-tmp') options.claudeTmp = value;
      else if (flag === '--projects') options.projects = value;
      else if (flag === '--tmp') options.tmp = value;
      else if (Number.isFinite(Number(value)) && Number(value) >= 0) options[NUMBER_OPTION[flag]] = Number(value);
      else throw new UsageError(`${flag} needs a number, got ${JSON.stringify(value)}`);
    } else throw new UsageError(USAGE);
  }
  return options;
}

/**
 * Runs the rules; with options.apply also removes what they find.
 * @param {object} options as parseArgs makes them (claudeTmp, projects, tmp, session, nowMs, budgetMs, apply)
 * @returns {Promise<{ items: number, bytes: number, removed: number, failed: string[], rules: object[] }>}
 */
export async function runClean(options) {
  const deadlineMs = Date.now() + options.budgetMs;
  const scanMs = options.scanMs ?? (options.apply ? Infinity : DEFAULT_DRY_RUN_SCAN_MS);
  const scanEndsAt = Date.now() + scanMs;
  const summary = { items: 0, bytes: 0, removed: 0, failed: [], rules: [], partial: false };
  for (const rule of rulesFor()) {
    const found = { name: rule.name, label: rule.label, items: 0, bytes: 0, sample: [] };
    for await (const { path, root } of rule.find(options)) {
      if (Date.now() > scanEndsAt) {
        summary.partial = true;
        break;
      }
      const { bytes } = await treeBytes(path, deadlineMs);
      found.items += 1;
      found.bytes += bytes;
      if (found.sample.length < SAMPLE_PER_RULE) found.sample.push({ path, bytes });
      if (!options.apply) continue;
      try {
        removeInside(realpathSync(root), path);
        summary.removed += 1;
      } catch (error) {
        summary.failed.push(`${path}: ${error.message}`);
      }
    }
    summary.items += found.items;
    summary.bytes += found.bytes;
    summary.rules.push(found);
    if (summary.partial) break;
  }
  return summary;
}

const gb = (bytes) => (bytes >= BYTES_PER_GB / 10 ? `${(bytes / BYTES_PER_GB).toFixed(2)} GB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);

function report(summary, apply) {
  const lines = [`disk-clean${apply ? '' : ' (dry run)'}: ${summary.items} items, ${gb(summary.bytes)} ${apply ? `found, ${summary.removed} removed` : 'can be removed'}`];
  for (const rule of summary.rules) {
    lines.push(`  ${rule.label}: ${rule.items} items, ${gb(rule.bytes)}`);
    for (const item of rule.sample) lines.push(`    ${item.path} (${gb(item.bytes)})`);
    if (rule.items > rule.sample.length) lines.push(`    ... and ${rule.items - rule.sample.length} more`);
  }
  for (const failure of summary.failed) lines.push(`  NOT removed: ${failure}`);
  if (summary.partial) lines.push('Stopped looking at the scan time limit: the totals are a lower bound (use --scan-ms for more).');
  if (!apply && summary.items > 0) lines.push('Run again with --apply to remove them.');
  return lines.join('\n');
}

async function main(argv, env) {
  try {
    const options = parseArgs(argv, env);
    const summary = await runClean(options);
    if (options.json) console.log(JSON.stringify({ apply: options.apply, items: summary.items, bytes: summary.bytes, removed: summary.removed, failed: summary.failed.length, partial: summary.partial, rules: Object.fromEntries(summary.rules.map((rule) => [rule.name, { items: rule.items, bytes: rule.bytes }])) }));
    else console.log(report(summary, options.apply));
    return summary.failed.length > 0 ? EXIT_FAILED : 0;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    return EXIT_USAGE;
  }
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2), process.env);
