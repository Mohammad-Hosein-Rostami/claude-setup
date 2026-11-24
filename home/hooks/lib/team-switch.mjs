// Our skip switches (today only CLAUDE_POST_EDIT_SKIP) as a hook may honour them. A switch that a
// project's committed `.claude/settings.json` (the team file) sets and its `.claude/settings.local.json` does not is ignored: a team
// file never turns our checks off (layering-spec.md section 3; owner R22-Q3 "the stricter rule applies", R22-L4 "warn clearly").
// Exports: switchDirs(env, ...folders), trustedSwitch(env, key, dirs, platform), switchNames(env, key, dirs), noticeOnce(sessionId, key).
// Trust: only the shell environment or a project's local settings file can switch a check off. A settings.local.json that git
//   tracks (or git cannot vouch for) is a team file. The project folders are CLAUDE_PROJECT_DIR and the folders a hook knows (its
//   cwd, the git tops it checks); more folders can only ignore more switches. The home folder left out is the account's real one
//   (os.userInfo), never HOME or USERPROFILE, which a team file's env can set. On Windows env names ignore case, so team keys do too.
// Invariants: the project files are read through teamSetEnv only (bounded reads, no link followed, never waits). A team or local
//   file that cannot be read fails closed: the switch is ignored and the check runs. No project folder (none known, or only the home
//   folder, whose `.claude/settings.json` is the user's own) -> the switch is honoured as before. Nothing is written to a project;
//   noticeOnce leaves one empty marker per session and switch under the checked per-user hook temp root (lib/edit-log.mjs: a folder
//   another user could plant is refused; disk-clean's hook-state rule removes idle markers; a rollback ignores them).
import { mkdirSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { checkedTempRoot } from './edit-log.mjs';
import { envName, teamSetEnv } from './project-setup-scan.mjs';
import { escaped } from './shown-name.mjs';

const NOTICE_KIND = 'team-switch'; // under the hook temp root: one empty file per session and switch, the warning was shown
const SAFE_ID = /^[\w-]{1,128}$/;
const TEAM_FILE = '.claude/settings.json';
const LOCAL_FILE = '.claude/settings.local.json';

/** A folder as compared here: resolved, and on Windows lower-case (a drive letter or folder name in another case is the same folder). */
const folderKey = (folder) => (process.platform === 'win32' ? resolve(folder).toLowerCase() : resolve(folder));

/**
 * The user's real home folder, from the account record (os.userInfo: the password entry, on Windows the profile folder), never from
 * HOME or USERPROFILE: a team file's `env` can set those (`"USERPROFILE": "."` resolves to the hook's cwd, the project itself), and
 * os.homedir() reads HOME first. null when the account has no home or it is not an absolute path: then no folder is left out
 * (the stricter way).
 */
function realHome() {
  try {
    const home = userInfo().homedir;
    return typeof home === 'string' && isAbsolute(home) ? folderKey(home) : null;
  } catch {
    return null; // no account record (a container user without a password entry): no home folder is left out
  }
}

/**
 * The project folders whose settings decide whether a switch is trusted: CLAUDE_PROJECT_DIR, then `folders`; each absolute, once,
 * never the user's real home folder (its `.claude/settings.json` is the user's own settings file, not a team file).
 * @param {Record<string, string|undefined>} env the hook's environment (CLAUDE_PROJECT_DIR; HOME and USERPROFILE are not read)
 * @param {...(string|null|undefined)} folders other folders the hook knows (its cwd, git tops); anything not an absolute path is dropped
 * @returns {string[]} the folders, resolved
 */
export function switchDirs(env, ...folders) {
  const home = realHome();
  const seen = new Set();
  const dirs = [];
  for (const folder of [env.CLAUDE_PROJECT_DIR, ...folders]) {
    if (typeof folder !== 'string' || folder === '' || !isAbsolute(folder)) continue;
    const key = folderKey(folder);
    if (key === home || seen.has(key)) continue;
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
 * @param {string} [platform] process.platform by default: on Windows a team key in any case (`Done_Check_Skip`) is this switch
 * @returns {{ value: string|undefined, ignored: string|null }} value: the env value, or undefined when it is ignored; ignored: the
 *   one line that says why it was ignored (shown to the owner), null when it is honoured or not set
 */
export function trustedSwitch(env, key, dirs, platform = process.platform) {
  const value = env[key];
  if (value === undefined || value === '') return { value, ignored: null };
  const name = envName(key, platform);
  for (const dir of dirs) {
    const team = teamSetEnv(dir, platform);
    const where = escaped(dir);
    if (!team.readable) {
      return { value: undefined, ignored: `team switch ${key} ignored: ${where}/${TEAM_FILE} or ${LOCAL_FILE} cannot be read (a link, not a regular file, too large or not JSON), so a team file may set it; our check runs` };
    }
    if (team.trackedLocal.has(name)) {
      return { value: undefined, ignored: `team switch ${key} ignored: ${where}/${LOCAL_FILE} sets it but git tracks that file (or git could not tell), so it is a team file; our check runs (keep ${LOCAL_FILE} out of git to switch it off for yourself)` };
    }
    if (team.keys.has(name)) {
      return { value: undefined, ignored: `team switch ${key} ignored: the team file ${where}/${TEAM_FILE} sets it; our check runs (the stricter rule applies; set it in ${LOCAL_FILE} to switch it off for yourself)` };
    }
  }
  return { value, ignored: null };
}

/**
 * The comma-separated names of a trusted switch (`SOME_SKIP=types,lint` -> types, lint), trimmed; empty when it is ignored or unset.
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
