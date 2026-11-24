// Tests for `install --dry-run` (scripts/install.mjs): it names the git hooksPath it would set and the settings layers it would
// merge, and still changes nothing. Exports: none (node:test file). The installer runs with HOME set to a temp folder and with
// --no-plugins --no-tools (needs jq, like every install); the settings-layer cases use fake checkouts in temp folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OS_NAME } from '../scripts/install/context.mjs';
import { settingsLayersLine } from '../scripts/install/settings.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const INSTALLER = join(REPO, 'scripts', 'install.mjs');
const HOOKS_LINE = 'would set: git config core.hooksPath .githooks';
const hooksPath = () => spawnSync('git', ['-C', REPO, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).stdout;

test('--dry-run prints the hooksPath it would set and the settings layers, and changes nothing', () => {
  const home = makeTempDir('install-dry-run-');
  const before = hooksPath();
  const run = spawnSync(process.execPath, [INSTALLER, '--dry-run', '--no-plugins', '--no-tools'], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.includes(HOOKS_LINE), run.stdout);
  assert.match(run.stdout, new RegExp(`settings layers: settings/base\\.json \\+ settings/${OS_NAME}\\.json(?: \\+ settings/local\\.json)?\\n`));
  assert.ok(run.stdout.includes('(dry-run: nothing changed)'));
  assert.ok(run.stdout.includes(`write ${join(home, '.claude', 'CLAUDE.md')}: @${join(REPO, 'home', 'CLAUDE.md')}`), 'the generated CLAUDE.md is named, not made');
  assert.deepEqual(readdirSync(home), [], 'no file or folder under HOME: no ~/.claude, no backup, no lock, no start-up line');
  assert.equal(hooksPath(), before, 'git config core.hooksPath is as it was');
});

/** A fake checkout with the settings files named in `names`. */
function checkout(names) {
  const dir = makeTempDir('install-layers-');
  mkdirSync(join(dir, 'settings'));
  for (const name of names) writeFileSync(join(dir, 'settings', name), '{}');
  return dir;
}
const context = (root, repo = root) => ({ root, repo, os: 'macos' });

test('the layers line lists only the files that exist: no local.json, no line for it', () => {
  const dir = checkout(['base.json', 'macos.json']);
  assert.equal(settingsLayersLine(context(dir), null), 'settings layers: settings/base.json + settings/macos.json');
});

test('the layers line adds settings/local.json when the repo has one (it is read from the repo, not a tag worktree)', () => {
  const tagRoot = checkout(['base.json', 'macos.json']);
  const repo = checkout(['local.json']);
  assert.equal(settingsLayersLine(context(tagRoot, repo), null), 'settings layers: settings/base.json + settings/macos.json + settings/local.json');
});

test('the layers line skips an OS file that is missing and names the machine\'s own settings.json first on a new machine', () => {
  const dir = checkout(['base.json']);
  const own = join(dir, 'own-settings.json');
  writeFileSync(own, '{}');
  assert.equal(settingsLayersLine(context(dir), null), 'settings layers: settings/base.json');
  assert.equal(settingsLayersLine(context(dir), own), "settings layers: the machine's own settings.json + settings/base.json");
});

test('long-run is a tool with dependencies: --dry-run lists `npm ci --prefix <repo>/home/tools/long-run` on darwin, linux and win32', async () => {
  const { TOOLS_WITH_DEPS } = await import('../scripts/install.mjs');
  const { installToolDeps } = await import('../scripts/install/tools.mjs');
  assert.ok(TOOLS_WITH_DEPS.includes('long-run'));
  const root = makeTempDir('install-long-run-');
  const tool = join(root, 'home', 'tools', 'long-run');
  mkdirSync(tool, { recursive: true });
  writeFileSync(join(tool, 'package-lock.json'), readFileSync(join(REPO, 'home', 'tools', 'long-run', 'package-lock.json')));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const log = console.log;
  for (const name of ['darwin', 'linux', 'win32']) {
    const printed = [];
    Object.defineProperty(process, 'platform', { ...platform, value: name });
    console.log = (line) => printed.push(String(line));
    try {
      installToolDeps({ root, dryRun: true, done: [] }, ['long-run']);
    } finally {
      console.log = log;
      Object.defineProperty(process, 'platform', platform);
    }
    assert.ok(printed.includes(`[dry-run] npm ci --prefix ${realpathSync(tool)}`), `${name}: ${printed.join('\n')}`);
  }
});
