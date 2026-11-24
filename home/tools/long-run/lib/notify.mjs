// Purpose: tell the owner when a run needs him or ends (M1 desktop note, M2 phone push through ntfy), from a detached process.
// Exports: NOTIFY_CONFIG_TOPIC_CHARS, DESKTOP_NOTES_SWITCH, notifyConfigPath, readNotifyConfig, setupNtfy, removeNtfy, desktopCommand, ntfyRequest, notify.
// Invariants: every text is built from ids, status words and times only (never a prompt, question, path or log line); on every
//   platform the text is passed as data (osascript argv, environment variables for PowerShell, notify-send arguments after `--`),
//   never inside code; the ntfy topic is the shared secret: it is in the 0600 config file and the request URL only, never in a
//   log, an event or an error text; a failed note is returned to the caller (one events.jsonl line), never a run failure;
//   CLAUDE_LONG_RUN_DESKTOP_NOTES=off in the env shows no desktop note (the phone push is not affected).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensurePrivateDir, writeFileAtomic } from '../../account/lib/private-fs.mjs';
import { readJson } from './run-store.mjs';

/** The topic length (url-safe characters) `notify setup` makes. */
export const NOTIFY_CONFIG_TOPIC_CHARS = 24;
/**
 * The env switch that turns desktop notes off when it is `off` (any other value or unset: on). Tests set it, since Windows has
 * no way to stand in for powershell.exe; the phone push is not affected.
 */
export const DESKTOP_NOTES_SWITCH = 'CLAUDE_LONG_RUN_DESKTOP_NOTES';
const SWITCH_OFF = 'off';
const TOPIC_BYTES = 18; // 18 random bytes are 24 base64url characters
const DEFAULT_SERVER = 'https://ntfy.sh';
const NTFY_TIMEOUT_MS = 10 * 1000;
const TITLE = 'long-run';
const POWERSHELL_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
// The toast reads its text from two environment variables, so no text is ever part of the script (not verified, spec U5).
const TOAST_SCRIPT = [
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
  '$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  '$n = $x.GetElementsByTagName("text")',
  '$n.Item(0).AppendChild($x.CreateTextNode($env:LONG_RUN_NOTE_TITLE)) > $null',
  '$n.Item(1).AppendChild($x.CreateTextNode($env:LONG_RUN_NOTE_TEXT)) > $null',
  `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($x))`,
].join('; ');
const SERVER_PATTERN = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~-]+)*$/;
const TOPIC_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** `~/.config/claude-setup/long-run.json` (HOME read from `env`). */
export const notifyConfigPath = (env = process.env) => join(env.HOME || env.USERPROFILE || homedir(), '.config', 'claude-setup', 'long-run.json');

/** The ntfy config when it is valid, else null. */
export function readNotifyConfig(env = process.env) {
  const config = readJson(notifyConfigPath(env));
  const ntfy = config?.ntfy;
  return ntfy && SERVER_PATTERN.test(ntfy.server ?? '') && TOPIC_PATTERN.test(ntfy.topic ?? '') ? { ntfy } : null;
}

/**
 * Writes a new ntfy topic (0600).
 * @param {{env?: object, server?: string}} options `server` for a self-hosted ntfy (https only).
 * @returns {string} the subscribe link for the phone app.
 * @throws {Error} for a server that is not an https URL.
 */
export function setupNtfy({ env = process.env, server = DEFAULT_SERVER } = {}) {
  const trimmed = server.replace(/\/+$/, '');
  if (!SERVER_PATTERN.test(trimmed)) throw new Error('the ntfy server must be an https URL, like https://ntfy.sh');
  const topic = randomBytes(TOPIC_BYTES).toString('base64url');
  const path = notifyConfigPath(env);
  ensurePrivateDir(dirname(path));
  writeFileAtomic(path, `${JSON.stringify({ ntfy: { server: trimmed, topic } }, null, 2)}\n`);
  return `${trimmed}/${topic}`;
}

/** Removes the ntfy config. @returns {boolean} whether there was one. */
export function removeNtfy(env = process.env) {
  const path = notifyConfigPath(env);
  const had = existsSync(path);
  rmSync(path, { force: true });
  return had;
}

/**
 * The command that shows one desktop note.
 * @param {string} platform process.platform.
 * @param {string} title the title.
 * @param {string} text the text (ids and status words).
 * @returns {{command: string, args: string[], env: object} | null} `env`: variables to add for the child.
 */
export function desktopCommand(platform, title, text) {
  if (platform === 'darwin') {
    return { command: 'osascript', args: ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, text], env: {} };
  }
  if (platform === 'win32') {
    return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', TOAST_SCRIPT], env: { LONG_RUN_NOTE_TITLE: title, LONG_RUN_NOTE_TEXT: text } };
  }
  if (platform === 'linux') return { command: 'notify-send', args: ['--', title, text], env: {} };
  return null;
}

/**
 * The ntfy POST of one message.
 * @param {{server: string, topic: string}} ntfy the config.
 * @param {string} message run name, step id and status only.
 * @returns {{url: string, init: object}}
 */
export const ntfyRequest = (ntfy, message) => ({ url: `${ntfy.server}/${ntfy.topic}`, init: { method: 'POST', headers: { Title: TITLE }, body: message } });

function showDesktop(platform, text, spawnFn, env) {
  const command = desktopCommand(platform, TITLE, text);
  if (command === null) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawnFn(command.command, command.args, { env: { ...env, ...command.env }, stdio: 'ignore', windowsHide: true });
    child.once('error', (error) => resolve(`desktop note failed: ${error.code ?? error.name}`));
    child.once('close', (code) => resolve(code === 0 ? null : `desktop note failed: exit ${code}`));
  });
}

async function sendNtfy(config, message, fetchFn) {
  if (config === null) return null;
  const { url, init } = ntfyRequest(config.ntfy, message);
  try {
    const response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(NTFY_TIMEOUT_MS) });
    return response.ok ? null : `phone push failed: HTTP ${response.status}`;
  } catch (error) {
    return `phone push failed: ${error.name}`; // the name only: a message could hold the URL, and the URL holds the topic
  }
}

/**
 * Shows one note on the desktop (unless DESKTOP_NOTES_SWITCH is `off` in `env`) and on the phone.
 * @param {{desktop: string, phone: string}} texts the desktop text (may hold a time) and the phone text (name, step, status).
 * @param {{platform?: string, env?: object, spawnFn?: Function, fetchFn?: Function}} deps stand-ins for tests.
 * @returns {Promise<string[]>} the failures, one short line each (no topic, no text of the note).
 */
export async function notify(texts, { platform = process.platform, env = process.env, spawnFn = spawn, fetchFn = fetch } = {}) {
  const desktop = env[DESKTOP_NOTES_SWITCH] === SWITCH_OFF ? null : showDesktop(platform, texts.desktop, spawnFn, env);
  const results = await Promise.all([desktop, sendNtfy(readNotifyConfig(env), texts.phone, fetchFn)]);
  return results.filter((failure) => failure !== null);
}
