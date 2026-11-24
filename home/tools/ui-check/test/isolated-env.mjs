// Purpose: per-test isolation for the browser-free unit files: a fresh short temp folder as HOME, USERPROFILE and TMPDIR (so
// os.homedir(), os.tmpdir() and lib/cache.mjs's default ~/.cache/figma land in it, never in the real ones), FIGMA_TOKEN unset, and
// the env, global fetch and node:test mocks restored after each test. Exports: isolateEach.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, mock } from 'node:test';

const KEYS = ['HOME', 'USERPROFILE', 'TMPDIR', 'FIGMA_TOKEN'];
// A short root: os.tmpdir() on macOS is a long /var/folders path; Windows has no /tmp.
const SHORT_ROOT = process.platform === 'win32' ? os.tmpdir() : '/tmp';

/**
 * Register beforeEach/afterEach hooks that isolate every test of the calling file.
 * @param {string} label part of the temp folder name
 * @returns {() => string} the current test's temp root (HOME, USERPROFILE and TMPDIR all point at <root>/home and <root>/tmp)
 */
export function isolateEach(label) {
  let root = '';
  let saved = {};
  let fetchBefore;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    fetchBefore = globalThis.fetch;
    root = fs.mkdtempSync(path.join(SHORT_ROOT, `cs-test-uic-${label}-`));
    for (const dir of ['home', 'tmp']) fs.mkdirSync(path.join(root, dir));
    process.env.HOME = path.join(root, 'home');
    process.env.USERPROFILE = path.join(root, 'home');
    process.env.TMPDIR = path.join(root, 'tmp');
    delete process.env.FIGMA_TOKEN;
  });
  afterEach(() => {
    mock.restoreAll();
    globalThis.fetch = fetchBefore;
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return () => root;
}
