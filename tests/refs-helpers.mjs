// Shared fixtures for the refs tests: build a project folder from {path: text}, run the CLI on it.
// Exports: project, refs, findingLines, CLI.
// Invariants: every project is a fresh temp folder; tests only use made-up content.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';

export const CLI = fileURLToPath(new URL('../home/tools/refs/refs.mjs', import.meta.url));

/** Builds a temp folder from {path: text} and returns its path. */
export function project(files) {
  const root = makeTempDir('refs-');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Runs `refs check <root> ...extra` and returns the spawn result. */
export const refs = (root, ...extra) => spawnSync(process.execPath, [CLI, 'check', root, ...extra], { encoding: 'utf8', maxBuffer: 64 << 20 });

/** The output lines without the summary line. */
export const findingLines = (result) => result.stdout.split('\n').filter((line) => line !== '' && !line.startsWith('refs: '));
