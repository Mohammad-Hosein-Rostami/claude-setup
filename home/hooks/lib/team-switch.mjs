// Our skip switches (DONE_CHECK_SKIP, CLAUDE_POST_EDIT_SKIP, CLAUDE_SKILL_ROUTER) as a hook may honour them. A switch that a
// project's committed `.claude/settings.json` (the team file) sets and its `.claude/settings.local.json` does not is ignored: a team
// file never turns our checks off (layering-spec.md section 3; owner R22-Q3 "the stricter rule applies", R22-L4 "warn clearly").
// Exports: switchDirs(env, ...folders), trustedSwitch(env, key, dirs), switchNames(env, key, dirs), noticeOnce(sessionId, key).
// Trust: only the shell environment or a project's local settings file can switch a check off. The project folders are
//   CLAUDE_PROJECT_DIR and the folders a hook knows (its cwd, the git tops it checks); more folders can only ignore more switches.
// Invariants: the project files are read through teamSetEnv only (bounded reads, no link followed, never waits). A team or local
//   file that cannot be read fails closed: the switch is ignored and the check runs. No project folder (none known, or only the home
//   folder, whose `.claude/settings.json` is the user's own) -> the switch is honoured as before. Nothing is written to a project;
//   noticeOnce leaves one empty marker per session and switch under the checked per-user hook temp root (lib/edit-log.mjs: a folder
//   another user could plant is refused; disk-clean's hook-state rule removes idle markers; a rollback ignores them).
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { checkedTempRoot } from './edit-log.mjs';
import { teamSetEnv } from './project-setup-scan.mjs';
import { escaped } from './shown-name.mjs';

const NOTICE_KIND = 'team-switch'; // under the hook temp root: one empty file per session and switch, the warning was shown
const SAFE_ID = /^[\w-]{1,128}$/;
const TEAM_FILE = '.claude/settings.json';
const LOCAL_FILE = '.claude/settings.local.json';

/** A folder as compared here: resolved, and on Windows lower-case (a drive letter or folder name in another case is the same folder). */
const folderKey = (folder) => (process.platform === 'win32' ? resolve(folder).toLowerCase() : resolve(folder));

/**
 * The project folders whose settings decide whether a switch is trusted: CLAUDE_PROJECT_DIR, then `folders`; each absolute, once,
 * never the home folder (its `.claude/settings.json` is the user's own settings file, not a team file).
 * @param {Record<string, string|undefined>} env the hook's environment (CLAUDE_PROJECT_DIR, HOME, USERPROFILE)
 * @param {...(string|null|undefined)} folders other folders the hook knows (its cwd, git tops); anything not an absolute path is dropped
 * @returns {string[]} the folders, resolved
 */
export function switchDirs(env, ...folders) {
  const homes = new Set([env.HOME, env.USERPROFILE, homedir()].filter((home) => typeof home === 'string' && home !== '').map(folderKey));
  const seen = new Set();
  const dirs = [];
  for (const folder of [env.CLAUDE_PROJECT_DIR, ...folders]) {
    if (typeof folder !== 'string' || folder === '' || !isAbsolute(folder)) continue;
    const key = folderKey(folder);
    if (homes.has(key) || seen.has(key)) continue;
    seen.add(key);
    dirs.push(resolve(folder));
  }
  return dirs;
}

/**
 * The value of one of our switches that a hook may act on.
 * @param {Record<string, string|undefined>} env the hook's environment
 * @param {string} key the switch (one of OUR_SWITCHES in project-setup-scan.mjs)
 * @param {string[]} dirs the project folders (switchDirs)
 * @returns {{ value: string|undefined, ignored: string|null }} value: the env value, or undefined when it is ignored; ignored: the
 *   one line that says why it was ignored (shown to the owner), null when it is honoured or not set
 */
export function trustedSwitch(env, key, dirs) {
  const value = env[key];
  if (value === undefined || value === '') return { value, ignored: null };
  for (const dir of dirs) {
    const team = teamSetEnv(dir);
    const where = escaped(dir);
    if (!team.readable) {
      return { value: undefined, ignored: `team switch ${key} ignored: ${where}/${TEAM_FILE} or ${LOCAL_FILE} cannot be read (a link, not a regular file, too large or not JSON), so a team file may set it; our check runs` };
    }
    if (team.keys.has(key)) {
      return { value: undefined, ignored: `team switch ${key} ignored: the team file ${where}/${TEAM_FILE} sets it; our check runs (the stricter rule applies; set it in ${LOCAL_FILE} to switch it off for yourself)` };
    }
  }
  return { value, ignored: null };
}

/**
 * The comma-separated names of a trusted switch (`DONE_CHECK_SKIP=types,lint` -> types, lint), trimmed; empty when it is ignored or unset.
 * @param {Record<string, string|undefined>} env the hook's or tool's environment
 * @param {string} key the switch
 * @param {string[]} dirs the project folders (switchDirs)
 * @returns {Set<string>}
 */
export const switchNames = (env, key, dirs) =>
  new Set((trustedSwitch(env, key, dirs).value ?? '').split(',').map((name) => name.trim()).filter(Boolean));

/**
 * True the first time a session shows the warning for `key` (an atomic create, so two hooks at once show it once). An unsafe session
 * id, a refused temp root or an unwritable temp folder -> true: the warning is shown again rather than hidden.
 * @param {unknown} sessionId the hook input's session_id
 * @param {string} key the switch
 * @returns {boolean}
 */
export function noticeOnce(sessionId, key) {
  if (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId) || !SAFE_ID.test(key)) return true;
  const root = checkedTempRoot();
  if (root === null) return true; // refused or unusable temp root: warn every time
  try {
    mkdirSync(join(root, NOTICE_KIND), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, NOTICE_KIND, `${sessionId}--${key}`), '', { flag: 'wx' });
    return true;
  } catch (error) {
    return error.code !== 'EEXIST';
  }
}
