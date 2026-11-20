// Purpose: the token store of Linux (and of a run that forces it): one file `<name>.token` per account in the accounts
// folder. The same kind of store as Claude Code's own `.credentials.json` there: a 0600 file, not stronger.
// Exports: fileStore, TOKEN_FILE_SUFFIX.
// Invariants: the folder is 0700 and each file 0600 from the moment it is made (never chmod afterwards); a write
// replaces the file whole through a temp file and a rename, which replaces a link instead of following it; a read
// refuses a link, a looser mode, a folder open to others and content that is not one token.
import { lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDir, writeFileAtomic } from '../../recall/lib/private-fs.mjs';
import { assertName, assertToken } from './names.mjs';
import { assertPrivateDir, readPrivateFile } from './private-file.mjs';

export const TOKEN_FILE_SUFFIX = '.token';
const TOKEN_FILE_MAX_BYTES = 1024;

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
 * @returns {{kind: 'file', put: (name: string, token: string) => void, get: (name: string) => string | null, remove: (name: string) => boolean}}
 *   `get` returns null for an account with no file; each method throws AccountError (`name`, `token`, `unsafe-file`).
 */
export function fileStore(dir) {
  const fileOf = (name) => join(dir, `${assertName(name)}${TOKEN_FILE_SUFFIX}`);
  return {
    kind: 'file',
    put(name, token) {
      const path = fileOf(name);
      assertToken(token);
      ensurePrivateDir(dir);
      assertPrivateDir(dir);
      writeFileAtomic(path, `${token}\n`);
    },
    get(name) {
      const path = fileOf(name);
      if (!exists(dir)) return null;
      assertPrivateDir(dir);
      const text = readPrivateFile(path, TOKEN_FILE_MAX_BYTES);
      return text === null ? null : assertToken(text.replace(/\n$/, ''));
    },
    remove(name) {
      const path = fileOf(name);
      if (!exists(path)) return false;
      rmSync(path);
      return true;
    },
  };
}
