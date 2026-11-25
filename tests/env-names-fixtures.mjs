// Shared helpers for the env-names tests: temp project folders built from a {path: content} map, the CLI runner, and the
// planted marker values. Exports: CLI, MARKERS, makeProject(files), run(args, cwd), runAsync(args, cwd), leaked(text),
// everythingPrinted(files), everythingPrintedAsync(files).
// Invariant: every value planted in a fixture contains one of MARKERS, so `leaked(output)` finds any value that escaped.
// Fails at import, with one line, when the tool's yaml dependency is missing.
// Markers are made-up words, never a real secret format (the pre-commit hook runs gitleaks).
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { yamlParserInstalled } from '../home/tools/env-names/lib/deploy-yaml-names.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';

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
  const dir = makeTempDir('env-names-');
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

/**
 * `run` that does not block, so a test can run the CLI for independent projects side by side (the CLI's own work is the same).
 * @returns {Promise<{status: number|null, stdout: string, stderr: string, all: string}>}
 */
export function runAsync(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr, all: `${stdout}${stderr}` }));
  });
}

/** Everything the tool prints for a project: list text, list --json, the saved snapshot, and diff text and --json, as one string. */
export async function everythingPrinted(files) {
  const dir = await makeProject(files);
  const snapshot = join(makeTempDir('sibling-'), `printed-${Math.random().toString(36).slice(2)}.json`);
  const outputs = [run(['list', dir, '--save', snapshot]), run(['list', dir, '--json']), run(['diff', snapshot, dir]), run(['diff', snapshot, dir, '--json'])];
  return { dir, text: `${outputs.map((out) => out.all).join('\n')}\n${await readFile(snapshot, 'utf8')}` };
}

/** everythingPrinted through runAsync: the same four calls, one after the other (the diff reads the saved snapshot). */
export async function everythingPrintedAsync(files) {
  const dir = await makeProject(files);
  const snapshot = join(makeTempDir('sibling-'), `printed-${Math.random().toString(36).slice(2)}.json`);
  const outputs = [];
  for (const args of [['list', dir, '--save', snapshot], ['list', dir, '--json'], ['diff', snapshot, dir], ['diff', snapshot, dir, '--json']]) outputs.push(await runAsync(args));
  return { dir, text: `${outputs.map((out) => out.all).join('\n')}\n${await readFile(snapshot, 'utf8')}` };
}
