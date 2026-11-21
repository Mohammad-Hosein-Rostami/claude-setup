// Purpose: the owner's viewing conditions per project (zoom, pixel ratio, theme, data), recorded once by `ui-coverage conditions`
// and read by `check` (the RTL-locale and dark-scheme lint) and by `ui-check run` (stored in every record and the ledger), plus
// what the project has (its RTL locales and colour schemes). Exports: projectRoot, conditionsFile, readConditions, parseConditions,
// writeConditions, describeConditions.
// Invariants: one file per project under the state folder (`UI_COVERAGE_STATE_DIR`, default ~/.claude/state/ui-coverage), named by
// the project's real git top-level path; a missing file is "not recorded" (null), an unreadable one throws; the git call has a timeout.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GIT_TIMEOUT_MS = 10_000;
const NAME_HASH_CHARS = 12;
const THEMES = ['light', 'dark'];
const DIRECTIONS_RTL_EXAMPLE = 'fa,ar';
const splitList = (text) => String(text ?? '').split(',').map((part) => part.trim()).filter(Boolean);

/** The project a folder belongs to: its git top-level, else the folder itself (real paths, so a link names one project). */
export function projectRoot(dir) {
  const git = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  const top = git.status === 0 ? git.stdout.trim() : dir;
  return fs.realpathSync.native(top);
}

/** The conditions file of a project. @param {string} dir any folder in the project @param {string} [stateDir] override of the state folder */
export function conditionsFile(dir, stateDir = process.env.UI_COVERAGE_STATE_DIR ?? path.join(os.homedir(), '.claude', 'state', 'ui-coverage')) {
  const root = projectRoot(dir);
  const hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, NAME_HASH_CHARS);
  return path.join(stateDir, 'conditions', `${path.basename(root).replace(/[^A-Za-z0-9_.-]/g, '-')}-${hash}.json`);
}

/**
 * The recorded conditions of the project `dir` belongs to.
 * @returns {object|null} {project, zoom, pixelRatio, theme, data, rtlLocales, schemes, recordedAt}; null when none were recorded
 * @throws {TypeError} when the file exists but is not valid JSON
 */
export function readConditions(dir, stateDir) {
  const file = conditionsFile(dir, stateDir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new TypeError(`conditions file ${file} is not valid JSON: ${error.message}`);
  }
}

function positive(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new TypeError(`${flag} needs a positive number, got "${value ?? ''}"`);
  return number;
}

/**
 * Validate the values of `ui-coverage conditions`.
 * @param {{zoom?: string, pixelRatio?: string, theme?: string, data?: string, rtl?: string, schemes?: string}} raw flag values
 * @returns {{zoom: number, pixelRatio: number, theme: string, data: string, rtlLocales: string[], schemes: string[]}}
 * @throws {TypeError} naming the flag that is missing or wrong
 */
export function parseConditions(raw) {
  if (!THEMES.includes(raw.theme)) throw new TypeError(`--theme must be ${THEMES.join(' or ')}`);
  if (!raw.data || raw.data.trim() === '') throw new TypeError('--data needs a short text: which data the owner looks at (e.g. "staging account, 30 orders")');
  const schemes = raw.schemes === undefined ? [raw.theme] : splitList(raw.schemes);
  if (schemes.length === 0 || schemes.some((scheme) => !THEMES.includes(scheme))) throw new TypeError(`--schemes lists the project's colour schemes: ${THEMES.join(',')}`);
  return { zoom: positive(raw.zoom, '--zoom'), pixelRatio: positive(raw.pixelRatio, '--pixel-ratio'), theme: raw.theme, data: raw.data.trim(), rtlLocales: splitList(raw.rtl), schemes };
}

/** Write the conditions of the project `dir` belongs to. @returns {string} the file written */
export function writeConditions(dir, conditions, stateDir) {
  const file = conditionsFile(dir, stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ project: projectRoot(dir), ...conditions, recordedAt: new Date().toISOString() }, null, 2)}\n`);
  return file;
}

/** One line for people. */
export function describeConditions(conditions) {
  if (!conditions) return `conditions: not recorded (ui-coverage conditions --zoom 100 --pixel-ratio 2 --theme light --data "<what>" [--rtl ${DIRECTIONS_RTL_EXAMPLE}] [--schemes light,dark])`;
  const rtl = conditions.rtlLocales?.length ? `, rtl ${conditions.rtlLocales.join(',')}` : '';
  return `conditions: zoom ${conditions.zoom}%, pixel ratio ${conditions.pixelRatio}, theme ${conditions.theme}, data ${conditions.data}, schemes ${(conditions.schemes ?? []).join(',')}${rtl}`;
}
