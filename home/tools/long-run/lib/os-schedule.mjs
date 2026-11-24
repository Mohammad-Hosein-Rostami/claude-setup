// Purpose: the system's own start entries for long-run: resume dead runs after a login (M6 `autostart`) and start a job at a time
//   (M7 `schedule`), as launchd agents on macOS and Task Scheduler tasks on Windows.
// Exports: AUTOSTART_LABEL, SCHEDULE_LABEL_PREFIX, TASK_FOLDER, nodePath, cliPath, plistText, launchAgentsDir, autostart,
//   addSchedule, listSchedules, removeSchedule, readSchedule.
// Invariants: every command runs through the injected `runner` (spawnSync) without a shell; names are job ids (ID_PATTERN) and times
//   are checked before they reach a file name, a label or an argument; plist text is XML-escaped; a launchd job keeps the PATH of the
//   moment it was made (launchd's own PATH has no `claude`) and abandons its process group, so the detached driver outlives the start
//   command; the Windows commands and the missed-while-asleep behaviour are not verified (spec U5, U13).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePrivateDir, writeFileAtomic } from '../../account/lib/private-fs.mjs';
import { ID_PATTERN } from './job.mjs';
import { readJson, writeJson } from './run-store.mjs';

/** The launchd label (and plist name) of the autostart agent. */
export const AUTOSTART_LABEL = 'com.claude-setup.long-run.resume';
/** Schedule agents are `<prefix><job name>`. */
export const SCHEDULE_LABEL_PREFIX = 'com.claude-setup.long-run.schedule.';
/** The Task Scheduler folder of every long-run task. */
export const TASK_FOLDER = 'claude-setup';
const AUTOSTART_DELAY_SECONDS = 60;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WIN32_UNSAFE = /["%^&|<>]/;
const XML = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

const escapeXml = (text) => String(text).replace(/[&<>"']/g, (char) => XML[char]);
const home = (env) => env.HOME || env.USERPROFILE || homedir();

/** The node a system entry starts: the Volta shim when present (it follows Node upgrades), else this node. */
export const nodePath = (env = process.env) => (existsSync(join(home(env), '.volta', 'bin', 'node')) ? join(home(env), '.volta', 'bin', 'node') : process.execPath);

/** The absolute path of long-run.mjs. */
export const cliPath = () => join(dirname(dirname(fileURLToPath(import.meta.url))), 'long-run.mjs');

/** `~/Library/LaunchAgents`. */
export const launchAgentsDir = (env = process.env) => join(home(env), 'Library', 'LaunchAgents');

function xmlValue(value) {
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
  if (typeof value === 'number') return `<integer>${value}</integer>`;
  if (Array.isArray(value)) return `<array>${value.map(xmlValue).join('')}</array>`;
  if (typeof value === 'object') return `<dict>${Object.entries(value).map(([key, inner]) => `<key>${escapeXml(key)}</key>${xmlValue(inner)}`).join('')}</dict>`;
  return `<string>${escapeXml(value)}</string>`;
}

/**
 * A launchd property list.
 * @param {{label: string, args: string[], path: string, runAtLoad?: boolean, calendar?: object | null}} agent `calendar`: the
 *   StartCalendarInterval keys (Hour, Minute, and for one date also Day, Month).
 * @returns {string} the XML text.
 */
export function plistText({ label, args, path, runAtLoad = false, calendar = null }) {
  const body = { Label: label, ProgramArguments: args, EnvironmentVariables: { PATH: path }, AbandonProcessGroup: true, RunAtLoad: runAtLoad };
  if (calendar) body.StartCalendarInterval = calendar;
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<plist version="1.0">${xmlValue(body)}</plist>`, ''].join('\n');
}

function requireRan(run, what) {
  if (run.status !== 0) throw new Error(`${what} failed (exit ${run.status}): ${String(run.stderr ?? '').trim().slice(0, 200)}`);
}

const winQuote = (text) => {
  if (WIN32_UNSAFE.test(text)) throw new Error(`a path for Task Scheduler may not hold " % ^ & | < >: ${text}`);
  return `"${text}"`;
};

function loadAgent(label, text, { env, runner, uid }) {
  const dir = launchAgentsDir(env);
  ensurePrivateDir(dir);
  const plist = join(dir, `${label}.plist`);
  runner('launchctl', ['bootout', `gui/${uid}/${label}`], { encoding: 'utf8' }); // not loaded yet is fine: the bootstrap below decides
  writeFileAtomic(plist, text);
  requireRan(runner('launchctl', ['bootstrap', `gui/${uid}`, plist], { encoding: 'utf8' }), 'launchctl bootstrap');
  return plist;
}

function unloadAgent(label, { env, runner, uid }) {
  const plist = join(launchAgentsDir(env), `${label}.plist`);
  const had = existsSync(plist);
  runner('launchctl', ['bootout', `gui/${uid}/${label}`], { encoding: 'utf8' });
  rmSync(plist, { force: true });
  return had;
}

const defaults = (options) => ({ env: process.env, platform: process.platform, runner: spawnSync, uid: process.getuid?.() ?? 0, ...options });

/**
 * `autostart on | off | status` (M6): resume every stale run 60 s after login.
 * @param {'on' | 'off' | 'status'} action
 * @param {{env?: object, platform?: string, runner?: Function, uid?: number}} options stand-ins for tests.
 * @returns {string} one line for the owner.
 */
export function autostart(action, options = {}) {
  const { env, platform, runner } = defaults(options);
  const args = [nodePath(env), cliPath(), 'resume', '--stale', '--delay', String(AUTOSTART_DELAY_SECONDS)];
  const task = `${TASK_FOLDER}\\long-run-resume`;
  if (platform === 'darwin') {
    if (action === 'on') return `autostart on: ${loadAgent(AUTOSTART_LABEL, plistText({ label: AUTOSTART_LABEL, args, path: env.PATH ?? '', runAtLoad: true }), defaults(options))}`;
    if (action === 'off') return unloadAgent(AUTOSTART_LABEL, defaults(options)) ? 'autostart off' : 'autostart was off';
    return existsSync(join(launchAgentsDir(env), `${AUTOSTART_LABEL}.plist`)) ? 'autostart on' : 'autostart off';
  }
  if (platform === 'win32') {
    if (action === 'on') requireRan(runner('schtasks', ['/Create', '/TN', task, '/SC', 'ONLOGON', '/TR', args.map(winQuote).join(' '), '/F'], { encoding: 'utf8', windowsHide: true }), 'schtasks /Create');
    if (action === 'off') runner('schtasks', ['/Delete', '/TN', task, '/F'], { encoding: 'utf8', windowsHide: true });
    if (action !== 'status') return `autostart ${action}`;
    return runner('schtasks', ['/Query', '/TN', task], { encoding: 'utf8', windowsHide: true }).status === 0 ? 'autostart on' : 'autostart off';
  }
  throw new Error('autostart is made for macOS (launchd) and Windows (Task Scheduler) only');
}

const schedulesDir = (root) => join(root, 'schedules');

/** The recorded schedule `name`, or null. */
export const readSchedule = (root, name) => (ID_PATTERN.test(name) ? readJson(join(schedulesDir(root), `${name}.json`)) : null);

function calendarOf(at, on) {
  const [, hour, minute] = TIME.exec(at) ?? [];
  if (hour === undefined) throw new Error('--at takes HH:MM (24 h, local time)');
  if (on === null) return { Hour: Number(hour), Minute: Number(minute) };
  const [, , month, day] = DATE.exec(on) ?? [];
  if (month === undefined) throw new Error('--on takes YYYY-MM-DD');
  return { Month: Number(month), Day: Number(day), Hour: Number(hour), Minute: Number(minute) };
}

/**
 * `schedule <job> --at HH:MM [--daily | --on YYYY-MM-DD]` (M7): records the job path and the account selected now, and makes the entry.
 * @param {{root: string, name: string, jobPath: string, account: string, at: string, on: string | null}} schedule `on` null: daily.
 * @param {{env?: object, platform?: string, runner?: Function, uid?: number}} options stand-ins for tests.
 * @returns {string} where the entry is.
 */
export function addSchedule({ root, name, jobPath, account, at, on }, options = {}) {
  const { env, platform, runner } = defaults(options);
  if (!ID_PATTERN.test(name)) throw new Error(`not a job name: ${name}`);
  const calendar = calendarOf(at, on);
  const args = [nodePath(env), cliPath(), 'start', jobPath, '--schedule', name];
  ensurePrivateDir(schedulesDir(root));
  writeJson(join(schedulesDir(root), `${name}.json`), { name, job: jobPath, account, at, on, createdAt: new Date().toISOString() });
  if (platform === 'darwin') return loadAgent(`${SCHEDULE_LABEL_PREFIX}${name}`, plistText({ label: `${SCHEDULE_LABEL_PREFIX}${name}`, args, path: env.PATH ?? '', calendar }), defaults(options));
  if (platform === 'win32') {
    const when = on === null ? ['/SC', 'DAILY', '/ST', at] : ['/SC', 'ONCE', '/ST', at, '/SD', `${on.slice(5, 7)}/${on.slice(8, 10)}/${on.slice(0, 4)}`];
    requireRan(runner('schtasks', ['/Create', '/TN', `${TASK_FOLDER}\\long-run-${name}`, ...when, '/TR', args.map(winQuote).join(' '), '/F'], { encoding: 'utf8', windowsHide: true }), 'schtasks /Create');
    return `${TASK_FOLDER}\\long-run-${name}`;
  }
  throw new Error('schedule is made for macOS (launchd) and Windows (Task Scheduler) only');
}

/** The recorded schedules. */
export function listSchedules(root) {
  const dir = schedulesDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => file.endsWith('.json')).map((file) => readJson(join(dir, file))).filter(Boolean);
}

/**
 * Removes a schedule and its entry.
 * @returns {boolean} whether it was recorded.
 */
export function removeSchedule(root, name, options = {}) {
  const { platform, runner } = defaults(options);
  if (!ID_PATTERN.test(name)) throw new Error(`not a job name: ${name}`);
  const path = join(schedulesDir(root), `${name}.json`);
  const had = existsSync(path);
  rmSync(path, { force: true });
  if (platform === 'darwin') unloadAgent(`${SCHEDULE_LABEL_PREFIX}${name}`, defaults(options));
  if (platform === 'win32') runner('schtasks', ['/Delete', '/TN', `${TASK_FOLDER}\\long-run-${name}`, '/F'], { encoding: 'utf8', windowsHide: true });
  return had;
}
