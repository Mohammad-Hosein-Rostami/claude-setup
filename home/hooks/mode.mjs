// Setup-mode hook (normal | medium | high). One script, dispatches on `hook_event_name`:
//   SessionStart         -> prints the active mode and its playbook; on startup/resume also syncs fast mode;
//                           prunes stale state files.
//   UserPromptExpansion  -> for `/mode <m>`: records the mode for this session, syncs fast mode, prints playbook.
//   UserPromptSubmit     -> one reminder line when the active mode is not medium.
// Fast mode: mode high wants `fastMode: true` in ~/.claude/settings.json (hot-reloaded; the key `/fast` writes,
// machine-wide, last writer wins); other modes remove the key. Writes are atomic (temp file + rename).
// Stdout of these events is added to the model context. Invariants: never blocks (always exit 0); unreadable
// input or an unsafe session_id produce no output. Active mode = state file -> env CLAUDE_MODE -> medium.
// Exports pure helpers for tests.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const MODES = ['normal', 'medium', 'high'];
export const DEFAULT_MODE = 'medium';
const SESSION_ID_PATTERN = /^[\w-]+$/;
const STATE_MAX_AGE_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const FAST_MODE_MODE = 'high';
const JSON_INDENT = 2;
const USAGE = 'Usage: /mode normal|medium|high';

const modesDir = () => join(homedir(), '.claude', 'modes');
const settingsPath = () => join(homedir(), '.claude', 'settings.json');
const stateDir = () => join(homedir(), '.claude', 'state', 'modes');

/**
 * Whether a value is one of the three mode words.
 * @param {unknown} word - candidate mode.
 * @returns {boolean} true for normal, medium or high.
 */
export function isMode(word) {
  return typeof word === 'string' && MODES.includes(word);
}

/**
 * First word of the `/mode` arguments, lowercased.
 * @param {unknown} commandArgs - `command_args` from the hook input.
 * @returns {string} the word, or '' when there is none.
 */
export function parseModeArg(commandArgs) {
  if (typeof commandArgs !== 'string') return '';
  return commandArgs.trim().split(/\s+/)[0].toLowerCase();
}

/**
 * Turn fast mode on or off for a mode by editing `fastMode` in a settings file. Only mode high wants it on.
 * Follows a symlinked settings file and keeps its permissions. A CLI write landing between our read and rename
 * would be lost; the window is a few milliseconds and both writers only ever set whole-file JSON, so it is accepted.
 * @param {string} mode - the mode being applied.
 * @param {string} [path] - settings file (default ~/.claude/settings.json).
 * @returns {Promise<'applied'|'unchanged'|'failed'>} what happened; failures are explained on stderr.
 * @throws never.
 */
export async function applyFastMode(mode, path = settingsPath()) {
  const wanted = mode === FAST_MODE_MODE;
  let temp;
  try {
    const target = await realpath(path);
    const settings = JSON.parse(await readFile(target, 'utf8'));
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      process.stderr.write('mode hook: fast mode not applied, settings is not a JSON object\n');
      return 'failed';
    }
    if ((settings.fastMode === true) === wanted) return 'unchanged';
    if (wanted) settings.fastMode = true;
    else delete settings.fastMode;
    temp = `${target}.${process.pid}.tmp`;
    const { mode: fileMode } = await stat(target);
    await writeFile(temp, `${JSON.stringify(settings, null, JSON_INDENT)}\n`, { mode: fileMode });
    await rename(temp, target);
    return 'applied';
  } catch (error) {
    process.stderr.write(`mode hook: fast mode not applied: ${error.message}\n`);
    // Best-effort cleanup: the temp file may not exist if writeFile itself failed; the real error is reported above.
    if (temp) await unlink(temp).catch(() => undefined);
    return 'failed';
  }
}

/**
 * Whether a state file is older than the retention window.
 * @param {number} mtimeMs - file modification time.
 * @param {number} nowMs - current time.
 * @returns {boolean} true when it should be deleted.
 */
export function isStale(mtimeMs, nowMs) {
  return nowMs - mtimeMs > STATE_MAX_AGE_DAYS * MS_PER_DAY;
}

async function readPlaybook(mode) {
  try {
    return (await readFile(join(modesDir(), `${mode}.md`), 'utf8')).trimEnd();
  } catch (error) {
    return `(playbook for ${mode} unreadable: ${error.code ?? error.message})`;
  }
}

async function readStateMode(sessionId) {
  try {
    const word = (await readFile(join(stateDir(), sessionId), 'utf8')).trim();
    return isMode(word) ? word : undefined;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    process.stderr.write(`mode hook: cannot read state: ${error.message}\n`);
    return undefined;
  }
}

function launchMode() {
  return isMode(process.env.CLAUDE_MODE) ? process.env.CLAUDE_MODE : DEFAULT_MODE;
}

async function activeMode(sessionId) {
  return (sessionId && (await readStateMode(sessionId))) || launchMode();
}

async function pruneState() {
  try {
    const dir = stateDir();
    const now = Date.now();
    for (const name of await readdir(dir)) {
      const file = join(dir, name);
      if (isStale((await stat(file)).mtimeMs, now)) await unlink(file);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') process.stderr.write(`mode hook: prune failed: ${error.message}\n`);
  }
}

async function onSessionStart(input, sessionId) {
  const current = await activeMode(sessionId);
  // Sync only an explicit mode (ccm launch or an earlier /mode), so a plain `claude` start leaves /fast alone.
  const explicit = isMode(process.env.CLAUDE_MODE) || (sessionId && (await readStateMode(sessionId)));
  if (explicit && (input.source === 'startup' || input.source === 'resume')) await applyFastMode(current);
  console.log(`Mode: ${current} (launched as ${launchMode()})\n\n${await readPlaybook(current)}`);
  await pruneState();
}

async function onExpansion(input, sessionId) {
  if (input.command_name !== 'mode') return;
  const target = parseModeArg(input.command_args);
  if (target === '') {
    const current = await activeMode(sessionId);
    console.log(`Active mode: ${current}. Switch with /mode normal|medium|high.`);
    return;
  }
  if (!isMode(target)) {
    console.log(USAGE);
    return;
  }
  if (!sessionId) return;
  try {
    await mkdir(stateDir(), { recursive: true });
    await writeFile(join(stateDir(), sessionId), `${target}\n`);
  } catch (error) {
    process.stderr.write(`mode hook: cannot save state: ${error.message}\n`);
  }
  const fast = target === FAST_MODE_MODE ? 'on' : 'off';
  const applied =
    (await applyFastMode(target)) === 'failed'
      ? `Fast mode NOT applied (settings.json unreadable); tell the user to run /fast to turn it ${fast}.`
      : `Applied: fast mode ${fast} (machine-wide, like /fast).`;
  const ultracode =
    launchMode() === FAST_MODE_MODE && target !== FAST_MODE_MODE
      ? '\nultracode from `ccm high` stays on until restart: do not start workflows unless the user asks.'
      : '';
  console.log(`Mode switched to ${target}.\n${applied}${ultracode}\n\n${await readPlaybook(target)}`);
}

async function onPromptSubmit(sessionId) {
  const current = await activeMode(sessionId);
  if (current !== DEFAULT_MODE) console.log(`Mode: ${current} - follow ~/.claude/modes/${current}.md`);
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return; // not hook JSON: stay silent, never block
  }
  const id = input?.session_id;
  const sessionId = typeof id === 'string' && SESSION_ID_PATTERN.test(id) ? id : undefined;
  switch (input?.hook_event_name) {
    case 'SessionStart':
      return onSessionStart(input, sessionId);
    case 'UserPromptExpansion':
      return onExpansion(input, sessionId);
    case 'UserPromptSubmit':
      return onPromptSubmit(sessionId);
    default:
      return;
  }
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`mode hook: ${error.message}\n`);
  }
}
