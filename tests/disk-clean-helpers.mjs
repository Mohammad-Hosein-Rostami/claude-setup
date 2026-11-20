// Shared by tests/disk-clean*.test.mjs. Exports: DAY_MS, ids (OLD, RECENT, ...), posix, world, cliEnv, ago, age, folder, sessionFolder, transcript, sessionFile, withFakeStat.
// Every test builds a fake world (claude tmp, projects folder, temp folder, sessions folder) inside makeTempDir and passes those roots in:
// the real folders are never read or touched. A test that starts the CLI gives it cliEnv(w), so the folders the CLI takes from the
// environment are the world's too. Times are set relative to `now`, so no test depends on the clock.
import fs, { mkdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { makeTempDir } from './temp-dir-helpers.mjs';

export const posix = { skip: process.platform === 'win32' && 'needs symlinks and file modes' };
export const DAY_MS = 24 * 60 * 60 * 1000;
export const OLD = 'aaaaaaaa-0000-4000-8000-000000000001';
export const RECENT = 'bbbbbbbb-0000-4000-8000-000000000002';
export const NO_TRANSCRIPT_OLD = 'cccccccc-0000-4000-8000-000000000003';
export const NO_TRANSCRIPT_RECENT = 'dddddddd-0000-4000-8000-000000000004';
export const CURRENT = 'eeeeeeee-0000-4000-8000-000000000005';
export const NEWEST = 'ffffffff-0000-4000-8000-000000000006';
export const OTHER = '99999999-0000-4000-8000-000000000007';

/** A fake world: { claudeTmp, projects, tmp, sessions, root, home, now, options }. */
export function world() {
  const root = makeTempDir('disk-clean-');
  const dirs = { claudeTmp: join(root, 'claude-501'), projects: join(root, 'projects'), tmp: join(root, 'tmp'), sessions: join(root, 'sessions') };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const home = join(root, 'home');
  mkdirSync(home);
  const now = Date.now();
  return { ...dirs, root, home, now, options: { ...dirs, home, nowMs: now, budgetMs: 5000, apply: true, session: undefined } };
}

/**
 * The environment of a CLI run in a fake world: the home, the temp folder and the scratchpad root are the world's, never the real ones, and
 * no other config dir is set. The temp folder is the world's root, so every root of the world lies under it (a root must be under the temp folder).
 */
export const cliEnv = (w, extra = {}) => ({ ...process.env, HOME: w.home, USERPROFILE: w.home, TMPDIR: w.root, TMP: w.root, TEMP: w.root, DISK_FREE_CLAUDE_TMP: w.claudeTmp, CLAUDE_CONFIG_DIR: '', ...extra });

export const ago = (days) => new Date(Date.now() - days * DAY_MS);
export const age = (path, days) => utimesSync(path, ago(days), ago(days));

/** A folder with files in it, everything set `days` old. */
export function folder(path, { days = 0, files = { 'f.txt': 'data' } } = {}) {
  mkdirSync(path, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(path, name), text);
    age(join(path, name), days);
  }
  age(path, days);
  return path;
}

/** A transcript file ~/.claude/projects/<slug>/<id>.jsonl that is `days` old. */
export function transcript(w, slug, id, days) {
  mkdirSync(join(w.projects, slug), { recursive: true });
  const file = join(w.projects, slug, `${id}.jsonl`);
  writeFileSync(file, '{}\n');
  age(file, days);
  return file;
}

/** A ~/.claude/sessions/<pid>.json file for a running (or not) session. */
export function sessionFile(w, pid, sessionId) {
  writeFileSync(join(w.sessions, `${pid}.json`), JSON.stringify({ pid, sessionId }));
}

/** A session scratchpad folder <claudeTmp>/-proj/<id>/ with files `days` old. */
export const sessionFolder = (w, id, days) => folder(join(w.claudeTmp, '-proj', id), { days });

/**
 * Runs `action` while fs.lstatSync reports `fields` (for example { uid: 0 } or { dev: 7 }) for the folder at `path`: the only way to test other
 * owners and other file systems with one user. The stub is seen by the tool's own imports through syncBuiltinESMExports.
 */
export async function withFakeStat(path, fields, action) {
  const real = fs.lstatSync;
  const targets = [resolve(path), realpathSync(path)]; // the tool lstats the real path, a caller may pass one through a link like /var
  fs.lstatSync = function fakeLstat(item, ...rest) {
    const info = real.call(this, item, ...rest);
    return info && targets.includes(resolve(String(item))) ? Object.assign(Object.create(Object.getPrototypeOf(info)), info, fields) : info;
  };
  syncBuiltinESMExports();
  try {
    return await action();
  } finally {
    fs.lstatSync = real;
    syncBuiltinESMExports();
  }
}
