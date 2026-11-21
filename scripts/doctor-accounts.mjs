#!/usr/bin/env node
// Purpose: the account checks of scripts/doctor.sh (spec-accounts.md "Safety", lane r9-accounts-wiring): a literal token in
// a shell start-up file or a settings `env` block (FAIL), a pasted token in a shell history file (WARN), the start-up line
// that sources home/shell/claude-as.sh (FAIL when missing), `fastMode: true` and a forced Fable subagent model (FAIL), per
// stored account: revoked at its last check (FAIL), the last 30 days of its one-year token (WARN), its plan and whether
// usage credits are confirmed off (WARN until the owner says so), then one tiny login call on the account a hook job
// would spend (home/tools/recall/lib/claude-call.mjs: CLAUDE_ACCOUNT, else the default): FAIL when it is refused, WARN
// when no account is found; a locked Keychain is a WARN, with a WARN for Claude Code's own ~/.claude/.credentials.json.
// Usage: node scripts/doctor-accounts.mjs <claude-dir> <repo> <project>
// Output: one line per finding, `ok    <text>`, `WARN  <text>` or `FAIL  <text>`; doctor.sh prints them and sets its exit.
// Exports: main, START_UP_MARK, shellStartUpFile (the start-up rule install.sh follows; for the doctor tests).
// Exit 0 when the checks ran (findings are in the lines), 1 when this script itself failed.
// Invariants: a token is never printed: a finding names the file and line numbers only, and every error text is cut free
// of token-shaped text. The login call gives the token to its child in the child's environment only (callHaiku), never
// doctor's own shell token. Reads only regular files up to a size cap (no FIFO is opened); writes nothing but the usage
// row of the one login call. Every store and registry read goes through home/tools/account/lib.
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { accountForCall, listAccounts } from '../home/tools/account/lib/accounts.mjs';
import { CHECK_REVOKED, CHECK_VALID, checkToken } from '../home/tools/account/lib/check.mjs';
import { looksLikeToken } from '../home/tools/account/lib/names.mjs';

/** The comment that ends the start-up line install.sh and install.ps1 write; the line is found by it. */
export const START_UP_MARK = '# claude-setup: claude-as';
const YEAR_END_WARN_DAYS = 30;
const READ_MAX_BYTES = 64 * 1024 * 1024; // a shell history file larger than this is not read (one line says so)
const LINES_SHOWN = 5; // line numbers named per file; the rest are counted
const LOCKED_TEXT = 'the Keychain is locked'; // the store's message for security exit 36 (keychain-store.mjs)
const FORCED_MODEL = 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE';
const FABLE = /fable/i;
const TOKEN_SHAPED = /sk-ant-[A-Za-z0-9_-]*/g;

const findings = [];
const say = (level, text) => findings.push(`${level.padEnd(6)}${String(text).replace(TOKEN_SHAPED, '<token>')}`);

/** The text of a regular file of at most READ_MAX_BYTES, `null` when it is missing or not a regular file, `'too big'` above the cap. */
function readSmall(path) {
  const info = statSync(path, { throwIfNoEntry: false });
  if (!info?.isFile()) return null;
  if (info.size > READ_MAX_BYTES) return 'too big';
  return readFileSync(path, 'latin1'); // zsh history is not always UTF-8
}

/** `path:3,7` for the lines of `text` that hold something shaped like a token, or null when none does. */
function tokenLines(path, text) {
  const hits = text.split('\n').flatMap((line, at) => (looksLikeToken(line) ? [at + 1] : []));
  if (hits.length === 0) return null;
  const more = hits.length > LINES_SHOWN ? ` and ${hits.length - LINES_SHOWN} more lines` : '';
  return `${path}:${hits.slice(0, LINES_SHOWN).join(',')}${more}`;
}

const homeOf = (env) => env.HOME || env.USERPROFILE || '';

/** The PowerShell profiles install.ps1 may write ($PROFILE.CurrentUserAllHosts of PowerShell 7 and 5.1), or DOCTOR_PS_PROFILE. */
function powerShellProfiles(env) {
  if (env.DOCTOR_PS_PROFILE) return [env.DOCTOR_PS_PROFILE];
  const documents = [join(homeOf(env), 'Documents'), ...(env.OneDrive ? [join(env.OneDrive, 'Documents')] : [])];
  return documents.flatMap((dir) => ['PowerShell', 'WindowsPowerShell'].map((shell) => join(dir, shell, 'profile.ps1')));
}

function startUpFiles(env) {
  const home = homeOf(env);
  const zdot = env.ZDOTDIR || home;
  const zsh = ['.zshenv', '.zprofile', '.zshrc', '.zlogin'].map((name) => join(zdot, name));
  const sh = ['.bashrc', '.bash_profile', '.bash_login', '.profile'].map((name) => join(home, name));
  return [...new Set([...zsh, ...sh, ...powerShellProfiles(env)])];
}

/** Every settings file doctor knows of: the live ones, the repo's sources and the project's own. */
function settingsFiles(claudeDir, repo, project) {
  const repoSettings = join(repo, 'settings');
  const sources = readdirSync(repoSettings, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => join(repoSettings, e.name));
  return [join(claudeDir, 'settings.json'), join(claudeDir, 'settings.local.json'), ...sources,
    join(project, '.claude', 'settings.json'), join(project, '.claude', 'settings.local.json')];
}

/** The parsed settings files that exist and are JSON objects: [{path, text, json}]. */
function readSettings(paths) {
  return paths.flatMap((path) => {
    const text = readSmall(path);
    if (text === null || text === 'too big') return [];
    try {
      const json = JSON.parse(text);
      return json && typeof json === 'object' ? [{ path, text, json }] : [];
    } catch {
      return []; // doctor's check_settings reports a live settings.json that is not JSON; a broken source fails install
    }
  });
}

function checkLiteralTokens(env, settings) {
  const hits = [];
  for (const path of startUpFiles(env)) {
    const text = readSmall(path);
    const where = text && text !== 'too big' ? tokenLines(path, text) : null;
    if (where) hits.push(where);
  }
  for (const { path, text, json } of settings) {
    const values = Object.values(json.env && typeof json.env === 'object' ? json.env : {});
    if (values.some((value) => typeof value === 'string' && looksLikeToken(value))) hits.push(tokenLines(path, text) ?? path);
  }
  for (const where of hits) say('FAIL', `literal token in ${where} (delete it there; set accounts with claude-as <name>)`);
  if (hits.length === 0) say('ok', 'no literal token in shell start-up files or settings env blocks');
}

function historyFiles(env) {
  const home = homeOf(env);
  const zdot = env.ZDOTDIR || home;
  const psReadLine = env.APPDATA ? [join(env.APPDATA, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt')] : [];
  return [...new Set([...(env.HISTFILE ? [env.HISTFILE] : []), join(zdot, '.zsh_history'), join(home, '.zsh_history'), join(home, '.bash_history'), ...psReadLine])];
}

function checkHistory(env) {
  let found = false;
  for (const path of historyFiles(env)) {
    const text = readSmall(path);
    if (text === 'too big') say('WARN', `${path} is over ${READ_MAX_BYTES / 1024 / 1024} MB: not scanned for pasted tokens`);
    const where = text && text !== 'too big' ? tokenLines(path, text) : null;
    if (where) { found = true; say('WARN', `pasted token in shell history ${where} (delete those lines; paste tokens only at the hidden prompt of claude-as)`); }
  }
  if (!found) say('ok', 'no pasted token in shell history files');
}

/** The rc file install.sh writes the line to for this login shell, or null for a shell it does not write (fish, none). */
export function shellStartUpFile(env) {
  const shell = basename(env.SHELL || '');
  if (shell === 'zsh') return join(env.ZDOTDIR || homeOf(env), '.zshrc');
  if (shell === 'bash') return join(homeOf(env), '.bashrc');
  return null;
}

/** ok when one of `files` holds the marked line and the file it sources exists; else the problem. */
function startUpLineIn(files) {
  for (const path of files) {
    const text = readSmall(path);
    const line = text && text !== 'too big' ? text.split('\n').find((row) => row.includes(START_UP_MARK)) : undefined;
    if (line === undefined) continue;
    const sourced = /'([^']+claude-as\.(?:sh|ps1))'/.exec(line)?.[1];
    if (sourced && statSync(sourced, { throwIfNoEntry: false })?.isFile()) return { ok: `start-up line in ${path} sources ${sourced}` };
    return { fail: `start-up line in ${path} names ${sourced ?? 'no claude-as file'}, which is not there (re-run the installer)` };
  }
  return { fail: `no claude-as start-up line in ${files.join(' or ')} (re-run the installer)` };
}

/** FAIL without the line in the login shell's rc file; on Windows WARN without it in a PowerShell profile (install.ps1 may not have run). */
function checkStartUpLine(env, platform) {
  const rc = shellStartUpFile(env);
  const groups = [...(rc ? [{ files: [rc], level: 'FAIL' }] : []), ...(platform === 'win32' ? [{ files: powerShellProfiles(env), level: 'WARN' }] : [])];
  if (groups.length === 0) say('WARN', `login shell ${env.SHELL || '(none)'}: no start-up line is written for it; source home/shell/claude-as.sh by hand`);
  for (const { files, level } of groups) {
    const { ok, fail } = startUpLineIn(files);
    if (ok) say('ok', ok); else say(level, fail);
  }
}

function checkPaidExtras(env, settings) {
  let found = false;
  for (const { path, json } of settings) {
    if (json.fastMode === true) { found = true; say('FAIL', `fastMode: true in ${path} (fast mode is paid usage credits only)`); }
    const forced = json.env && typeof json.env === 'object' ? json.env[FORCED_MODEL] : undefined;
    if (typeof forced === 'string' && FABLE.test(forced)) { found = true; say('FAIL', `${FORCED_MODEL} names a Fable model in ${path} (a -p Fable request may spend credits)`); }
  }
  if (FABLE.test(env[FORCED_MODEL] ?? '')) { found = true; say('FAIL', `${FORCED_MODEL} names a Fable model in doctor's environment`); }
  if (!found) say('ok', 'no fastMode and no forced Fable subagent model');
}

function checkOneAccount({ name, daysLeft, plan, creditsOff, checked }) {
  if (checked?.result === CHECK_REVOKED) say('FAIL', `account ${name}: revoked at its last check (${checked.at}); make a new token with claude setup-token, then claude-account remove ${name} and claude-as ${name}`);
  if (daysLeft <= YEAR_END_WARN_DAYS) say('WARN', `account ${name}: ${daysLeft > 0 ? `its token's year ends in ${daysLeft} days` : `its token's year ended ${-daysLeft} days ago`}; make a new token before then (claude setup-token)`);
  if (plan) say('ok', `account ${name}: plan ${plan}`);
  else say('WARN', `account ${name}: plan unknown (claude-account plan ${name} pro|max|ultra)`);
  if (creditsOff) say('ok', `account ${name}: usage credits off (your answer)`);
  else say('WARN', `account ${name}: usage credits: not confirmed off (turn them off in claude.ai Settings > Usage, then claude-account credits-off ${name})`);
}

function checkStoredAccounts(env) {
  // No CLAUDE_ACCOUNT: the list then reads no token (the store is only read for "used in this terminal").
  const withoutName = { ...env };
  delete withoutName.CLAUDE_ACCOUNT;
  const accounts = listAccounts({ env: withoutName });
  if (accounts.length === 0) say('WARN', 'no stored account: hook jobs make no model call (add one in a normal terminal: claude-as <name>)');
  for (const account of accounts) checkOneAccount(account);
}

function lockedKeychain(claudeDir) {
  say('WARN', 'the Keychain is locked (an ssh session?): no stored account can be read; unlock it or run from a local terminal');
  const credentials = join(claudeDir, '.credentials.json');
  if (statSync(credentials, { throwIfNoEntry: false })) say('WARN', `${credentials} exists: Claude Code wrote a login there because the Keychain refused it`);
}

async function checkLogin(env, claudeDir) {
  let account;
  try {
    account = accountForCall(env);
  } catch (error) {
    if (String(error?.message).includes(LOCKED_TEXT)) return lockedKeychain(claudeDir);
    return say('FAIL', `login check: the account store could not be read: ${error?.message ?? error}`);
  }
  if (account === null) return say('WARN', 'login check: no account found (CLAUDE_ACCOUNT unset or "-", and no default): hook jobs make no model call; pick one with claude-as <name>');
  const result = await checkToken(account.name, account.token, { env });
  if (result === CHECK_VALID) say('ok', `login check: account ${account.name} made a working call`);
  else if (result === CHECK_REVOKED) say('FAIL', `login check: account ${account.name} was refused (revoked)`);
  else say('WARN', `login check: account ${account.name}: ${result}`);
}

/** Runs one check; an error inside it becomes a FAIL line naming the check, so the others still run. */
async function guarded(label, check) {
  try {
    await check();
  } catch (error) {
    say('FAIL', `${label} could not run: ${error?.name ?? 'Error'}: ${error?.message ?? error}`);
  }
}

/**
 * Runs every account check and prints the findings.
 * @param {string[]} argv `<claude-dir> <repo> <project>`.
 * @param {object} env the environment (HOME, SHELL, ZDOTDIR, HISTFILE, CLAUDE_ACCOUNT, the account tool's variables).
 * @returns {Promise<number>} 0 when the checks ran, 2 for a usage error.
 */
export async function main(argv, env = process.env) {
  const [claudeDir, repo, project] = argv;
  if (!claudeDir || !repo || !project) { console.error('usage: doctor-accounts.mjs <claude-dir> <repo> <project>'); return 2; }
  let settings = [];
  await guarded('settings read', () => { settings = readSettings(settingsFiles(claudeDir, repo, project)); });
  await guarded('literal token check', () => checkLiteralTokens(env, settings));
  await guarded('shell history check', () => checkHistory(env));
  await guarded('start-up line check', () => checkStartUpLine(env, process.platform));
  await guarded('paid extras check', () => checkPaidExtras(env, settings));
  await guarded('stored accounts check', () => checkStoredAccounts(env));
  await guarded('login check', () => checkLogin(env, claudeDir));
  process.stdout.write(findings.map((line) => `${line}\n`).join(''));
  return 0;
}

// realpath: doctor.sh may name this file through a linked folder.
if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) process.exitCode = await main(process.argv.slice(2));
