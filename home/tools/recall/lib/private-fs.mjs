// Purpose: owner-only file helpers for recall's state (checkpoint notes state, locks, reranker pid file, usage log):
// directories 0700, files 0600, and whole-file replacement that a concurrent reader never sees half written.
// Exports: ensurePrivateDir, writeFileAtomic, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE.
// Invariants: node builtins only (the checkpoint hook imports this and must start fast); `writeFileAtomic` writes a
// unique temp file in the same directory and renames it over the target (rename is atomic on one filesystem).
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** mkdir -p with mode 0700 (an existing directory keeps its mode). */
export const ensurePrivateDir = (dir) => mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });

/**
 * Replace `path` with `text` atomically, file mode 0600.
 * @param {string} path target file.
 * @param {string} text new content.
 * @throws when the temp file cannot be written or renamed (the temp file is removed).
 */
export function writeFileAtomic(path, text) {
  const temp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    writeFileSync(temp, text, { mode: PRIVATE_FILE_MODE });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
