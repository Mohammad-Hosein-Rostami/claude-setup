// Shared helpers for the env-names tests: temp project folders built from a {path: content} map, the CLI runner, and the
// planted marker values. Exports: CLI, MARKERS, makeProject(files), run(args, cwd), leaked(text).
// Invariant: every value planted in a fixture contains one of MARKERS, so `leaked(output)` finds any value that escaped.
// Markers are made-up words, never a real secret format (the pre-commit hook runs gitleaks).
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI = fileURLToPath(new URL('../home/tools/env-names/env-names.mjs', import.meta.url));
export const MARKERS = ['MARKER_VALUE', 'MARKERVALUE', 'MARKER_PART', 'MARKER_COMMENT', 'MARKER_QUOTED', 'MARKER_COMPOSE', 'Zqx'];

// PEM lines are built from parts so no file holds a complete private-key header (the pre-commit gitleaks rule would flag it).
export const PEM_BEGIN = `-----BEGIN ${'PRIVATE'} KEY-----`;
export const PEM_END = `-----END ${'PRIVATE'} KEY-----`;

/** The markers found in `text` (empty when nothing leaked). */
export const leaked = (text) => MARKERS.filter((marker) => text.includes(marker));

/** Creates a temp folder holding `files` ({ 'a/b.txt': string | Buffer }) and returns its path. */
export async function makeProject(files) {
  const dir = await mkdtemp(join(tmpdir(), 'env-names-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

/** Runs the real CLI; `all` is stdout and stderr together. */
export function run(args, cwd) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd });
  return { ...result, all: `${result.stdout}${result.stderr}` };
}
