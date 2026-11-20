// Purpose: the list of accounts and their non-secret fields, `accounts.json` in the accounts folder: per account the
// date it was added, the plan and "usage credits off" as the owner said them, the last check; and the default account.
// Exports: accountsDir, readRegistry, writeRegistry, REGISTRY_FILE, REGISTRY_MAX_BYTES, PLANS.
// Invariants: never a token; the folder is 0700 and the file 0600 from the first write (private-fs.mjs of recall) and
// replaced whole, so a reader never sees half a list; the reader refuses a link, a looser mode and anything that is not
// this shape; writer and reader keep one size cap. The file is written with two-space indentation, one field per line:
// home/shell/claude-as.sh finds the line `"default": "<name>"` in it at shell start without starting node.
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ensurePrivateDir, writeFileAtomic } from '../../recall/lib/private-fs.mjs';
import { AccountError, NAME_PATTERN } from './names.mjs';
import { assertPrivateDir, readPrivateFile } from './private-file.mjs';

export const REGISTRY_FILE = 'accounts.json';
/** The cap of accounts.json for its writer and its reader (about 400 accounts). */
export const REGISTRY_MAX_BYTES = 64 * 1024;
/** The plans the owner can record for an account. */
export const PLANS = ['pro', 'max', 'ultra'];
const CHECK_RESULT_MAX_CHARS = 80;
const INDENT_SPACES = 2;

/**
 * The folder that holds accounts.json (and the token files of the file and Windows stores).
 * @param {object} env `CLAUDE_ACCOUNT_DIR` overrides it (tests); else `~/.config/claude-setup/accounts`.
 * @returns {string}
 */
export const accountsDir = (env = process.env) => env.CLAUDE_ACCOUNT_DIR || join(env.HOME || env.USERPROFILE || homedir(), '.config', 'claude-setup', 'accounts');

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));

function isAccount(entry) {
  if (!isRecord(entry) || !isDate(entry.added) || typeof entry.creditsOff !== 'boolean') return false;
  if (entry.plan !== null && !PLANS.includes(entry.plan)) return false;
  const { checked } = entry;
  return checked === null || (isRecord(checked) && isDate(checked.at) && typeof checked.result === 'string' && checked.result.length <= CHECK_RESULT_MAX_CHARS);
}

function parseRegistry(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  const names = isRecord(parsed) && isRecord(parsed.accounts) ? Object.keys(parsed.accounts) : null;
  const valid = names !== null && (parsed.default === null || (typeof parsed.default === 'string' && NAME_PATTERN.test(parsed.default)))
    && names.every((name) => NAME_PATTERN.test(name) && isAccount(parsed.accounts[name]));
  if (!valid) throw new AccountError('registry', `${REGISTRY_FILE} is not the account list this tool writes; not used`);
  return { default: parsed.default, accounts: parsed.accounts };
}

/**
 * @param {object} env see `accountsDir`.
 * @returns {{default: string | null, accounts: Record<string, {added: string, plan: string | null, creditsOff: boolean, checked: {at: string, result: string} | null}>}}
 *   an empty list when the file does not exist yet.
 * @throws {AccountError} kind `unsafe-file` (a link, a looser mode, over the cap) or `registry` (not this shape).
 */
export function readRegistry(env = process.env) {
  const text = readPrivateFile(join(accountsDir(env), REGISTRY_FILE), REGISTRY_MAX_BYTES);
  return text === null ? { default: null, accounts: {} } : parseRegistry(text);
}

/**
 * Replaces accounts.json.
 * @param {object} registry what `readRegistry` returns, changed.
 * @param {object} env see `accountsDir`.
 * @throws {AccountError} kind `registry` when it is not the shape or over the cap, `unsafe-file` when the folder is open to others.
 */
export function writeRegistry(registry, env = process.env) {
  const text = `${JSON.stringify(parseRegistry(JSON.stringify(registry)), null, INDENT_SPACES)}\n`;
  if (Buffer.byteLength(text) > REGISTRY_MAX_BYTES) throw new AccountError('registry', `${REGISTRY_FILE} would be larger than ${REGISTRY_MAX_BYTES} bytes; not written`);
  const dir = accountsDir(env);
  ensurePrivateDir(dir);
  assertPrivateDir(dir);
  writeFileAtomic(join(dir, REGISTRY_FILE), text);
}
