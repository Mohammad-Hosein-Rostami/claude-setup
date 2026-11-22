// The owner's check switch (spec round 9 `r9-checks-off`): tests, type checks, reviews, UI checks and probes run only in the categories the
// owner turned on for a session with `/check`. The categories and each one's default live in home/checks/categories.json (a category may
// default to "on"); the owner's `/check` turns categories on or off over those defaults. This module reads and writes that switch.
// Exports: categories(), checksDir(), parseCheckArgs(text), readChecks(sessionId), onCategories(sessionId), isOn(category, sessionId),
//   offCategories(sessionId), saveChecks(sessionId, choice, now), clearChecks(sessionId), sessionIdOf(input).
// CLI: `node checks-on.mjs is-on <category>` exits 0 when it is on for $CLAUDE_CODE_SESSION_ID, else 1 (off, also on any error);
//   `node checks-on.mjs list` prints the categories that are on, one per line (.githooks/pre-commit and the workflows' runners use these).
// File: ~/.claude/state/checks/<session-id>.json = { on: string[], off: string[], scope: string, by: "owner", at: ISO time }, written only by
//   the checks-switch hook on the owner's typed `/check` (UserPromptExpansion fires only for a typed command); the Bash guard asks for any
//   other write there.
// Invariants: fail open to the defaults: a missing, unreadable, oversized, linked or malformed switch file, or one not written `by: "owner"`,
//   counts as no switch; an unreadable categories.json means no category is known, so every check is off. Nothing throws except
//   saveChecks. Subagents and child commands carry the lead's session id (the hook input's session_id, and CLAUDE_CODE_SESSION_ID in the
//   command env), so every id is read: a category the owner turned on under any of them is on, one he turned off under any is off.
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { removeStateFile, writeStateText } from './state-files.mjs';
import { readPlainFile } from './plain-file.mjs';

const CATEGORIES_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'checks', 'categories.json');
const SESSION_ID = /^[\w-]{1,128}$/;
const CHECKS_FILE_MAX_BYTES = 4096; // a few names, a scope line and a time; a larger file is not the hook's own
const SCOPE_MAX_CHARS = 300;
let categoryDefaults; // read once per process

/** The categories as { name: "on"|"off" } from categories.json; {} when it cannot be read (every check off). */
function defaults() {
  if (categoryDefaults !== undefined) return categoryDefaults;
  try {
    const config = JSON.parse(readFileSync(CATEGORIES_FILE, 'utf8'));
    categoryDefaults = Object.fromEntries(Object.entries(config).filter(([name]) => /^[a-z]+$/.test(name)).map(([name, value]) => [name, value?.default === 'on' ? 'on' : 'off']));
  } catch (error) {
    process.stderr.write(`checks-on: cannot read ${CATEGORIES_FILE} (${error.message}); every check is off\n`);
    categoryDefaults = {};
  }
  return categoryDefaults;
}

/** The category names, in the order of categories.json. */
export const categories = () => Object.keys(defaults());

/** The folder of the switch files. */
export const checksDir = () => join(homedir(), '.claude', 'state', 'checks');

/**
 * Parses the words after `/check`: nothing (show), `default` (back to the defaults), `off` alone (every category off), `off <names>`
 * (those off), or `<names>` (those on); `all` means every category; `for <scope>` names what the change is for.
 * @param {string} text the command's arguments
 * @returns {{ action: 'show'|'default'|'set', on: string[], off: string[], scope: string, unknown: string[] }}
 */
export function parseCheckArgs(text) {
  const raw = String(text ?? '').trim();
  const forAt = raw.search(/(^|\s)for\s/i);
  const scope = forAt < 0 ? '' : raw.slice(forAt).trim().replace(/^for\s+/i, '').slice(0, SCOPE_MAX_CHARS);
  const words = (forAt < 0 ? raw : raw.slice(0, forAt)).toLowerCase().split(/[\s,]+/).filter(Boolean);
  const none = { on: [], off: [], scope: '', unknown: [] };
  if (words.length === 0) return { action: 'show', ...none };
  if (words.length === 1 && words[0] === 'default') return { action: 'default', ...none };
  const turnOff = words[0] === 'off';
  const names = turnOff ? words.slice(1) : words;
  const known = categories();
  const picked = names.length === 0 || names.includes('all') ? known : known.filter((name) => names.includes(name));
  const unknown = names.filter((word) => word !== 'all' && !known.includes(word));
  return { action: 'set', on: turnOff ? [] : picked, off: turnOff ? picked : [], scope, unknown };
}

/** The ids whose switch files count for this caller: the given one and the process's own session ids. */
function idsOf(sessionId) {
  return [...new Set([sessionId, process.env.CLAUDE_CODE_SESSION_ID, process.env.CLAUDE_SESSION_ID].filter((id) => typeof id === 'string' && SESSION_ID.test(id)))];
}

const namesIn = (list) => (Array.isArray(list) ? categories().filter((name) => list.includes(name)) : []);

/**
 * The switch saved for one session, or null (the defaults hold) when there is none or it is not a well-formed owner record.
 * @param {string | undefined} sessionId the session id
 * @returns {{ on: string[], off: string[], scope: string, by: 'owner', at: string } | null}
 */
export function readChecks(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return null;
  try {
    const record = JSON.parse(readPlainFile(join(checksDir(), `${sessionId}.json`), CHECKS_FILE_MAX_BYTES));
    if (record === null || typeof record !== 'object' || record.by !== 'owner') return null;
    return { on: namesIn(record.on), off: namesIn(record.off), scope: typeof record.scope === 'string' ? record.scope : '', by: 'owner', at: String(record.at ?? '') };
  } catch {
    return null; // missing or unreadable: the defaults, never a block
  }
}

/**
 * The categories on for this caller: each category's default, turned on or off by the owner's switch.
 * @param {string | undefined} sessionId the hook input's session_id (may be undefined in a plain command)
 * @returns {string[]} in categories.json order
 */
export function onCategories(sessionId) {
  const records = idsOf(sessionId).map(readChecks).filter(Boolean);
  const turnedOn = new Set(records.flatMap((record) => record.on));
  const turnedOff = new Set(records.flatMap((record) => record.off));
  return Object.entries(defaults()).filter(([name, value]) => !turnedOff.has(name) && (turnedOn.has(name) || value === 'on')).map(([name]) => name);
}

/**
 * Whether one category's checks run for this session; every gate asks this first and passes silently on false.
 * @param {string} category a name from categories.json
 * @param {string | undefined} sessionId the session id
 * @returns {boolean}
 */
export const isOn = (category, sessionId) => onCategories(sessionId).includes(category);

/** The categories that are off (what the final reply names after "not checked:"). */
export const offCategories = (sessionId) => {
  const on = onCategories(sessionId);
  return categories().filter((name) => !on.includes(name));
};

/**
 * Applies the owner's choice for one session over what was saved before (called only by the checks-switch hook on a typed `/check`).
 * @param {string} sessionId the session id
 * @param {{ on: string[], off: string[], scope: string }} choice what parseCheckArgs returned
 * @param {Date} [now] the time to record
 * @throws {Error} on a bad session id or a failed write
 */
export function saveChecks(sessionId, choice, now = new Date()) {
  if (!SESSION_ID.test(String(sessionId))) throw new Error('no usable session id');
  const before = readChecks(sessionId) ?? { on: [], off: [], scope: '' };
  const on = [...new Set([...before.on.filter((name) => !choice.off.includes(name)), ...choice.on])];
  const off = [...new Set([...before.off.filter((name) => !choice.on.includes(name)), ...choice.off])];
  const record = { on, off, scope: choice.scope || before.scope, by: 'owner', at: now.toISOString() };
  writeStateText(checksDir(), `${sessionId}.json`, `${JSON.stringify(record)}\n`);
}

/** Back to the defaults for one session (`/check default`); never throws. */
export function clearChecks(sessionId) {
  if (SESSION_ID.test(String(sessionId))) removeStateFile(checksDir(), `${sessionId}.json`);
}

/** The session id of a hook input, else undefined. */
export const sessionIdOf = (input) => (typeof input?.session_id === 'string' && SESSION_ID.test(input.session_id) ? input.session_id : undefined);

/** The CLI: `is-on <category>` (exit 0 on, 1 off) or `list`; anything else is off (exit 1). */
function main([command, category]) {
  if (command === 'list') {
    for (const name of onCategories(undefined)) console.log(name);
    return 0;
  }
  return command === 'is-on' && isOn(category, undefined) ? 0 : 1;
}

// Run as a command (hooks and git hooks reach it through links, so compare real paths).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
