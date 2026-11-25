// Purpose: the Windows-only install steps: Git Bash must be there, and the launcher folder goes on the user PATH.
// Exports: powershell, findGitBash, requireGitBash, addUserPath.
// Invariants: the user PATH is read raw from the registry (no %VAR% expansion) and written back as ExpandString, so existing
//   %VAR% entries survive; a folder already on it changes nothing. The PowerShell text goes in as -EncodedCommand (no quoting).
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { InstallError, act, note, warn } from './context.mjs';

const POWERSHELL_TIMEOUT_MS = 60000;

/** Runs PowerShell text without a profile; returns its result. */
export function powershell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', timeout: POWERSHELL_TIMEOUT_MS });
}

/**
 * Git Bash's bash.exe: CLAUDE_CODE_GIT_BASH_PATH, the usual install folders, or beside the git on PATH (<Git>\\cmd\\git.exe).
 * @param {NodeJS.ProcessEnv} env the environment
 * @returns {string|null} the path, or null when none is there
 */
export function findGitBash(env) {
  const folders = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  const where = spawnSync('where', ['git'], { encoding: 'utf8' });
  const besideGit = where.status === 0 ? where.stdout.split(/\r?\n/).filter(Boolean).map((git) => join(dirname(dirname(git.trim())), 'bin', 'bash.exe')) : [];
  const candidates = [env.CLAUDE_CODE_GIT_BASH_PATH, ...folders.map((folder) => join(folder, 'Git', 'bin', 'bash.exe')), ...besideGit].filter(Boolean);
  return candidates.find((path) => existsSync(path)) ?? null;
}

/**
 * Stops the install without Git Bash: Claude Code on Windows runs its Bash tool, the hooks' shell and the status line
 * through it; without it the PowerShell tool is the only shell, and the hooks and the status line do not run.
 * @throws {InstallError} when Git Bash is not found
 */
export function requireGitBash(ctx) {
  const found = findGitBash(ctx.env);
  if (!found) throw new InstallError('Git Bash not found (winget install Git.Git, or set CLAUDE_CODE_GIT_BASH_PATH to its bash.exe)');
  note(ctx, `ok Git Bash ${found}`);
}

/**
 * Adds `folder` to the user PATH in the registry and tells running programs (a variable set and removed broadcasts
 * WM_SETTINGCHANGE), so new terminals see it.
 * @param {object} ctx the run context
 * @param {string} folder the folder to add
 */
export function addUserPath(ctx, folder) {
  const literal = folder.replaceAll("'", "''");
  const script = [
    "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
    "try { $raw = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); $entries = @(($raw -split ';') | Where-Object { $_ })",
    `  if ($entries -contains '${literal}') { 'present' } else { $key.SetValue('Path', (($entries + '${literal}') -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)`,
    "    [Environment]::SetEnvironmentVariable('CLAUDE_SETUP_PATH_REFRESH', '1', 'User'); [Environment]::SetEnvironmentVariable('CLAUDE_SETUP_PATH_REFRESH', $null, 'User'); 'added' } }",
    'finally { $key.Close() }',
  ].join('\n');
  const result = act(ctx, `add ${folder} to the user PATH`, () => powershell(script));
  if (!result) return;
  if (result.status !== 0) warn(`could not add ${folder} to the user PATH (${(result.stderr || '').trim()}); add it by hand`);
  else note(ctx, result.stdout.includes('added') ? `added ${folder} to the user PATH` : `ok ${folder} on the user PATH`);
}
