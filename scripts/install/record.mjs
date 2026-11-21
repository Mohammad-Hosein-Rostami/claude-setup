// Purpose: the install record, ~/.claude/.claude-setup-install.json: what this installer made, what it moved aside, and where
//   the links point. A second run reads it to change nothing; --uninstall reads it to undo exactly that and no more.
// Exports: RECORD_NAME, recordPath, loadRecord, saveRecord, remember, isMade, backup, ensureDir.
// Invariants: the record is written only when its content changes (a second identical run leaves it as it is); a file the
//   installer did not make is never removed, only moved into the backup folder (~/.claude-backup-<stamp>/) and named here.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { InstallError, act, note, samePath } from './context.mjs';

export const RECORD_NAME = '.claude-setup-install.json';
const RECORD_VERSION = 1;

/** Where the record of this context's install lives. */
export const recordPath = (ctx) => join(ctx.claudeDir, RECORD_NAME);

/**
 * The record of an earlier run, or a fresh one (`fresh: true`, never saved with that key).
 * @param {object} ctx the run context
 * @returns {{version: number, fresh: boolean, repo: string, root: string, tag: string|null, firstLayer: string|null, made: object[], backups: object[]}}
 * @throws {InstallError} when the file is not a record this installer wrote
 */
export function loadRecord(ctx) {
  const path = recordPath(ctx);
  if (!existsSync(path)) return { version: RECORD_VERSION, fresh: true, repo: ctx.repo, root: ctx.repo, tag: null, firstLayer: null, made: [], backups: [] };
  let record;
  try {
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new InstallError(`${path} is not valid JSON (${error.message}); move it away and run again`);
  }
  if (record?.version !== RECORD_VERSION || !Array.isArray(record.made) || !Array.isArray(record.backups)) {
    throw new InstallError(`${path} is not an install record this installer knows; move it away and run again`);
  }
  return { ...record, fresh: false };
}

/** Writes the record when it changed; nothing under --dry-run. */
export function saveRecord(ctx, record) {
  if (ctx.dryRun || !existsSync(ctx.claudeDir)) return;
  const { fresh, ...kept } = record;
  const text = `${JSON.stringify(kept, null, 2)}\n`;
  const path = recordPath(ctx);
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return;
  writeFileSync(path, text);
}

/** Adds one made thing ({kind, path, ...}) to the record once; a later entry for the same kind and path replaces it. */
export function remember(record, entry) {
  const index = record.made.findIndex((made) => made.kind === entry.kind && samePath(made.path, entry.path));
  if (index === -1) record.made.push(entry);
  else record.made[index] = { ...record.made[index], ...entry };
}

/** The record's entry for `path` (any kind but a line or a folder), or undefined. */
export function isMade(record, path) {
  return record.made.find((made) => !['line', 'dir'].includes(made.kind) && samePath(made.path, path));
}

/** `path`, or `path.1`, `path.2`, ... when taken: two runs in one second share a backup folder, and a backup never overwrites one. */
function freePath(path) {
  let candidate = path;
  for (let count = 1; existsSync(candidate); count += 1) candidate = `${path}.${count}`;
  return candidate;
}

/**
 * Moves `target` into the backup folder and records it, so --uninstall can put it back. A target the installer made itself
 * (its own earlier output) is recorded as `ours`: --uninstall deletes that copy instead of restoring it.
 * @param {object} ctx the run context
 * @param {object} record the install record
 * @param {string} target the file or folder to move aside
 * @returns {string} where it went
 */
export function backup(ctx, record, target) {
  const inHome = relative(ctx.home, target);
  const name = inHome.startsWith('..') || isAbsolute(inHome) ? join('outside-home', basename(target)) : inHome;
  const saved = freePath(join(ctx.backupDir, name));
  const ours = Boolean(isMade(record, target));
  act(ctx, `move ${target} to ${saved}`, () => {
    mkdirSync(dirname(saved), { recursive: true });
    renameSync(target, saved);
    record.backups.push({ path: target, backup: saved, backupRoot: ctx.backupDir, ours });
    note(ctx, `backed up ${basename(target)} -> ${ctx.backupDir}`);
  });
  return saved;
}

/** Makes a folder and each missing parent, recording each one it made (--uninstall removes them when empty). */
export function ensureDir(ctx, record, dir) {
  if (existsSync(dir)) return;
  ensureDir(ctx, record, dirname(dir));
  act(ctx, `make folder ${dir}`, () => {
    mkdirSync(dir);
    remember(record, { kind: 'dir', path: dir });
  });
}
