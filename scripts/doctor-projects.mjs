#!/usr/bin/env node
// Purpose: the project checks of scripts/doctor.sh (lane r9-plugins, spec-p1-repair.md). For every project Claude Code has
// opened (the `projects` keys of its global config file that are still folders, plus the project doctor runs in; the home
// folder is left out, since its `.claude` is the personal config folder itself):
// - a plugin settings/base.json turns off but the project's personal `.claude/settings.local.json` turns on (WARN: the
//   owner turned it off; turn it off there too), and the same in the committed `.claude/settings.json` (ok: the team's
//   choice, kept and listed);
// - a project skill `.claude/skills/<name>` with the name of a personal skill `home/skills/<name>` (WARN: the personal one
//   always wins, so the project copy never loads).
// Usage: node scripts/doctor-projects.mjs <global-config-json> <claude-dir> <repo> <project>
// Output: one line per finding, `ok    <text>` or `WARN  <text>`; doctor.sh prints them and sets its exit.
// Exports: main, projectFolders, pluginFindings, skillFindings (for the doctor tests).
// Exit 0 when the checks ran (findings are in the lines), 1 when this script itself failed.
// Invariants: read only. Only regular files up to a size cap are read (no FIFO is opened). Every path in a line comes from
// a config file or a repository (untrusted text), so it is shown through escaped() of home/hooks/lib/shown-name.mjs.
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { escaped } from '../home/hooks/lib/shown-name.mjs';

const GLOBAL_CONFIG_MAX_BYTES = 64 * 1024 * 1024; // Claude Code's global config holds every project's history keys
const SETTINGS_MAX_BYTES = 1024 * 1024; // a project settings file larger than this is not read (one line says so)
const LOCAL_SETTINGS = '.claude/settings.local.json';
const TEAM_SETTINGS = '.claude/settings.json';
const PROJECT_SKILLS = '.claude/skills';

const line = (level, text) => `${level.padEnd(6)}${text}`;

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
    return statSync(path).isDirectory() ? realpathSync(path) : null;
  } catch {
    return null; // a folder that is gone or unreadable is not a project to check
  }
}

/**
 * Every project folder to check: the `projects` keys of the global config that are still folders, and `current`, without the
 * folder whose `.claude` is the personal config folder (its settings and skills are the personal ones, not a project's).
 * @param {string} globalConfig path of Claude Code's global config (`~/.claude.json`)
 * @param {string} claudeDir the personal config folder (`~/.claude`)
 * @param {string} current the project doctor runs in
 * @returns {{folders: string[], notes: string[]}} real paths without duplicates, and WARN lines when the config is unreadable
 */
export function projectFolders(globalConfig, claudeDir, current) {
  const notes = [];
  let keys = [];
  try {
    const config = readJson(globalConfig, GLOBAL_CONFIG_MAX_BYTES);
    keys = config && typeof config.projects === 'object' && config.projects ? Object.keys(config.projects) : [];
  } catch (error) {
    notes.push(line('WARN', `${escaped(globalConfig)}: ${escaped(error.message)}; only the current project is checked`));
  }
  const personal = realFolder(claudeDir);
  const folders = new Set([current, ...keys].map(realFolder).filter((folder) => folder && realFolder(join(folder, '.claude')) !== personal));
  return { folders: [...folders], notes };
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
      found.push(line('WARN', `${escaped(path)}: ${escaped(error.message)}`));
      continue;
    }
    for (const id of enabledIn(settings).filter((name) => offPlugins.has(name))) {
      found.push(line(level, `${escaped(path)} turns on ${escaped(id)}: ${advice}`));
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
  return folderNames(projectDir)
    .filter((name) => personal.has(name))
    .map((name) => line('WARN', `project skill ${escaped(join(projectDir, name))} never loads: the personal skill ${escaped(join(personalSkills, name))} has the same name and always wins (rename the project copy)`));
}

/** The plugin ids settings/base.json sets to false. */
function offPluginsOf(repo) {
  const base = readJson(join(repo, 'settings/base.json'), SETTINGS_MAX_BYTES);
  return new Set(Object.entries(base?.enabledPlugins ?? {}).filter(([, on]) => on === false).map(([id]) => id));
}

/** Prints every finding and one summary line per check. */
export function main([globalConfig, claudeDir, repo, current] = process.argv.slice(2)) {
  if (!globalConfig || !claudeDir || !repo || !current) throw new Error('usage: doctor-projects.mjs <global-config-json> <claude-dir> <repo> <project>');
  const { folders, notes } = projectFolders(globalConfig, claudeDir, current);
  const offPlugins = offPluginsOf(repo);
  const plugins = folders.flatMap((folder) => pluginFindings(folder, offPlugins));
  const skills = folders.flatMap((folder) => skillFindings(folder, join(repo, 'home/skills')));
  const out = [...notes, ...plugins, ...skills];
  if (!plugins.some((text) => text.startsWith('WARN'))) out.push(line('ok', `${folders.length} projects: no ${LOCAL_SETTINGS} turns on a plugin the setup turns off`));
  if (skills.length === 0) out.push(line('ok', `${folders.length} projects: no project skill shares a name with a personal skill`));
  process.stdout.write(`${out.join('\n')}\n`);
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
