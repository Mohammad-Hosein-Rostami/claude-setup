// Fixtures for tests/git-tidy-lane-pool.test.mjs: run `git-tidy lane`, fake package managers that log what ran, byte snapshots of folders.
// Exports: laneEnv, lane, claim, laneLines, fakeInstallers, installLog, snapshot, backdateUse, poolPath, adminDir, deadPid, writeFile.
// Invariants: every repo lives in a cs-test- temp folder (git-tidy-helpers.mjs makeRepo); each laneEnv has its own temp HOME (the
//   job-made record goes there) and a session id, so no test reads or writes the real ~/.claude. The fake installers are node scripts
//   (no shell) that append one JSON line per run to $FAKE_INSTALL_LOG and fail when $FAKE_INSTALL_FAIL is set.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { delimiter, dirname, join } from 'node:path';
import { git, lines, tidy } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { sharedToolDir } from './shared-tools.mjs';

const PROGRAMS = { npm: ['npm', 'bin', 'npm-cli.js'], pnpm: ['pnpm', 'bin', 'pnpm.cjs'], yarn: ['yarn', 'bin', 'yarn.js'] };
const IDLE_MS = 30 * 60 * 60 * 1000; // older than RECLAIM_IDLE_MS (24 h)

/** An environment for one test: fresh HOME, a session id, the fake installers first on PATH, their log. */
export function laneEnv({ fail = false, pathFirst = [] } = {}) {
  const home = realpathSync(makeTempDir('lane-pool-home-'));
  const bin = fakeInstallers();
  const log = join(home, 'installs.jsonl');
  const env = { HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: 'lane-pool-test', FAKE_INSTALL_LOG: log, PATH: [...pathFirst, bin, process.env.PATH].join(delimiter) };
  return fail ? { ...env, FAKE_INSTALL_FAIL: '1' } : env;
}

/** Runs `git-tidy lane <args>` with `env`. */
export const lane = (args, env) => tidy(['lane', ...args], { env });

/** `lane claim` of `branch` at `base` in `repo`. */
export const claim = (repo, branch, base, env) => lane(['claim', '--repo', repo, '--branch', branch, '--base', base], env);

export const laneLines = lines;

/**
 * A folder holding fake npm, pnpm and yarn (node scripts; on Windows a .cmd shim with its JavaScript entry beside it). On POSIX it
 * is one shared read-only folder (shared-tools.mjs: no first-run check per test); the log and the failure come from the env.
 */
export function fakeInstallers() {
  const posix = {};
  const bin = process.platform === 'win32' ? realpathSync(makeTempDir('lane-pool-bin-')) : null;
  for (const [program, entry] of Object.entries(PROGRAMS)) {
    const body = [
      `const fs = require('fs');`,
      `fs.appendFileSync(process.env.FAKE_INSTALL_LOG, JSON.stringify({ program: ${JSON.stringify(program)}, args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');`,
      `if (process.env.FAKE_INSTALL_FAIL) { console.error('fake ${program} broke'); process.exit(1); }`,
      `fs.mkdirSync('node_modules', { recursive: true }); fs.writeFileSync('node_modules/installed.txt', ${JSON.stringify(program)});`,
    ].join('\n');
    if (process.platform === 'win32') {
      writeFileSync(join(bin, `${program}.cmd`), '@exit /b 9\r\n');
      mkdirSync(join(bin, 'node_modules', ...entry.slice(0, -1)), { recursive: true });
      writeFileSync(join(bin, 'node_modules', ...entry), body);
    } else posix[program] = `#!${process.execPath}\n${body}\n`;
  }
  return bin ?? realpathSync(sharedToolDir(posix));
}

/** The runs the fake installers logged: `[{ program, args, cwd }]` (cwd as a real path). */
export function installLog(env) {
  if (!existsSync(env.FAKE_INSTALL_LOG)) return [];
  return readFileSync(env.FAKE_INSTALL_LOG, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
}

/** Every file and link under `folder` as `path -> sha256` (links: their target), for a byte-for-byte before/after compare. */
export function snapshot(folder, into = new Map(), prefix = '') {
  for (const name of readdirSync(folder).sort()) {
    const path = join(folder, name);
    const stats = lstatSync(path);
    if (stats.isDirectory()) snapshot(path, into, `${prefix}${name}/`);
    else into.set(`${prefix}${name}`, stats.isSymbolicLink() ? `link ${readFileSync(path, { encoding: null }).length}` : createHash('sha256').update(readFileSync(path)).digest('hex'));
  }
  return into;
}

/** The worktree's admin folder (`.git/worktrees/<id>`). */
export const adminDir = (folder) => git(folder, 'rev-parse', '--absolute-git-dir');

/** Sets the files lastUsedMs reads (HEAD reflog, HEAD, index) to 30 hours ago. */
export function backdateUse(folder) {
  const old = new Date(Date.now() - IDLE_MS);
  for (const name of [join('logs', 'HEAD'), 'HEAD', 'index']) {
    const file = join(adminDir(folder), name);
    if (existsSync(file)) utimesSync(file, old, old);
  }
}

/** `<repo>/.claude/worktrees/lane-<n>` (real path). */
export const poolPath = (repo, number) => join(realpathSync(repo), '.claude', 'worktrees', `lane-${number}`);

/** A pid that no process has any more (a child that already exited). */
export function deadPid() {
  const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  return child.pid;
}

/** Writes `text` to `path`, making its parent folders. */
export function writeFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
