// Shared by tests/disk-clean.test.mjs and tests/disk-clean-safety.test.mjs. Exports: DAY_MS, ids (OLD, RECENT, ...), world, ago, age, folder, transcript, sessionFile.
// Every test builds a fake world (claude tmp, projects folder, temp folder, sessions folder) inside makeTempDir and passes those roots in:
// the real folders are never read or touched. Times are set relative to `now`, so no test depends on the clock.
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './temp-dir-helpers.mjs';

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
