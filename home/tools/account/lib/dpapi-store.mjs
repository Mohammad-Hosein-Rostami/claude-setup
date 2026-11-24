// Purpose: the token store of Windows: one file `<name>.dpapi` per account in the accounts folder, holding the token
// protected with DPAPI for the current user (so a copy of the file is useless on another account or machine).
// NOT VERIFIED: written on a Mac with no Windows machine and no PowerShell at hand; probe ACC-5 (DPAPI through
// PowerShell from Node) is not run. It moves to the first step of phase 7 (`r9-windows`). The tests cover only what does
// not need Windows: with a fake runner, the token and the protected text reach PowerShell on stdin and never in its arguments.
// Exports: dpapiStore, runPowerShell.
// Invariants: the PowerShell script texts are fixed constants; the token is only ever on stdin or stdout of that child.
import { spawnSync } from 'node:child_process';
import { lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDir, writeFileAtomic } from './private-fs.mjs';
import { AccountError, assertName, assertToken } from './names.mjs';
import { readPrivateFile } from './private-file.mjs';

const POWERSHELL = 'powershell.exe';
const POWERSHELL_TIMEOUT_MS = 30000;
const PROTECTED_FILE_SUFFIX = '.dpapi';
const PROTECTED_FILE_MAX_BYTES = 8192;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const LOAD = 'Add-Type -AssemblyName System.Security; $in = [Console]::In.ReadLine();';
const PROTECT_SCRIPT = `${LOAD} [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($in), $null, 'CurrentUser'))`;
const UNPROTECT_SCRIPT = `${LOAD} [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in), $null, 'CurrentUser'))`;

/**
 * Runs a fixed PowerShell script with one line on stdin.
 * @param {string} script one of the two constants above (it is a command argument: never holds a token).
 * @param {string} input the line for stdin.
 * @returns {string} what the script printed, trimmed.
 * @throws {AccountError} kind `store` when PowerShell fails (the message names the exit code only).
 */
export function runPowerShell(script, input) {
  const run = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { input: `${input}\n`, encoding: 'utf8', timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true });
  if (run.status !== 0) throw new AccountError('store', `Windows data protection failed: powershell exit ${run.status}`);
  return run.stdout.trim();
}

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * @param {string} dir the accounts folder (`accountsDir`).
 * @param {{run?: (script: string, input: string) => string}} options `run` replaces `runPowerShell` (tests).
 * @returns {{kind: 'dpapi', put: Function, get: Function, remove: Function}} as `fileStore`.
 */
export function dpapiStore(dir, { run = runPowerShell } = {}) {
  const fileOf = (name) => join(dir, `${assertName(name)}${PROTECTED_FILE_SUFFIX}`);
  return {
    kind: 'dpapi',
    put(name, token) {
      const path = fileOf(name);
      const protectedText = run(PROTECT_SCRIPT, assertToken(token));
      if (!BASE64.test(protectedText)) throw new AccountError('store', 'Windows data protection returned no protected text; nothing stored');
      ensurePrivateDir(dir);
      writeFileAtomic(path, `${protectedText}\n`);
    },
    get(name) {
      const text = readPrivateFile(fileOf(name), PROTECTED_FILE_MAX_BYTES);
      if (text === null) return null;
      if (!BASE64.test(text.trim())) throw new AccountError('store', 'the protected file of that account is not readable; add the account again');
      return assertToken(run(UNPROTECT_SCRIPT, text.trim()));
    },
    remove(name) {
      const path = fileOf(name);
      if (!exists(path)) return false;
      rmSync(path);
      return true;
    },
  };
}
