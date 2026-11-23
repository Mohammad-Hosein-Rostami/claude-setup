// Purpose: the project-setup rows of scripts/doctor-projects.mjs (home/CLAUDE.md "Project AI setups": a project file never
// switches ours off, and "the note and doctor name one that tries"). Per project: settings that turn our hooks off, hide our
// CLAUDE.md, set one of our check switches, force or weaken the model or effort, or replace ours; a CLAUDE.local.md that still
// imports a project note; anything that could not be read. Over all projects: notes whose key no known project has.
// Exports: line, shownFolder, projectRows(folder, context), noteRows(knownKeys, noteDirs).
// Reuse (C2, P2): what a project brings comes from scanProjectSetup, the folder the session-start note reads it from from
// repoIdentity, team-set switches from teamSetEnv, notes from findNotes: the readers of the project-merge note, no second
// parser of project settings here.
// Trust (P5, P14): every key, value, name and path is repository or config text. A value is printed only when the scan kept it
// (its SHOWN_VALUE_KEYS allowlist; else it is null), always quoted and capped by shown-name.mjs. Nothing from a project runs;
// git runs hardened (gated-folder.mjs runGit, through the `git` the caller passes).
// Fail closed (P3): a project folder or `.claude` folder that cannot be listed, and every part the scan names as not checked, is
// a WARN "not checked", never an ok row.
// Invariants: read-only, no state file, so doctor may run while a session starts (F2); one odd project gives its own rows and
// never throws.
import { lstatSync, opendirSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { findNotes, repoIdentity } from '../home/hooks/lib/project-note-key.mjs';
import { envName, scanProjectSetup, teamSetEnv } from '../home/hooks/lib/project-setup-scan.mjs';
import { escapedEnd, quotedName, shownName } from '../home/hooks/lib/shown-name.mjs';

const FOLDER_SHOWN_CHARS = 160; // a project path is cut from the left past this: its end names the project
const NOT_CHECKED_SHOWN = 5; // parts of one project named in its "not checked" row; the rest are counted
const IMPORTS_SHOWN = 3; // CLAUDE.local.md note imports named per project
const NOTE_ROWS_MAX = 20; // unmatched notes named one row each; the rest in one row
const NOTE_FILE = /\.md$/i;
const NOTES_README = 'readme.md';
const PLAIN_KEY = /^[\w.-]{1,64}$/; // a settings or env key shown as it is; anything else quoted
// Doctor FAILs on these in our own settings (scripts/doctor/checks-setup.sh EFFORT_OVERRIDES): they override the model or
// effort every agent picks, agent frontmatter included.
const EFFORT_OVERRIDES = ['CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL', 'CLAUDE_CODE_EFFORT_LEVEL'];

/** One doctor row: the level padded to doctor.sh's six columns, then the text. */
export const line = (level, text) => `${level.padEnd(6)}${text}`;

/** A folder path from a config file or a project, quoted, escaped to printable ASCII and cut from the left (F4). */
export const shownFolder = (path) => `"${escapedEnd(path, FOLDER_SHOWN_CHARS)}"`;

const shownKey = (key) => (PLAIN_KEY.test(key) ? key : quotedName(key));
const shownValue = (value) => (value === null ? '' : ` ${quotedName(value)}`);

/** The error code when `dir` cannot be listed, '' when it can (a folder that is gone is the caller's case). */
function listError(dir) {
  try {
    opendirSync(dir).closeSync();
    return '';
  } catch (error) {
    return error.code ?? 'unreadable';
  }
}

/**
 * Why the project files cannot be read, '' when they can: the scan tells a folder it cannot list from one with nothing in it, so
 * this is asked first (F7). Each of `folders` and its `.claude` folder (when there is one) must be listable.
 * @param {string[]} folders the project root and the folder doctor checks
 * @returns {string}
 */
function unreadable(folders) {
  for (const dir of new Set(folders)) {
    const own = listError(dir);
    if (own) return `${shownFolder(dir)} cannot be listed (${own})`;
    let claude;
    try {
      claude = lstatSync(join(dir, '.claude'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      return `${shownFolder(join(dir, '.claude'))} cannot be read (${error.code ?? 'unreadable'})`;
    }
    const inner = claude.isDirectory() ? listError(join(dir, '.claude')) : '';
    if (inner) return `${shownFolder(join(dir, '.claude'))} cannot be listed (${inner})`;
  }
  return '';
}

/** Whether a team file sets the switch `key` (so team-switch.mjs ignores it): the root's or the checked folder's files. */
const teamSets = (key, folders) => [...new Set(folders)].some((dir) => {
  const team = teamSetEnv(dir);
  return !team.readable || team.keys.has(envName(key));
});

/**
 * The row for one setting the scan found that changes ours.
 * @param {{ key: string, value: string|null, effect: string }} item one of the scan's overrides
 * @param {string[]} folders the project root and the checked folder (for team-set switches)
 * @returns {string}
 */
function overrideRow({ key, value, effect }, folders) {
  const setting = `${shownKey(key)}${shownValue(value)}`;
  if (EFFORT_OVERRIDES.includes(envName(key))) return line('WARN', `${setting} overrides the model or effort every agent picks there, agent frontmatter included; remove it`);
  switch (effect) {
    case 'hooks-off': return line('WARN', `${setting} turns all hooks and the status line off there, our guards and checks included; remove it`);
    case 'hides-our-rules': return line('WARN', `${setting} hides our rules there (it may leave out ~/.claude/CLAUDE.md or our rules files); narrow it`);
    case 'our-switch': return teamSets(key, folders)
      ? line('INFO', `${setting} set by a team file: ignored, stricter applies (our check runs)`)
      : line('WARN', `${setting} set in your own untracked .claude/settings.local.json: our check is off there; remove it to turn it back on`);
    case 'weaker-model': return line('WARN', `${setting} is weaker than ours: Claude Code uses it there, though our rule says the stronger applies`);
    case 'permission-mode': return line('INFO', `${setting}: the project sets the permission mode there`);
    case 'replaces-ours': return line('INFO', `${setting} replaces ours there`);
    default: return line('WARN', `${setting}: an effect doctor does not know (${quotedName(String(effect))}); check it by hand`);
  }
}

/** The rows for each CLAUDE.local.md project-note import: automatic now when it names this project's note, else said why not. */
function importRows(setup, identity, noteDirs) {
  const found = new Set(findNotes(identity.keys, noteDirs).map(({ key }) => key));
  return setup.localNoteImports.slice(0, IMPORTS_SHOWN).map(({ dir, path }) => {
    const where = `${shownFolder(join(dir, 'CLAUDE.local.md'))} imports ${quotedName(path)}`;
    return found.has(basename(path).replace(NOTE_FILE, ''))
      ? line('INFO', `${where}: now automatic; you may delete it (doctor never edits the file)`)
      : line('INFO', `${where}, which is not this project's note (keys: ${identity.keys.join(', ') || 'none'}): it loads only through that import`);
  });
}

/** The "not checked" row of a scan, '' when it read everything. The parts are the scan's own words (paths already shown). */
function notCheckedRow(setup) {
  const parts = setup.notChecked;
  if (parts.length === 0) return '';
  const more = parts.length > NOT_CHECKED_SHOWN ? `, and ${parts.length - NOT_CHECKED_SHOWN} more` : '';
  return line('WARN', `not checked: ${parts.slice(0, NOT_CHECKED_SHOWN).join(', ')}${more}`);
}

/**
 * The rows of one project folder, each naming the folder, and its note key candidates.
 * @param {string} folder the folder's real path (a project the global config lists, or the current one)
 * @param {{ home: string, ours: object, git: Function, personalSkillsDir: string, scanBudgetMs: number, noteDirs: string[] }} context
 *   the home folder, our settings (project-merge.mjs ourSetup), the hardened git runner, our skills folder, the scan's time, the notes folders
 * @returns {{ rows: string[], keys: string[], readable: boolean }} rows: at least one (an ok row when nothing is found); none for
 *   a folder at or above home; readable false when its row says the folder was not checked (no other check reads it then)
 */
export function projectRows(folder, { home, ours, git, personalSkillsDir, scanBudgetMs, noteDirs }) {
  const named = (row) => `${row.slice(0, 6)}${shownFolder(folder)}: ${row.slice(6)}`;
  const identity = repoIdentity(folder, { git, home });
  if (identity.reason === 'home') return { rows: [], keys: [], readable: true };
  if (identity.reason === 'network') return { rows: [named(line('WARN', 'not checked: a network path is not followed'))], keys: [], readable: false };
  const top = identity.top ?? folder; // git failed: the folder's own files are still read
  const folders = [top, folder];
  const why = unreadable(folders);
  if (why) return { rows: [named(line('WARN', `not checked: ${why}`))], keys: identity.keys, readable: false };
  const setup = scanProjectSetup(top, folder, { personalSkillsDir, budgetMs: scanBudgetMs, ours });
  const rows = [
    ...(identity.reason === 'git-failed' ? [line('WARN', 'repo key not checked (git is missing, timed out or failed here): its note is not matched')] : []),
    ...setup.overrides.map((item) => overrideRow(item, folders)),
    ...importRows(setup, identity, noteDirs),
    notCheckedRow(setup),
  ].filter(Boolean);
  if (rows.length === 0) rows.push(line('ok', 'no project setting switches off or weakens ours'));
  return { rows: rows.map(named), keys: identity.keys, readable: true };
}

/** The `.md` notes of one notes folder, README left out; null when the folder is there but cannot be listed. */
function noteNames(dir) {
  try {
    return readdirSync(dir).filter((name) => NOTE_FILE.test(name) && name.toLowerCase() !== NOTES_README);
  } catch (error) {
    return error.code === 'ENOENT' || error.code === 'ENOTDIR' ? [] : null;
  }
}

/**
 * INFO rows for notes no known project's key matches (they load nowhere), and a WARN for a notes folder that cannot be listed.
 * @param {Set<string>} knownKeys every key candidate of the projects checked
 * @param {{ dir: string, label: string }[]} noteDirs the notes folders (shared, then personal) and how a row names each
 * @returns {string[]}
 */
export function noteRows(knownKeys, noteDirs) {
  const rows = [];
  const seen = new Set();
  const unmatched = [];
  for (const { dir, label } of noteDirs) {
    let real;
    try {
      real = realpathSync(dir);
    } catch {
      continue; // no notes folder: no notes to match
    }
    if (seen.has(real)) continue;
    seen.add(real);
    const names = noteNames(real);
    if (names === null) rows.push(line('WARN', `project notes in ${label} not checked: the folder cannot be listed`));
    for (const name of names ?? []) if (!knownKeys.has(name.replace(NOTE_FILE, ''))) unmatched.push(`${label}/${shownName(name)}`);
  }
  for (const note of unmatched.slice(0, NOTE_ROWS_MAX)) {
    rows.push(line('INFO', `project note ${note}: no project known on this machine has its key, so it loads in none of them (if it is meant for one, rename it to the key that project's session-start note shows)`));
  }
  if (unmatched.length > NOTE_ROWS_MAX) rows.push(line('INFO', `${unmatched.length - NOTE_ROWS_MAX} more project notes match no project known on this machine`));
  return rows;
}
