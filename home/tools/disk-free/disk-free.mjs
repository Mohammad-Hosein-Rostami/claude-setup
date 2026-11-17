#!/usr/bin/env node
// CLI of `disk-free`: one early signal before the disk fills up (every agent fails with ENOSPC otherwise).
// Usage: disk-free.mjs check [--path <dir>]     (default path: $HOME)
// Output: ONE line, `ok|WARN|FAIL  disk free <n> GB ...`; on WARN and FAIL the line also names the biggest rebuildable caches.
// Exit codes: 0 ok or WARN, 1 FAIL (free space below the fail threshold), 2 usage error or a threshold that is not a number.
// Env: DISK_FAIL_FREE_GB (default 5) and DISK_WARN_FREE_GB (default 15) move the thresholds; the warn value must be above the fail value.
//   Test hooks: DISK_FREE_DF_OUTPUT replaces the `df -Pk` text, DISK_FREE_CLAUDE_TMP replaces the claude session-folder root,
//   DISK_FREE_DU_TIMEOUT_MS shortens the total time for measuring all folders.
// Exports: availableGb, judgeFreeSpace (tests). The tool only reads: it measures folders and prints advice, it never deletes.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const KB_PER_GB = 1024 * 1024;
const DEFAULT_FAIL_GB = 5;
const DEFAULT_WARN_GB = 15;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const DU_TIMEOUT_MS = 30_000; // total for ALL folders (not each): huge caches must not push a doctor run or workflow start past the runner's 120 s limit; a folder left unmeasured is named without a size
const CACHES_NAMED = 3;
const USAGE = 'usage: disk-free.mjs check [--path <dir>]';
// df -Pk columns from the right: 1024-blocks, Used, Available, Capacity, Mounted on (the filesystem and mount names may hold spaces).
const DF_ROW = /^.+?\s+\d+\s+\d+\s+(\d+)\s+\d+%\s+.+$/;

class UsageError extends Error {}

/** Free space in GB from `df -Pk` text. @throws {UsageError} when the text has no df row */
export function availableGb(dfText) {
  const row = dfText.split('\n').slice(1).map((line) => DF_ROW.exec(line)).find(Boolean);
  if (!row) throw new UsageError(`not df output: ${JSON.stringify(dfText.slice(0, 80))}`);
  return Number(row[1]) / KB_PER_GB;
}

function threshold(env, name, fallback) {
  if (env[name] === undefined) return fallback;
  const value = Number(env[name]);
  if (!(value > 0)) throw new UsageError(`${name} must be a positive number of GB, got ${JSON.stringify(env[name])}`);
  return value;
}

/** @returns {{ level: 'ok'|'WARN'|'FAIL', failGb: number, warnGb: number }} the verdict for `freeGb` under the env thresholds */
export function judgeFreeSpace(freeGb, env) {
  const failGb = threshold(env, 'DISK_FAIL_FREE_GB', DEFAULT_FAIL_GB);
  const warnGb = threshold(env, 'DISK_WARN_FREE_GB', DEFAULT_WARN_GB);
  if (warnGb < failGb) throw new UsageError(`the warn threshold (${warnGb} GB) must not be below the fail threshold (${failGb} GB)`);
  const level = freeGb < failGb ? 'FAIL' : freeGb < warnGb ? 'WARN' : 'ok';
  return { level, failGb, warnGb };
}

const claudeSessionRoot = (env) => env.DISK_FREE_CLAUDE_TMP ?? `${process.platform === 'darwin' ? '/private/tmp' : '/tmp'}/claude-${process.getuid?.() ?? 'user'}`;

/** Rebuildable caches that exist here, each { name, shown, path, how }. Docker has no folder to measure, so it has no path. */
function cacheCandidates(home, env) {
  const inHome = (relative) => join(home, relative);
  return [
    { name: 'Xcode DerivedData', shown: '~/Library/Developer/Xcode/DerivedData', path: inHome('Library/Developer/Xcode/DerivedData'), how: 'Xcode rebuilds it' },
    { name: 'CoreSimulator', shown: '~/Library/Developer/CoreSimulator', path: inHome('Library/Developer/CoreSimulator'), how: 'xcrun simctl delete unavailable' },
    { name: '~/Library/Caches', shown: '~/Library/Caches', path: inHome('Library/Caches'), how: 'apps refill it' },
    { name: 'npm cache', shown: '~/.npm', path: inHome('.npm'), how: 'npm cache clean --force' },
    { name: 'pnpm store', shown: '~/Library/pnpm/store', path: inHome('Library/pnpm/store'), how: 'pnpm store prune' },
    { name: 'pnpm store', shown: '~/.local/share/pnpm/store', path: inHome('.local/share/pnpm/store'), how: 'pnpm store prune' },
    { name: 'claude session folders', shown: claudeSessionRoot(env), path: claudeSessionRoot(env), how: 'delete the folders of sessions that ended' },
  ].filter((cache) => existsSync(cache.path));
}

function sizeGb(path, deadlineMs) {
  const timeLeftMs = deadlineMs - Date.now();
  if (timeLeftMs <= 0) return null;
  const run = spawnSync('du', ['-sk', path], { encoding: 'utf8', timeout: timeLeftMs });
  const kb = Number(run.stdout?.split('\t')[0]);
  return run.error || !(kb >= 0) ? null : kb / KB_PER_GB;
}

/** One sentence naming the biggest caches (largest first), then the ones too big to measure in time, then docker (no folder to measure). */
function cacheAdvice(home, env) {
  const deadlineMs = Date.now() + Number(env.DISK_FREE_DU_TIMEOUT_MS ?? DU_TIMEOUT_MS);
  const measured = cacheCandidates(home, env).map((cache) => ({ ...cache, gb: sizeGb(cache.path, deadlineMs) }));
  const named = measured
    .filter((cache) => cache.gb !== null)
    .sort((a, b) => b.gb - a.gb)
    .slice(0, CACHES_NAMED)
    .map((cache) => `${cache.name} ${cache.gb.toFixed(1)} GB (${cache.shown}: ${cache.how})`);
  for (const cache of measured.filter((entry) => entry.gb === null)) named.push(`${cache.name} (size not measured in time; ${cache.shown}: ${cache.how})`);
  named.push('docker builder cache (docker builder prune)');
  return `Rebuildable caches to clear, biggest first: ${named.join('; ')}.`;
}

function check(argv, env) {
  const pathAt = argv.indexOf('--path');
  const target = pathAt === -1 ? homedir() : argv[pathAt + 1];
  if (!target) throw new UsageError(USAGE);
  const dfText = env.DISK_FREE_DF_OUTPUT ?? spawnSync('df', ['-Pk', target], { encoding: 'utf8' }).stdout ?? '';
  const freeGb = availableGb(dfText);
  const { level, failGb, warnGb } = judgeFreeSpace(freeGb, env);
  const free = `disk free ${freeGb.toFixed(1)} GB`;
  if (level === 'ok') return { code: 0, line: `ok    ${free} (fail below ${failGb} GB, warn below ${warnGb} GB)` };
  const limit = level === 'FAIL' ? failGb : warnGb;
  const consequence = level === 'FAIL' ? 'agents and builds will fail with ENOSPC.' : 'it will soon fill up.';
  return { code: level === 'FAIL' ? EXIT_FAIL : 0, line: `${level.padEnd(4)}  ${free} is below ${limit} GB: ${consequence} ${cacheAdvice(homedir(), env)}` };
}

function main(argv, env) {
  try {
    if (argv[0] !== 'check') throw new UsageError(USAGE);
    const { code, line } = check(argv.slice(1), env);
    console.log(line);
    return code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    return EXIT_USAGE;
  }
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = main(process.argv.slice(2), process.env);
