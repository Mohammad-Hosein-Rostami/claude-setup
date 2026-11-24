// The `env` blocks of Claude Code's settings files, as a hook can read them.
// Why: Claude Code writes each settings `env` entry into its own environment, over the value the shell gave it ("the settings file
// value applies in most sessions", https://code.claude.com/docs/en/env-vars, Precedence), and applies a saved file to a running
// session. A hook inherits only the environment the claude process started with, so a value set only in a settings file, or saved
// after the start, never reaches the hook's process.env.
// Files: the user file ($CLAUDE_CONFIG_DIR/settings.json, else HOME or USERPROFILE + /.claude/settings.json; no home: none) and the
// project files `.claude/settings.json` and `.claude/settings.local.json`, whose `env` Claude Code applies too (settings precedence:
// local over shared project over user, https://code.claude.com/docs/en/settings, "Settings precedence"). Claude Code reads the shared
// file from the session's primary working directory and the local file from the git root, in a worktree the main checkout's root
// (same page, "Where Claude Code keeps the local file"); after a `/cd` it reads them from the new folder.
// Exports: envValue(name, env) -> the hook's value, else the user file's (the CLAUDE_GUARD_ASK switch, lib/timed-ask.mjs);
//   possibleEnvs(env, cwd) -> {envs, unreadableFile}, unreadableCause(file) -> why, and mixedEnvs(envs, names) -> envs (the no-Fable
//   gate, lib/agent-model-gates.mjs).
// Invariants: envValue never throws; possibleEnvs throws only when a folder on the way to a git root cannot be looked at (lib/agent-brief.mjs
// nearestGitEntry), and the gate's entry then denies the call; each file is read at most once per hook run (one hook run is one node process), never waits on a FIFO
// (lib/plain-file.mjs) and at most MAX_SETTINGS_BYTES; a missing file is no settings, and so is an empty or blank one (Claude Code
// loads it as `{}`); a leading UTF-8 BOM is dropped before parsing; a file that exists but cannot be read or is not a settings object
// is "unreadable", which envValue treats as unset and possibleEnvs reports, so the gate can fail closed; its cause names at most a variable,
// never a value or other text of the file (an `env` may hold a secret).
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { gitDirOf, nearestGitEntry, sharedGitDir } from './agent-brief.mjs';
import { readPlainFile } from './plain-file.mjs';

const CONFIG_FOLDER = '.claude';
const USER_SETTINGS = 'settings.json';
const SHARED_SETTINGS = '.claude/settings.json';
const LOCAL_SETTINGS = '.claude/settings.local.json'; // wins over the shared file
const GIT_FOLDER = '.git';
const MAX_SETTINGS_BYTES = 1024 * 1024; // our merged user file is about 8 KiB; a real settings file is a few KiB
const PLAIN_VALUE_TYPES = ['string', 'number', 'boolean']; // env values Claude Code can write as text
const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR']); // no such file: no settings, not an unreadable one
const UTF8_BOM = /^\uFEFF/; // an editor may save one; JSON.parse rejects it
const JSON_PLACE = /at position \d+(?: \(line \d+ column \d+\))?/; // where V8 found the error; the rest of its text quotes the file
const NO_SETTINGS = { values: {} };
const readByFile = new Map(); // settings path -> what readSettingsEnv gave: one read per hook run

/** A settings key as Claude Code matches it: on Windows env names ignore case (as lib/project-setup-scan.mjs envName). */
const envKey = (key) => (process.platform === 'win32' ? key.toUpperCase() : key);

/** @returns {boolean} whether value is a plain JSON object (not null, not an array) */
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @returns {{unreadable: true, cause: string}} the read of a file that exists but gives no settings, and why */
const unreadable = (cause) => ({ unreadable: true, cause });

/** @returns {string} why the text is not JSON, with V8's place of the error but none of the file's text */
function syntaxCause(error) {
  const place = JSON_PLACE.exec(String(error?.message));
  return place ? `it is not valid JSON (${place[0]})` : 'it is not valid JSON';
}

/**
 * The `env` block of one settings file, with its values as text (Claude Code copies them into the environment as written).
 * @param {string} file the settings file
 * @returns {{values: Record<string, string>} | {unreadable: true, cause: string}} no file, an empty or blank one give empty values; a
 *   file that cannot be read, is not JSON, is not an object, or has an `env` that is not an object of plain values is unreadable
 */
function readSettingsEnv(file) {
  let text;
  try {
    text = readPlainFile(realpathSync(file), MAX_SETTINGS_BYTES).replace(UTF8_BOM, '');
  } catch (error) {
    return MISSING_CODES.has(error?.code) ? NO_SETTINGS : unreadable(String(error?.message)); // a link loop, a FIFO, a folder, too big
  }
  if (text.trim() === '') return NO_SETTINGS; // Claude Code loads an empty file as `{}`
  let settings;
  try {
    settings = JSON.parse(text);
  } catch (error) {
    return unreadable(syntaxCause(error));
  }
  if (!isPlainObject(settings)) return unreadable('it is not a JSON object');
  if (settings.env === undefined) return NO_SETTINGS;
  if (!isPlainObject(settings.env)) return unreadable('its `env` is not an object');
  const values = {};
  for (const [key, value] of Object.entries(settings.env)) {
    if (!PLAIN_VALUE_TYPES.includes(typeof value)) return unreadable(`its \`env\` value ${key} is not text, a number or true/false`);
    values[envKey(key)] = String(value);
  }
  return { values };
}

/** readSettingsEnv, read once per hook run. */
function settingsEnvOf(file) {
  if (!readByFile.has(file)) readByFile.set(file, readSettingsEnv(file));
  return readByFile.get(file);
}

/** @returns {string | undefined} the user settings file, or undefined with no config dir and no home folder (never the real file of a test) */
function userSettingsFile(env) {
  const home = env.HOME || env.USERPROFILE;
  const configDir = env.CLAUDE_CONFIG_DIR || (home ? join(home, CONFIG_FOLDER) : undefined);
  return configDir ? join(configDir, USER_SETTINGS) : undefined;
}

/**
 * A variable as the session may have it: the hook's own env when it sets the name at all, else the user settings file's `env`.
 * Only the user file: a switch that relaxes a check (CLAUDE_GUARD_ASK) must not come from a repository's own settings file.
 * @param {string} name the variable
 * @param {Record<string, string | undefined>} env the hook's environment (CLAUDE_CONFIG_DIR, HOME / USERPROFILE)
 * @returns {string | undefined} the value; undefined when neither sets it, or the file cannot be read
 */
export function envValue(name, env = process.env) {
  if (env[name] !== undefined) return env[name];
  const file = userSettingsFile(env);
  const read = file ? settingsEnvOf(file) : NO_SETTINGS;
  return read.unreadable ? undefined : read.values[envKey(name)];
}

/**
 * The project settings files of a session started in `start`, lowest first: the shared file of the start folder, then the local file
 * of the start folder (where Claude Code before v2.1.211 kept it), of its git root and, for a linked worktree, of the main checkout's
 * root (the root's value wins over the start folder's, as the docs say).
 * @param {string} start an absolute folder
 * @returns {string[]} the files, each once
 */
function projectSettingsFiles(start) {
  const found = nearestGitEntry(start);
  const gitDir = found ? gitDirOf(found.top, found.entry) : undefined;
  const common = gitDir ? sharedGitDir(gitDir) : undefined;
  const mainCheckout = common && basename(common) === GIT_FOLDER ? dirname(common) : found?.top;
  const roots = [start, found?.top, mainCheckout].filter(Boolean);
  return [...new Set([join(start, SHARED_SETTINGS), ...roots.map((root) => join(root, LOCAL_SETTINGS))])];
}

/** The `env` of `files` layered in order (a later file wins), or the first file that exists but cannot be read. */
function layeredSettingsEnv(files) {
  const values = {};
  for (const file of files) {
    const read = settingsEnvOf(file);
    if (read.unreadable) return { unreadableFile: file };
    Object.assign(values, read.values);
  }
  return { values };
}

/**
 * Each environment the session may really run with, for a gate that must hold under every one: the hook's own env, and for each
 * folder the session may have started in (CLAUDE_PROJECT_DIR, the hook input's cwd after a `/cd`) the hook's env with the `env` of
 * the user file, the shared file and the local files over it, as Claude Code layers them. The hook's own env counts too: the docs
 * say the settings value applies "in most sessions", and a value removed from a file stays in a running session.
 * @param {Record<string, string | undefined>} env the hook's environment (CLAUDE_CONFIG_DIR, HOME / USERPROFILE, CLAUDE_PROJECT_DIR)
 * @param {unknown} cwd the hook input's cwd (used when it is text)
 * @returns {{envs: Record<string, string | undefined>[], unreadableFile: string | null}} the hook's env first, then one env per start
 *   folder whose files set a variable; unreadableFile is the first settings file that exists but cannot be read (what it sets is
 *   unknown), and then envs holds the hook's env alone
 */
export function possibleEnvs(env, cwd) {
  const starts = [env.CLAUDE_PROJECT_DIR, cwd].filter((folder) => typeof folder === 'string' && folder !== '').map((folder) => resolve(folder));
  const userFiles = [userSettingsFile(env)].filter(Boolean);
  const stacks = starts.length === 0 ? [userFiles] : starts.map((start) => [...userFiles, ...projectSettingsFiles(start)]);
  const envs = [env];
  for (const stack of stacks) {
    const layered = layeredSettingsEnv(stack);
    if (layered.unreadableFile) return { envs: [env], unreadableFile: layered.unreadableFile };
    if (Object.keys(layered.values).length > 0) envs.push({ ...env, ...layered.values });
  }
  return { envs, unreadableFile: null };
}

/**
 * Why a settings file that possibleEnvs named as unreadable cannot be used (read once per hook run, like possibleEnvs's read).
 * @param {string} file the file possibleEnvs gave as unreadableFile
 * @returns {string} the cause (at most a variable name, never a value); '' when the file is readable or missing
 */
export function unreadableCause(file) {
  return settingsEnvOf(file).cause ?? '';
}

/**
 * The envs with each of `names` also taken from any other env: Claude Code applies each settings variable on its own, so the shell
 * may win for one variable while a settings file supplies another (CLAUDE_CODE_SUBAGENT_MODEL_FORCE from a file, the model from the
 * shell). Only values some env sets are mixed in; each env keeps its own value as one choice too.
 * @param {Record<string, string | undefined>[]} envs from possibleEnvs
 * @param {string[]} names the variables a gate reads together
 * @returns {Record<string, string | undefined>[]} each env, followed by its copies with those variables set to the other values
 */
export function mixedEnvs(envs, names) {
  let mixed = envs;
  for (const name of names) {
    const values = [...new Set(envs.map((env) => env[name]).filter((value) => value !== undefined))];
    mixed = mixed.flatMap((env) => [env, ...values.filter((value) => value !== env[name]).map((value) => ({ ...env, [name]: value }))]);
  }
  return mixed;
}
