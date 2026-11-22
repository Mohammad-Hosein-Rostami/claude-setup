// Shared fixtures for the land-lane tests: a throw-away repo with a declared suite, a STATUS.md with one open `close:1` row, and a private HOME,
// and df text, so the real tools (git-tidy, disk-free, status) run on nothing of the owner's.
// Exports: LAND_LANE, makeWorld (run, runAsync), laneAt, landArgs, readRow.
// Invariants: no GIT_* or session id reaches a child (CLEAN_ENV); HOME is a private folder; the suite command of the repo is the `suite` option.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, commit, git, makeRepo } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

export const LAND_LANE = fileURLToPath(new URL('../home/tools/land-lane/land-lane.mjs', import.meta.url));
const KB_PER_GB = 1024 * 1024;
const PASSING_SUITE = 'node -e "process.exit(0)"';
const STATUS_TEXT = `# STATUS

## Work items

| id | item | size | started | done | evidence |
| -- | ---- | ---- | ------- | ---- | -------- |
| close:1 | land the lane | S | 2026-11-22T10:00Z | - | - |
| close:2 | land the other lane | S | 2026-11-22T10:00Z | - | - |
`;
const dfWithFreeGb = (gb) => `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 976490576 900000000 ${Math.round(gb * KB_PER_GB)} 99% /System/Volumes/Data\n`;

/**
 * A repo on `main` whose root package.json declares `suite`, with the tools' private state around it.
 * @param {{ suite?: string, freeGb?: number }} options the repo's declared suite command, the df text's free space
 * @returns {{ dir: string, home: string, statusFile: string, auditLog: string, env: object, run: Function, runAsync: Function }}
 */
export function makeWorld({ suite = PASSING_SUITE, freeGb = 80 } = {}) {
  const dir = makeRepo();
  commit(dir, 'package.json', `${JSON.stringify({ scripts: { test: suite } })}\n`);
  const home = makeTempDir('land-lane-home-');
  const statusFolder = join(makeTempDir('land-lane-status-'), 'my status'); // a space in a path must reach status.mjs whole
  mkdirSync(statusFolder);
  const statusFile = join(statusFolder, 'STATUS.md');
  writeFileSync(statusFile, STATUS_TEXT);
  const { NODE_TEST_CONTEXT, ...cleanEnv } = CLEAN_ENV; // a suite that runs `node --test` must not think it is a child of this test run
  const env = { ...cleanEnv, HOME: home, USERPROFILE: home, DISK_FREE_DF_OUTPUT: dfWithFreeGb(freeGb), DISK_FREE_CLAUDE_TMP: join(home, 'no-claude-tmp') };
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [LAND_LANE, ...args], { cwd: dir, encoding: 'utf8', env: { ...env, ...extraEnv } });
  const runAsync = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [LAND_LANE, ...args], { cwd: dir, env });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('close', (status) => resolve({ status, stdout }));
  });
  return { dir, home, statusFile, env, run, runAsync };
}

/** A lane `name` with one commit adding `<file>` off main, then main moved on by one commit; returns { tip } (the reviewed tip). */
export function laneAt(world, name, file = 'lane.txt') {
  git(world.dir, 'checkout', '-q', '-b', name);
  const tip = commit(world.dir, file);
  git(world.dir, 'checkout', '-q', 'main');
  commit(world.dir, `moved-${file}`);
  return { tip };
}

/** The land-lane arguments for `branch` at `tip` (closing row `row`); `extra` follows. */
export const landArgs = (world, branch, tip, extra = [], row = 'close:1') => ['--repo', world.dir, '--branch', branch, '--tip', tip, '--base', 'main', '--status-file', world.statusFile, '--close-row', row, ...extra];

/** The `close:1` row of the world's STATUS.md. */
export const readRow = (world) => readFileSync(world.statusFile, 'utf8').split('\n').find((line) => line.startsWith('| close:1')) ?? '';
