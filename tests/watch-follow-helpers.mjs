// Shared by the tests that run the real watch.mjs in follow mode on a synthetic transcript in a temp HOME.
// Exports: SESSION, STAMP, entry(value), startWatcher(t, options) -> running watcher with output(), append(), appendUntilExit(), waitForExit().
// The watcher starts at the end of the file, so a test appends after START_SETTLE_MS (its first look) or repeats a one-line event.
import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI = fileURLToPath(new URL('../home/tools/watch/watch.mjs', import.meta.url));
export const SESSION = 'eeeeeeee-1111-2222-3333-444444444444';
export const STAMP = '2026-11-14T10:00:00.000Z';
export const START_SETTLE_MS = 2500;
const REPEAT_MS = 300;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One JSONL line with the fixed timestamp unless the value brings its own. */
export const entry = (value) => `${JSON.stringify({ timestamp: STAMP, ...value })}\n`;

/**
 * @param {import('node:test').TestContext} t cleans up the temp HOME and kills the child
 * @param {{ transcript?: string, args?: string[], settle?: boolean, prepare?: Function }} options file content at start; flags after the
 *   session id; wait for the first look at the file; `prepare({ dir, home, path })` runs before the watcher starts
 * @returns {Promise<object>} dir, home, path, guardLog, child, output(), errors(), append(text), appendUntilExit(text, ms), waitForExit(ms)
 */
export async function startWatcher(t, { transcript = '', args = ['--exit-on-event'], settle = false, prepare } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'watch-follow-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const project = join(home, '.claude', 'projects', '-proj');
  await mkdir(project, { recursive: true });
  const path = join(project, `${SESSION}.jsonl`);
  const guardLog = join(dir, 'guard.jsonl');
  await writeFile(path, transcript);
  await writeFile(guardLog, '');
  await prepare?.({ dir, home, path });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const child = spawn(process.execPath, [CLI, SESSION, '--guard-log', guardLog, ...args], { env });
  t.after(() => child.kill());
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  if (settle) await sleep(START_SETTLE_MS);
  const append = (text, file = path) => appendFile(file, text);
  // Appends `text` every REPEAT_MS until the watcher exits or `ms` pass; resolves to the exit code, or undefined when it kept running.
  const appendUntilExit = async (text, ms, file = path) => {
    const deadline = Date.now() + ms;
    while (child.exitCode === null && Date.now() < deadline) { await append(text, file); await sleep(REPEAT_MS); }
    return child.exitCode === null ? undefined : closed;
  };
  const waitForExit = async (ms) => {
    const deadline = Date.now() + ms;
    while (child.exitCode === null && Date.now() < deadline) await sleep(REPEAT_MS);
    return child.exitCode === null ? undefined : closed;
  };
  return { dir, home, path, guardLog, child, output: () => stdout, errors: () => stderr, append, appendUntilExit, waitForExit, closed };
}
