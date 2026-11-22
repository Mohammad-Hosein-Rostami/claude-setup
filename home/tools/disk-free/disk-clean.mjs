#!/usr/bin/env node
// CLI of `disk-clean`: removes what Claude Code and this setup leave on the disk and nothing else. Dry run unless --apply.
// Usage: disk-clean.mjs [--apply] [--json] [--all-lines] [--session <id>] [--claude-tmp <dir>] [--projects <dir>] [--tmp <dir>] [--sessions <dir>] [--figma-cache <dir>] [--now <ms>] [--budget-ms <n>] [--scan-ms <n>]
// Rules (lib/clean-rules.mjs): old session scratchpad folders (3 days idle; 30 days when the session's transcript is not in the projects folder read,
//   because it may be a session of another config dir), in a kept session's scratchpad the cs-test-* and clone folders idle 2 days that hold
//   no git work (a worktree, changes, untracked files, stashes, commits no remote holds), leftover test temp folders, throwaway-project folders in
//   ~/.claude/projects, old counters of the hooks in the temp folder, Figma pulls in ~/.cache/figma idle for 30 days. Never the folder of the current session (--session, else $CLAUDE_CODE_SESSION_ID
//   or $CLAUDE_SESSION_ID, and always the session with the newest transcript) and never a running one's (only the scratch rule looks inside them) (~/.claude/sessions/*.json with a live pid).
//   Never follows a symlink; removes only what is owned by this user in folders closed to others (lib/safe-remove.mjs); refuses an unsafe root.
//   Everything is looked at again right before it is removed: a session resumed during the run keeps its folder.
//   A dry run stops looking after --scan-ms (default 30 s, a folder of a million entries is slow to read) and says so: the totals are then
//   a lower bound. --apply has no scan limit (it runs in the background).
// Output: what would go (or went) per rule with the item count and bytes; --json prints one line {apply, items, bytes, removed, changed, failed, refused, keptUnknown, firstSeenKept, partial, rules}.
//   Measuring sizes stops at --budget-ms (default 20 s): later items are still counted and removed, their bytes are not added up and the totals say "partial".
//   The text report is read by people and by models, and folder names are anyone's text: every path, failure and reason is printed escaped
//   (printable ASCII only, hooks/lib/shown-name.mjs), and the NOT removed and SKIPPED lists stop at 10 lines each plus "... and N more".
//   --all-lines prints both lists whole; the start hook passes it, so the whole list is only in its log (~/.claude/logs/disk-clean.log).
// --apply takes a lock file (~/.claude/state/disk-clean.run.lock): a second run at the same time does nothing (it says so and exits 0).
// Exit codes: 0 ok, 1 something could not be removed, 2 usage error. An error on one item is listed and the run goes on with the next.
//   A folder whose removal fails after it was renamed aside is renamed back; the listed line names the path the folder has then. A run
//   handles each path once (a folder that was renamed back can be met again by the rule that is still reading its parent).
// Env: DISK_FREE_CLAUDE_TMP replaces the scratchpad root (as for disk-free). The flags replace the other roots (tests use fake ones).
//   --now may not be later than the clock (a future time would shorten every age). With CLAUDE_CONFIG_DIR set and no --projects the
//   two rules that read ~/.claude are skipped, and the report says so. Every line printed, errors included, goes through `escaped`.
import { mkdirSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { escaped } from '../../hooks/lib/shown-name.mjs';
import { claudeSessionRoot } from './disk-free.mjs';
import { lstatOrNull, treeBytes } from './lib/clean-scan.mjs';
import { releaseLock, takeLock } from './lib/lock-file.mjs';
import { AGE, rulesFor } from './lib/clean-rules.mjs';
import { moveAside, moveBack, originalName, removeInside } from './lib/safe-remove.mjs';

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const SAMPLE_PER_RULE = 5; // items listed per rule; the rest are only counted
const MAX_LISTED_LINES = 10; // NOT removed lines, and SKIPPED lines, in the text report unless --all-lines; the rest are only counted
const DEFAULT_BUDGET_MS = 20_000;
const DEFAULT_DRY_RUN_SCAN_MS = 30_000;
const BYTES_PER_GB = 1024 ** 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const UNKNOWN_SESSION_IDLE_DAYS = AGE.unknownSessionFolderMs / MS_PER_DAY;
const SCRATCH_SEEN_DAYS = AGE.sessionScratchMs / MS_PER_DAY;
const RUN_LOCK_STALE_MS = 6 * 60 * 60 * 1000; // a run takes minutes; a lock this old was left by a killed run
const USAGE = 'usage: disk-clean.mjs [--apply] [--json] [--all-lines] [--session <id>] [--claude-tmp <dir>] [--projects <dir>] [--tmp <dir>] [--sessions <dir>] [--figma-cache <dir>] [--now <ms>] [--budget-ms <n>] [--scan-ms <n>]';
const VALUE_FLAGS = new Set(['--session', '--claude-tmp', '--projects', '--tmp', '--sessions', '--figma-cache', '--now', '--budget-ms', '--scan-ms']);
const TEXT_OPTION = { '--session': 'session', '--claude-tmp': 'claudeTmp', '--projects': 'projects', '--tmp': 'tmp', '--sessions': 'sessions', '--figma-cache': 'figmaCache' };
const NUMBER_OPTION = { '--now': 'nowMs', '--budget-ms': 'budgetMs', '--scan-ms': 'scanMs' };

class UsageError extends Error {}

function parseArgs(argv, env) {
  const home = homedir();
  // With CLAUDE_CONFIG_DIR set, Claude Code keeps its transcripts and session registry elsewhere: the default folders would show no sessions at all.
  const claudeDir = isAbsolute(home) && !env.CLAUDE_CONFIG_DIR ? join(home, '.claude') : undefined;
  const options = {
    apply: false, json: false, allLines: false, session: env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || undefined, claudeTmp: claudeSessionRoot(env),
    projects: claudeDir && join(claudeDir, 'projects'), sessions: claudeDir && join(claudeDir, 'sessions'), tmp: tmpdir(), nowMs: Date.now(), budgetMs: DEFAULT_BUDGET_MS, scanMs: undefined,
    figmaCache: isAbsolute(home) ? join(home, '.cache', 'figma') : undefined, otherConfigDir: Boolean(env.CLAUDE_CONFIG_DIR),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--apply') options.apply = true;
    else if (flag === '--json') options.json = true;
    else if (flag === '--all-lines') options.allLines = true;
    else if (VALUE_FLAGS.has(flag) && argv[i + 1] !== undefined) {
      const value = argv[(i += 1)];
      if (TEXT_OPTION[flag] !== undefined) options[TEXT_OPTION[flag]] = value;
      else if (Number.isFinite(Number(value)) && Number(value) >= 0) options[NUMBER_OPTION[flag]] = Number(value);
      else throw new UsageError(`${flag} needs a number, got ${JSON.stringify(value)}`);
    } else throw new UsageError(USAGE);
  }
  if (options.nowMs > Date.now()) throw new UsageError(`--now ${options.nowMs} is later than the clock: a future time would shorten every age`);
  return options;
}

/**
 * Renames a folder that was moved aside back to its own name (a rename only: nothing is removed).
 * @returns {{ back: boolean, where: string }} whether it is back, and a sentence that names the path the folder has now
 */
function putBack(item, aside) {
  try {
    moveBack(item.root, aside, item.path);
    return { back: true, where: `the folder was put back at ${item.path}` };
  } catch (error) {
    const stays = lstatOrNull(aside) !== null ? `it stays as ${aside}` : `and it is no longer at ${aside}`; // said only after a look: the path named must exist
    return { back: false, where: `the folder could not be renamed back (${error.message}), ${stays}` };
  }
}

/**
 * Removes one item that was just found removable. A folder is first renamed aside (atomic, same parent) and looked at again: a session that
 * resumed after the last look writes to a new folder, and the old one goes back if the session is live after all. Whatever fails after
 * the rename (the second look, the removal itself), the folder is renamed back if its name is free, so it is never left under a name
 * the report does not give.
 * @throws {Error} with the reason and the path the folder has now
 */
async function removeItem(item, summary, options) {
  const isFolder = lstatOrNull(item.path)?.isDirectory() === true;
  const isAside = originalName(basename(item.path)) !== basename(item.path); // left by a killed run: already renamed, so removed where it is
  if (!isFolder || isAside) {
    removeInside(item.root, item.path);
    summary.removed += 1;
    return;
  }
  const aside = moveAside(item.root, item.path);
  let emptying = false;
  try {
    await options.afterMoveAside?.(aside);
    if (await item.stillRemovable(aside)) {
      emptying = true;
      removeInside(item.root, aside);
      summary.removed += 1;
      return;
    }
  } catch (error) {
    throw new Error(`${error.message}; ${putBack(item, aside).where}${emptying ? ', possibly partly emptied' : ''}`);
  }
  const { back, where } = putBack(item, aside);
  if (!back) throw new Error(`a session came back during the removal: ${where}`);
  summary.changed += 1;
}

/** Measures one found item and, with options.apply, removes it if it is still removable. An error is listed, never thrown. */
async function handleItem(item, found, summary, options, deadlineMs) {
  const originalPath = join(dirname(item.path), originalName(basename(item.path)));
  if (options.handled.has(originalPath)) return; // met again: a folder this run renamed back, or a leftover and a new folder of one name
  options.handled.add(originalPath);
  try {
    const { bytes, complete } = await treeBytes(item.path, deadlineMs);
    if (!complete) summary.partial = true;
    found.items += 1;
    found.bytes += bytes;
    if (found.sample.length < SAMPLE_PER_RULE) found.sample.push({ path: item.path, bytes });
    if (!options.apply) return;
    await options.beforeRemove?.(item.path);
    if (await item.stillRemovable(item.path)) await removeItem(item, summary, options);
    else summary.changed += 1;
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
 * @param {object} options as parseArgs makes them (claudeTmp, projects, tmp, sessions, session, nowMs, budgetMs, scanMs, apply); beforeRemove(path) and afterMoveAside(path) are test hooks called before the first look and after the folder was renamed aside
 * @returns {Promise<{ items: number, bytes: number, removed: number, changed: number, failed: string[], refused: string[], keptUnknown: number, partial: boolean, rules: object[] }>}
 *   keptUnknown counts the session folders kept only because their session's transcript is not in options.projects; firstSeenKept the
 *   scratchpad cs-test and clone folders this run met for the first time (lib/first-seen.mjs), kept for now
 */
export async function runClean(options) {
  const deadlineMs = Date.now() + options.budgetMs;
  const scanEndsAt = Date.now() + (options.scanMs ?? (options.apply ? Infinity : DEFAULT_DRY_RUN_SCAN_MS));
  let scanCutShort = false;
  const refused = [];
  const context = { ...options, home: options.home ?? homedir(), refused, keptUnknown: 0, firstSeenKept: 0, handled: new Set(), deadlineMs, timeUp: () => (scanCutShort ||= Date.now() > scanEndsAt) };
  const summary = { items: 0, bytes: 0, removed: 0, changed: 0, failed: [], refused, keptUnknown: 0, firstSeenKept: 0, rules: [], partial: false };
  for (const rule of rulesFor()) {
    await runRule(rule, context, summary);
    if (scanCutShort) break;
  }
  summary.keptUnknown = context.keptUnknown;
  summary.firstSeenKept = context.firstSeenKept;
  summary.partial ||= scanCutShort;
  return summary;
}

const gb = (bytes) => (bytes >= BYTES_PER_GB / 10 ? `${(bytes / BYTES_PER_GB).toFixed(2)} GB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);

/** One list of the report (failures or refusals): each entry escaped as a whole, at most MAX_LISTED_LINES of them unless `all`, then how many more there are. */
function listed(label, entries, all) {
  const shown = all ? entries : entries.slice(0, MAX_LISTED_LINES);
  const lines = shown.map((entry) => `  ${label}: ${escaped(entry)}`);
  return entries.length > shown.length ? [...lines, `  ... and ${entries.length - shown.length} more ${label}`] : lines;
}

/**
 * The text report of a run. Every string that comes from the file system (paths, failure messages, refusal reasons) is escaped, so a
 * folder name can never start a line of its own or carry control characters into a terminal or a model's context.
 * @param {object} summary what runClean returned
 * @param {{ apply: boolean, projects?: string, allLines?: boolean }} options allLines lists every failure and refusal instead of the first MAX_LISTED_LINES
 * @returns {string} the lines, joined with newlines
 */
export function report(summary, options) {
  const { apply, projects, allLines = false } = options;
  const lines = [`disk-clean${apply ? '' : ' (dry run)'}: ${summary.items} items, ${gb(summary.bytes)}${summary.partial ? ' or more' : ''} ${apply ? `found, ${summary.removed} removed` : 'can be removed'}`];
  for (const rule of summary.rules) {
    lines.push(`  ${rule.label}: ${rule.items} items, ${gb(rule.bytes)}`);
    for (const item of rule.sample) lines.push(`    ${escaped(item.path)} (${gb(item.bytes)})`);
    if (rule.items > rule.sample.length) lines.push(`    ... and ${rule.items - rule.sample.length} more`);
  }
  lines.push(...listed('NOT removed', summary.failed, allLines), ...listed('SKIPPED', summary.refused, allLines));
  if (options.otherConfigDir && options.projects === undefined) lines.push('  CLAUDE_CONFIG_DIR is set: the session-folders and temp-projects rules read ~/.claude and were skipped in this run.');
  if (summary.keptUnknown > 0) lines.push(`  ${summary.keptUnknown} session folder(s) kept: no transcript in ${escaped(String(projects))} (maybe another config dir); removed after ${UNKNOWN_SESSION_IDLE_DAYS} idle days`);
  if (summary.firstSeenKept > 0) lines.push(`  ${summary.firstSeenKept} cs-test or clone folder(s) first seen, kept: removed once first seen ${SCRATCH_SEEN_DAYS} days ago and idle as long`);
  if (summary.changed > 0) lines.push(`  ${summary.changed} item(s) changed during the run (a session was resumed) and were kept.`);
  if (summary.partial) lines.push('Some totals are a lower bound: the scan or size-measuring time limit was reached (use --scan-ms and --budget-ms for more).');
  if (!apply && summary.items > 0) lines.push('Run again with --apply to remove them.');
  return lines.join('\n');
}

/** Takes the lock that keeps two --apply runs from working at once. Returns the release function, or null with the reason printed. */
function takeRunLock() {
  const home = homedir();
  if (!isAbsolute(home)) {
    console.log(`disk-clean: nothing done, the home folder ${escaped(JSON.stringify(home))} is not an absolute path`);
    return null;
  }
  const lockPath = join(home, '.claude', 'state', 'disk-clean.run.lock');
  mkdirSync(dirname(lockPath), { recursive: true });
  if (!takeLock(lockPath, Date.now(), RUN_LOCK_STALE_MS)) {
    console.log('disk-clean: nothing done, another run is working');
    return null;
  }
  return () => releaseLock(lockPath);
}

async function runAndPrint(options) {
  const summary = await runClean(options);
  if (options.json) {
    const rules = Object.fromEntries(summary.rules.map((rule) => [rule.name, { items: rule.items, bytes: rule.bytes }]));
    console.log(JSON.stringify({ apply: options.apply, items: summary.items, bytes: summary.bytes, removed: summary.removed, changed: summary.changed, failed: summary.failed.length, refused: summary.refused.length, keptUnknown: summary.keptUnknown, firstSeenKept: summary.firstSeenKept, partial: summary.partial, rules }));
  } else console.log(report(summary, options));
  return summary.failed.length > 0 ? EXIT_FAILED : 0;
}

async function main(argv, env) {
  try {
    const options = parseArgs(argv, env);
    const release = options.apply ? takeRunLock() : () => {};
    if (release === null) return 0;
    try {
      return await runAndPrint(options);
    } finally {
      release();
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(escaped(error.message));
    return EXIT_USAGE;
  }
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.exitCode = await main(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(`disk-clean: ${escaped(String(error?.stack ?? error))}`); // an unexpected error, escaped like every other line
    process.exitCode = EXIT_FAILED;
  }
}
