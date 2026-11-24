// Purpose: the install steps that call other programs: the plugins the merged settings turn on, through `claude plugin`, and
//   the npm dependencies of the tools that have them.
// Exports: runProgram, enabledPluginIds, installPlugins, installToolDeps, installStamp.
// Invariants: only plugins true in the merged enabledPlugins (settings/base.json < <os>.json < local.json) are installed, and
//   only the marketplaces they come from are added; nothing is ever uninstalled or disabled here (a plugin installed earlier
//   and now off stays installed, and settings.json keeps it off); a plugins/plugins.json or merged settings that cannot be read
//   stops the install before any plugin command; a plugin id must match PLUGIN_ID_SHAPE and goes to `claude` as one argument;
//   a refused id or a failed plugin command never stops the install (it is listed in ctx.failures and the run exits 1 at the
//   end); a tool whose lockfile and Node ABI did not change since its last install is not installed again (a second run changes nothing).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { InstallError, act, note, warn } from './context.mjs';
import { mergedSettings } from './settings.mjs';

const STAMP_NAME = '.lock-sha256'; // in node_modules: `<lockfile sha256>:<Node ABI>` of the last install
// `name@marketplace`, letters, digits, `.`, `_` and `-` only: no space, quote, `;`, `$`, `%` or other shell sign, so an id is
// safe as one argument even on Windows, where runProgram passes it through a shell.
const PLUGIN_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/;
const APP_MARKETPLACE = 'gitkraken'; // its plugins come with the GitKraken app; the installer never installs them
const GITHUB_SOURCE = 'github:';

/**
 * Runs a program with fixed arguments, its output shown. On Windows npm, pnpm and claude are .cmd shims, which Node starts
 * only through a shell, so each argument is quoted there.
 * @param {string} program the command name
 * @param {string[]} args its arguments (fixed strings and paths, never secrets)
 * @param {{quiet?: boolean}} [options] quiet: capture the output instead of showing it
 * @returns {import('node:child_process').SpawnSyncReturns<string>} the result
 */
export function runProgram(program, args, { quiet = false } = {}) {
  const stdio = quiet ? 'pipe' : 'inherit';
  if (process.platform !== 'win32') return spawnSync(program, args, { stdio, encoding: 'utf8' });
  const quoted = args.map((arg) => `"${String(arg).replaceAll('"', '\\"')}"`);
  return spawnSync([program, ...quoted].join(' '), { stdio, encoding: 'utf8', shell: true });
}

const hasPluginCommands = () => runProgram('claude', ['plugin', 'marketplace', '--help'], { quiet: true }).status === 0;

const marketplaceOf = (id) => id.slice(id.indexOf('@') + 1);

/**
 * The plugin ids the settings turn on (value true in enabledPlugins), in file order, split by the name check.
 * @param {object} settings the merged settings
 * @returns {{ids: string[], refused: string[]}} ids: on and of PLUGIN_ID_SHAPE; refused: on but not of that shape
 * @throws {InstallError} when enabledPlugins is there but not an object (no key: nothing is on)
 */
export function enabledPluginIds(settings) {
  const enabled = settings.enabledPlugins === undefined ? {} : settings.enabledPlugins;
  if (typeof enabled !== 'object' || enabled === null || Array.isArray(enabled)) {
    throw new InstallError('the merged settings hold an enabledPlugins that is not an object; no plugin was installed: fix the settings files and run the install again');
  }
  const on = Object.entries(enabled).filter(([, value]) => value === true).map(([id]) => id);
  return { ids: on.filter((id) => PLUGIN_ID_SHAPE.test(id)), refused: on.filter((id) => !PLUGIN_ID_SHAPE.test(id)) };
}

/**
 * The marketplace list of plugins/plugins.json.
 * @throws {InstallError} when the file cannot be read, is not JSON, or its marketplaces is not a list
 */
function readMarketplaces(ctx) {
  const path = join(ctx.root, 'plugins', 'plugins.json');
  const why = (reason) => new InstallError(`${path} ${reason}; no plugin was installed: fix the file and run the install again`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw why(`cannot be read (${error.message})`);
  }
  const markets = manifest?.marketplaces ?? [];
  if (!Array.isArray(markets)) throw why('holds a "marketplaces" that is not a list');
  return markets;
}

/** The `owner/repo` of each GitHub marketplace in `markets` that one of `ids` comes from. */
function neededGithubSources(markets, ids) {
  const needed = new Set(ids.map(marketplaceOf));
  return markets
    .filter((market) => needed.has(market?.name) && String(market?.source).startsWith(GITHUB_SOURCE))
    .map((market) => market.source.slice(GITHUB_SOURCE.length));
}

/**
 * Installs the plugins the merged settings turn on, after adding the GitHub marketplaces they come from. A plugin that is
 * off is not installed; one installed earlier is left as it is (settings.json, written after this step, keeps it off).
 * @param {object} ctx the run context (root: plugins.json and the base and OS layers; repo: settings/local.json)
 * @throws {InstallError} when plugins.json or the merged settings cannot be read (before any plugin command)
 */
export function installPlugins(ctx) {
  const markets = readMarketplaces(ctx);
  const { ids, refused } = enabledPluginIds(mergedSettings(ctx, null));
  for (const id of refused) {
    const label = `plugin ${JSON.stringify(id)} refused: not a name@marketplace id of letters, digits, '.', '_' and '-'`;
    ctx.failures.push(label);
    warn(label);
  }
  const wanted = ids.filter((id) => marketplaceOf(id) !== APP_MARKETPLACE);
  if (wanted.length === 0) {
    console.log('No plugin to install: the merged settings (enabledPlugins) turn none on.');
    return;
  }
  if (!hasPluginCommands()) {
    console.log(`claude CLI plugin commands unavailable. Manual steps: run /plugin in Claude Code and install ${wanted.join(', ')}.`);
    return;
  }
  for (const source of neededGithubSources(markets, wanted)) pluginStep(ctx, `marketplace ${source}`, ['plugin', 'marketplace', 'add', source]);
  for (const id of wanted) pluginStep(ctx, `plugin ${id}`, ['plugin', 'install', id]);
  console.log(`Plugins: only the ${wanted.length} the merged settings turn on; one installed earlier and now off stays installed and off. gitkraken comes with the GitKraken app.`);
}

function pluginStep(ctx, label, args) {
  const result = act(ctx, `claude ${args.join(' ')}`, () => runProgram('claude', args));
  if (result && result.status !== 0) {
    ctx.failures.push(`${label} (exit ${result.status})`);
    warn(`${label} failed (exit ${result.status})`);
    return;
  }
  note(ctx, label);
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * The stamp of an install: the lockfile hash and the Node ABI (`process.versions.modules`), so a Node upgrade that changes the
 * ABI rebuilds native modules such as better-sqlite3 once. An older stamp without the `:<ABI>` part never matches.
 * @param {string} lock the lockfile path
 * @returns {string} `<sha256>:<abi>`
 */
export const installStamp = (lock) => `${sha256(lock)}:${process.versions.modules}`;

/**
 * Installs one tool's dependencies from its lockfile (pnpm when it has a pnpm lockfile and pnpm is there, else npm ci); a plain
 * npm install without one. The real path is used: npm ci through a linked folder reports a false lockfile mismatch.
 * @throws {InstallError} when the install fails
 */
function installOneTool(ctx, name) {
  const dir = realpathSync(join(ctx.root, 'home', 'tools', name));
  const pnpmLock = join(dir, 'pnpm-lock.yaml');
  const npmLock = join(dir, 'package-lock.json');
  const usePnpm = existsSync(pnpmLock) && runProgram('pnpm', ['--version'], { quiet: true }).status === 0;
  const lock = usePnpm ? pnpmLock : existsSync(npmLock) ? npmLock : null;
  const stamp = join(dir, 'node_modules', STAMP_NAME);
  if (lock && existsSync(stamp) && readFileSync(stamp, 'utf8') === installStamp(lock)) {
    note(ctx, `ok ${name} dependencies (lockfile and Node ABI unchanged)`);
    return;
  }
  const [program, args] = usePnpm ? ['pnpm', ['--dir', dir, 'install', '--frozen-lockfile']] : lock ? ['npm', ['ci', '--prefix', dir]] : ['npm', ['install', '--prefix', dir, '--no-audit', '--no-fund']];
  const result = act(ctx, `${program} ${args.join(' ')}`, () => runProgram(program, args));
  if (result && result.status !== 0) throw new InstallError(`${name} dependencies: ${program} exited ${result.status}`);
  if (result && lock && existsSync(join(dir, 'node_modules'))) writeFileSync(stamp, installStamp(lock));
  note(ctx, `${name} dependencies`);
}

/** Installs the dependencies of each named tool of the root's home/tools. */
export function installToolDeps(ctx, names) {
  for (const name of names) installOneTool(ctx, name);
}
