// Purpose: ~/.claude/settings.json, merged from the layers: the machine's own settings.json from before the first install
//   (the first layer, on a new machine only), settings/base.json, settings/<os>.json, then the git-ignored settings/local.json.
// Exports: buildSettings, mergedSettings, isNewMachine.
// Invariants: the merge is scripts/merge-settings.jq, the same program doctor.sh rebuilds the expected file with; an
//   unchanged result writes nothing; a changed file is moved to the backup folder before the new one is written.
import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { InstallError, act, note, samePath } from './context.mjs';
import { backup, remember } from './record.mjs';

const JQ_HINT = { macos: 'brew install jq', linux: 'apt install jq (or your package manager)', windows: 'winget install jqlang.jq' };
const settingsPath = (ctx) => join(ctx.claudeDir, 'settings.json');

/**
 * True on a machine this setup was never installed on: no record, a settings.json of its own, and ~/.claude/CLAUDE.md not a
 * link into this repo (an install before the record left that link). Read before the links are made.
 */
export function isNewMachine(ctx, record) {
  if (!record.fresh || !existsSync(settingsPath(ctx))) return false;
  const claudeMd = join(ctx.claudeDir, 'CLAUDE.md');
  try {
    if (!lstatSync(claudeMd).isSymbolicLink()) return true;
    return !samePath(resolve(dirname(claudeMd), readlinkSync(claudeMd)), join(ctx.repo, 'home', 'CLAUDE.md'));
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

/**
 * The merged settings object, `{{CLAUDE_HOME}}` replaced by ~/.claude with forward slashes (a Windows path too).
 * @param {object} ctx the run context (root: base and OS layers; repo: the git-ignored local.json)
 * @param {string|null} firstLayer the machine's own settings from before the first install, or null
 * @returns {object} the settings
 * @throws {InstallError} when jq is missing or a layer is not valid JSON
 */
export function mergedSettings(ctx, firstLayer) {
  const osLayer = join(ctx.root, 'settings', `${ctx.os}.json`);
  const local = join(ctx.repo, 'settings', 'local.json');
  const files = [firstLayer, join(ctx.root, 'settings', 'base.json'), osLayer, local].filter((file) => file && existsSync(file));
  const run = spawnSync('jq', ['-s', '-f', join(ctx.root, 'scripts', 'merge-settings.jq'), ...files], { encoding: 'utf8' });
  if (run.error?.code === 'ENOENT') throw new InstallError(`jq is not installed (${JQ_HINT[ctx.os]})`);
  if (run.status !== 0) throw new InstallError(`jq could not merge ${files.join(', ')}: ${(run.stderr || '').trim()}`);
  return JSON.parse(run.stdout.replaceAll('{{CLAUDE_HOME}}', ctx.claudeDir.replaceAll('\\', '/')));
}

/** Key order does not count: the same settings with keys in another order are the same file. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function readSettings(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined; // not JSON: it differs from anything, so it is backed up and replaced
  }
}

/**
 * Writes ~/.claude/settings.json. On a new machine (ctx.newMachine) the existing file is backed up and kept as the first layer.
 * @param {object} ctx the run context
 * @param {object} record the install record (firstLayer is read and set here)
 */
export function buildSettings(ctx, record) {
  const out = settingsPath(ctx);
  if (ctx.newMachine && !record.firstLayer) {
    if (readSettings(out) === undefined) throw new InstallError(`${out} is not valid JSON, so it cannot be kept as the first layer; fix or move it`);
    const saved = backup(ctx, record, out);
    record.firstLayer = ctx.dryRun ? out : saved;
    note(ctx, `kept the machine's own settings.json as the first layer (${record.firstLayer})`);
  }
  const merged = mergedSettings(ctx, record.firstLayer);
  const current = readSettings(out);
  if (current && JSON.stringify(canonical(current)) === JSON.stringify(canonical(merged))) {
    remember(record, { kind: 'file', path: out });
    note(ctx, 'ok settings.json');
    return;
  }
  if (current !== null && existsSync(out)) backup(ctx, record, out);
  act(ctx, `write ${out}`, () => {
    writeFileSync(out, `${JSON.stringify(merged, null, 2)}\n`);
    remember(record, { kind: 'file', path: out });
    note(ctx, `wrote settings.json${record.firstLayer ? ' (first layer kept)' : ''}`);
  });
}
