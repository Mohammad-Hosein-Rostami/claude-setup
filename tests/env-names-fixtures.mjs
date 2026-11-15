// Shared helpers for the env-names tests: temp project folders built from a {path: content} map, the CLI runner, and the
// planted marker values. Exports: CLI, MARKERS, makeProject(files), run(args, cwd), leaked(text), everythingPrinted(files).
// Invariant: every value planted in a fixture contains one of MARKERS, so `leaked(output)` finds any value that escaped.
// Fails at import, with one line, when the tool's yaml dependency is missing.
// Markers are made-up words, never a real secret format (the pre-commit hook runs gitleaks).
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { yamlParserInstalled } from '../home/tools/env-names/lib/deploy-yaml-names.mjs';

// A worktree without `npm ci` would fail dozens of tests one by one; stop at the first import with the one fix instead.
if (!yamlParserInstalled) {
  console.error('yaml is not installed for env-names: run npm ci --prefix home/tools/env-names');
  process.exit(1);
}

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

/** Everything the tool prints for a project: list text, list --json, the saved snapshot, and diff text and --json, as one string. */
export async function everythingPrinted(files) {
  const dir = await makeProject(files);
  const snapshot = join(dir, '..', `printed-${Math.random().toString(36).slice(2)}.json`);
  const outputs = [run(['list', dir, '--save', snapshot]), run(['list', dir, '--json']), run(['diff', snapshot, dir]), run(['diff', snapshot, dir, '--json'])];
  return { dir, text: `${outputs.map((out) => out.all).join('\n')}\n${await readFile(snapshot, 'utf8')}` };
}
