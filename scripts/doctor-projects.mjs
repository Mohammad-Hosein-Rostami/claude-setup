#!/usr/bin/env node
// Purpose: the project checks of scripts/doctor.sh (lane r9-plugins, spec-p1-repair.md; lane doctor-proj, layering-spec.md
// section 3). For every project Claude Code has opened (the `projects` keys of its global config file that are still folders,
// plus the project doctor runs in; the home folder is left out, since its `.claude` is the personal config folder itself):
// - a plugin settings/base.json turns off but the project's personal `.claude/settings.local.json` turns on (WARN: the
//   owner turned it off; turn it off there too), and the same in the committed `.claude/settings.json` (ok: the team's
//   choice, kept and listed);
// - a project skill `.claude/skills/<name>` with the name of a personal skill `home/skills/<name>` (WARN: the personal one
//   always wins, so the project copy never loads);
// - the project-setup rows of doctor-project-overrides.mjs: settings that switch off or weaken our checks, guards and hooks,
//   a CLAUDE.local.md that still imports a project note, what could not be read, and notes no known project's key matches.
// Listed folders that are gone are one INFO row with their count; no project at all is one INFO row (F3, F5).
// Usage: node scripts/doctor-projects.mjs <global-config-json> <claude-dir> <repo> <project>
// Output: one line per finding, `ok    <text>`, `INFO  <text>` or `WARN  <text>`; doctor.sh prints them and sets its exit.
// Exports: main, projectLines, projectFolders, pluginFindings, skillFindings (for the doctor tests).
// Exit 0 when the checks ran (findings are in the lines), 1 when this script itself failed.
// Invariants: read only, no state file. Only regular files up to a size cap are read (no FIFO is opened). Every path and name
// in a line comes from a config file or a repository (untrusted text), so it is quoted, escaped and capped (shown-name.mjs).
// The project-setup rows stop after PROJECTS_BUDGET_MS; the projects left are named as not checked, never as ok.
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, win32 } from 'node:path';
import { GIT_TIMEOUT_MS, SCAN_BUDGET_MS, ourSetup } from '../home/hooks/project-merge.mjs';
import { runGit } from '../home/hooks/lib/gated-folder.mjs';
import { quotedName } from '../home/hooks/lib/shown-name.mjs';
import { line, noteRows, projectRows, shownFolder } from './doctor-project-overrides.mjs';

const GLOBAL_CONFIG_MAX_BYTES = 64 * 1024 * 1024; // Claude Code's global config holds every project's history keys
const SETTINGS_MAX_BYTES = 1024 * 1024; // a project settings file larger than this is not read (one line says so)
const LOCAL_SETTINGS = '.claude/settings.local.json';
const TEAM_SETTINGS = '.claude/settings.json';
const PROJECT_SKILLS = '.claude/skills';
const PROJECTS_BUDGET_MS = 20_000; // all project-setup rows; each project's scan has SCAN_BUDGET_MS and two git calls of GIT_TIMEOUT_MS
const GONE_SHOWN = 3; // gone folders named in their one row; the rest are counted
const PLAIN_ID = /^[\w.@-]{1,128}$/; // a plugin id shown as it is; anything else quoted
const FOLD_CASE = process.platform === 'darwin' || process.platform === 'win32'; // their file systems ignore case

const shownId = (id) => (PLAIN_ID.test(id) ? id : quotedName(id));

/** The parsed JSON of a regular file of at most `maxBytes`; `null` when missing or not a regular file. Throws on bad JSON or size. */
function readJson(path, maxBytes) {
  const info = statSync(path, { throwIfNoEntry: false });
  if (!info?.isFile()) return null;
  if (info.size > maxBytes) throw new Error(`larger than ${maxBytes} bytes, not read`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The real path of `path` when it is a folder, else `null`. */
function realFolder(path) {
  try {
    return statSync(path).isDirectory() ? realpathSync.native(path) : null;
  } catch {
    return null; // a folder that is gone or unreadable is not a project to check
  }
}

/** What a listed path is now: a folder (its real path), gone (no folder there), or unreadable (the error code). */
function folderState(path) {
  if (!posix.isAbsolute(path) && !win32.isAbsolute(path)) return { gone: true }; // the config lists full paths; anything else names no folder
  try {
    return statSync(path).isDirectory() ? { real: realpathSync.native(path) } : { gone: true };
  } catch (error) {
    return error.code === 'ENOENT' || error.code === 'ENOTDIR' ? { gone: true } : { error: error.code ?? 'unreadable' };
  }
}

/**
 * Every project folder to check: the `projects` keys of the global config that are still folders, and `current`, without the
 * folder whose `.claude` is the personal config folder (its settings and skills are the personal ones, not a project's).
 * @param {string} globalConfig path of Claude Code's global config (`~/.claude.json`)
 * @param {string} claudeDir the personal config folder (`~/.claude`)
 * @param {string} current the project doctor runs in
 * @returns {{folders: string[], gone: string[], notes: string[]}} real paths without duplicates (by case where the file system
 *   ignores it); the listed paths no folder is at; WARN lines when the config or a listed folder is unreadable
 */
export function projectFolders(globalConfig, claudeDir, current) {
  const notes = [];
  let keys = [];
  try {
    const config = readJson(globalConfig, GLOBAL_CONFIG_MAX_BYTES);
    keys = config && typeof config.projects === 'object' && config.projects ? Object.keys(config.projects) : [];
  } catch (error) {
    notes.push(line('WARN', `${shownFolder(globalConfig)}: ${quotedName(error.message)}; only the current project is checked`));
  }
  const personal = realFolder(claudeDir);
  const folders = new Map();
  const gone = [];
  for (const path of [current, ...keys]) {
    const { real, error } = folderState(path);
    if (error) notes.push(line('WARN', `${shownFolder(path)}: not checked (the folder cannot be read: ${error})`));
    else if (real === undefined) gone.push(path);
    else if (realFolder(join(real, '.claude')) !== personal) folders.set(FOLD_CASE ? real.toLowerCase() : real, real);
  }
  return { folders: [...folders.values()], gone, notes };
}

/** The plugin ids `settings` turns on (`enabledPlugins` value true). */
const enabledIn = (settings) => Object.entries(settings?.enabledPlugins ?? {}).filter(([, on]) => on === true).map(([id]) => id);

/**
 * Lines for plugins base.json turns off that a project's settings turn on.
 * @param {string} folder the project's real path
 * @param {Set<string>} offPlugins ids settings/base.json sets to false
 * @returns {string[]} WARN lines for settings.local.json, ok lines for the committed settings.json
 */
export function pluginFindings(folder, offPlugins) {
  const found = [];
  for (const [file, level, advice] of [
    [LOCAL_SETTINGS, 'WARN', 'turned off in the setup; turn it off there too (personal, git-ignored file)'],
    [TEAM_SETTINGS, 'ok', 'kept: the project commits it for its team'],
  ]) {
    const path = join(folder, file);
    let settings;
    try {
      settings = readJson(path, SETTINGS_MAX_BYTES);
    } catch (error) {
      found.push(line('WARN', `${shownFolder(path)}: ${quotedName(error.message)}`));
      continue;
    }
    for (const id of enabledIn(settings).filter((name) => offPlugins.has(name))) {
      found.push(line(level, `${shownFolder(path)} turns on ${shownId(id)}: ${advice}`));
    }
  }
  return found;
}

/** The names of the folders in `dir` (empty when it is missing). */
function folderNames(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => entry.name);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
}

/**
 * WARN lines for project skills that share a name with a personal skill (the personal one wins, the project copy never loads).
 * @param {string} folder the project's real path
 * @param {string} personalSkills the setup's skills folder (`<repo>/home/skills`)
 * @returns {string[]}
 */
export function skillFindings(folder, personalSkills) {
  const personal = new Set(folderNames(personalSkills));
  const projectDir = join(folder, PROJECT_SKILLS);
  let names;
  try {
    names = folderNames(projectDir);
  } catch (error) {
    return [line('WARN', `${shownFolder(projectDir)}: not checked for skills (it cannot be listed: ${error.code ?? 'unreadable'})`)]; // one odd project never stops doctor
  }
  return names
    .filter((name) => personal.has(name))
    .map((name) => line('WARN', `project skill ${shownFolder(join(projectDir, name))} never loads: the personal skill ${shownFolder(join(personalSkills, name))} has the same name and always wins (rename the project copy)`));
}

/** The plugin ids settings/base.json sets to false. */
function offPluginsOf(repo) {
  const base = readJson(join(repo, 'settings/base.json'), SETTINGS_MAX_BYTES);
  return new Set(Object.entries(base?.enabledPlugins ?? {}).filter(([, on]) => on === false).map(([id]) => id));
}

/** The one row for listed folders that are gone, '' when none is (F3: counted, a few named, never a crash). */
function goneRow(gone) {
  if (gone.length === 0) return '';
  const more = gone.length > GONE_SHOWN ? `, and ${gone.length - GONE_SHOWN} more` : '';
  return line('INFO', `${gone.length} projects the global config lists are missing (folder gone): not checked: ${gone.slice(0, GONE_SHOWN).map(shownFolder).join(', ')}${more}`);
}

/**
 * The project-setup rows of every folder until PROJECTS_BUDGET_MS, then one row for the rest.
 * @returns {{ rows: string[], keys: Set<string>, unreadable: Set<string> }} the rows, the key candidates seen, and the folders
 *   whose row says they were not checked (the other checks skip them, so one locked folder gives one row and no crash)
 */
function setupRows(folders, context) {
  const deadline = performance.now() + PROJECTS_BUDGET_MS;
  const rows = [];
  const keys = new Set();
  const unreadable = new Set();
  for (const [index, folder] of folders.entries()) {
    if (performance.now() > deadline) {
      rows.push(line('WARN', `${folders.length - index} projects not checked for settings that switch ours off: doctor's ${PROJECTS_BUDGET_MS / 1000} s for them used up`));
      break;
    }
    const found = projectRows(folder, context);
    rows.push(...found.rows);
    for (const key of found.keys) keys.add(key);
    if (!found.readable) unreadable.add(folder);
  }
  return { rows, keys, unreadable };
}

/**
 * Every line of the project checks.
 * @param {string[]} args the global config, the personal config folder, the setup repo and the current project
 * @returns {string[]}
 */
export function projectLines([globalConfig, claudeDir, repo, current] = []) {
  if (!globalConfig || !claudeDir || !repo || !current || !isAbsolute(claudeDir)) throw new Error('usage: doctor-projects.mjs <global-config-json> <claude-dir> <repo> <project>');
  const { folders, gone, notes } = projectFolders(globalConfig, claudeDir, current);
  const home = dirname(claudeDir); // doctor.sh: CLAUDE_DIR is $HOME/.claude
  const noteDirs = [{ dir: join(repo, 'home', 'project-notes'), label: 'home/project-notes' }, { dir: join(claudeDir, 'project-notes'), label: '~/.claude/project-notes' }];
  const git = (cwd, gitArgs) => runGit(cwd, gitArgs, GIT_TIMEOUT_MS);
  const context = { home, ours: ourSetup(home, join(repo, 'home')), git, personalSkillsDir: join(claudeDir, 'skills'), scanBudgetMs: SCAN_BUDGET_MS, noteDirs: noteDirs.map(({ dir }) => dir) };
  const setup = setupRows(folders, context);
  const readable = folders.filter((folder) => !setup.unreadable.has(folder));
  const offPlugins = offPluginsOf(repo);
  const plugins = readable.flatMap((folder) => pluginFindings(folder, offPlugins));
  const skills = readable.flatMap((folder) => skillFindings(folder, join(repo, 'home/skills')));
  const out = [...notes, goneRow(gone), ...setup.rows, ...plugins, ...skills, ...noteRows(setup.keys, noteDirs)].filter(Boolean);
  if (folders.length === 0) out.push(line('INFO', 'no known projects: the global config lists no folder that is still there, and doctor runs outside a project'));
  if (!plugins.some((text) => text.startsWith('WARN'))) out.push(line('ok', `${readable.length} projects: no ${LOCAL_SETTINGS} turns on a plugin the setup turns off`));
  if (skills.length === 0) out.push(line('ok', `${readable.length} projects: no project skill shares a name with a personal skill`));
  return out;
}

/** Prints every line of the project checks. */
export function main(args = process.argv.slice(2)) {
  process.stdout.write(`${projectLines(args).join('\n')}\n`);
}

// realpath: doctor.sh may name this file through a linked folder.
if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`doctor-projects: ${error.message}\n`);
    process.exit(1);
  }
}
