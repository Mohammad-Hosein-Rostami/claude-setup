// Purpose: the Windows-only install steps: the launcher folder on the user PATH.
// Exports: powershell, addUserPath.
// Invariants: the user PATH is read raw from the registry (no %VAR% expansion) and written back as ExpandString, so existing
//   %VAR% entries survive; a folder already on it changes nothing. The PowerShell text goes in as -EncodedCommand (no quoting).
import { spawnSync } from 'node:child_process';
import { act, note, warn } from './context.mjs';

const POWERSHELL_TIMEOUT_MS = 60000;

/** Runs PowerShell text without a profile; returns its result. */
export function powershell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', timeout: POWERSHELL_TIMEOUT_MS });
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
