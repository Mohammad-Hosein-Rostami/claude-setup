// Setup-mode hook (normal | medium | high). One script, dispatches on `hook_event_name`:
//   SessionStart         -> prints the active mode and its playbook; prunes stale state files.
//   UserPromptExpansion  -> for `/mode <m>`: records the mode for this session, prints playbook + switches to type.
//   UserPromptSubmit     -> one reminder line when the active mode is not medium.
// Stdout of these events is added to the model context. Invariants: never blocks (always exit 0); unreadable
// input or an unsafe session_id produce no output. Active mode = state file -> env CLAUDE_MODE -> medium.
// Exports pure helpers for tests.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const MODES = ['normal', 'medium', 'high'];
export const DEFAULT_MODE = 'medium';
const SESSION_ID_PATTERN = /^[\w-]+$/;
const STATE_MAX_AGE_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const EFFORT_BY_MODE = { normal: 'medium', medium: 'high', high: 'ultracode' };
const USAGE = 'Usage: /mode normal|medium|high';

const modesDir = () => join(homedir(), '.claude', 'modes');
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
 * The "Switches to type now" line: what the user must still type to match the target mode, given how the
 * session was launched (`ccm` fixes effort, fast mode and the forced subagent model at launch).
 * @param {string} launchMode - mode the session was launched with.
 * @param {string} targetMode - mode being switched to.
 * @returns {string} one line of text.
 */
export function switchesLine(launchMode, targetMode) {
  const prefix = 'Switches to type now: ';
  if (launchMode === targetMode) return `${prefix}none.`;
  if (targetMode === 'high') {
    return (
      `${prefix}/effort ultracode, then /fast (fast mode bills usage credits). ` +
      'Until restarted with `ccm high`, pass model: "opus" on every Agent call.'
    );
  }
  if (launchMode === 'high') {
    return (
      `${prefix}/effort ${EFFORT_BY_MODE[targetMode]}, /effort ultracode off, and /fast to turn fast mode off. ` +
      `Restart with \`ccm ${targetMode}\` to drop forced Opus subagents.`
    );
  }
  if (EFFORT_BY_MODE[launchMode] === EFFORT_BY_MODE[targetMode]) return `${prefix}none.`;
  return `${prefix}/effort ${EFFORT_BY_MODE[targetMode]}.`;
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

async function onSessionStart(sessionId) {
  const current = await activeMode(sessionId);
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
  console.log(`Mode switched to ${target}.\n\n${await readPlaybook(target)}\n\n${switchesLine(launchMode(), target)}`);
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
      return onSessionStart(sessionId);
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
