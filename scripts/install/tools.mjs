// Purpose: the install steps that call other programs: the plugins of plugins/plugins.json through `claude plugin`, and the npm
//   dependencies of the tools that have them.
// Exports: runProgram, installPlugins, installToolDeps.
// Invariants: a failed plugin command never stops the install (it is listed in ctx.failures and the run exits 1 at the end);
//   a tool whose lockfile did not change since its last install is not installed again (a second run changes nothing).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { InstallError, act, note, warn } from './context.mjs';

const STAMP_NAME = '.lock-sha256'; // in node_modules: the lockfile hash of the last install

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

/** Adds the GitHub marketplaces and installs every listed plugin (gitkraken comes with the GitKraken app). */
export function installPlugins(ctx) {
  if (!hasPluginCommands()) {
    console.log('claude CLI plugin commands unavailable. Manual steps: run /plugin in Claude Code, add the marketplaces and plugins listed in plugins/plugins.json.');
    return;
  }
  const manifest = JSON.parse(readFileSync(join(ctx.root, 'plugins', 'plugins.json'), 'utf8'));
  for (const market of manifest.marketplaces ?? []) {
    if (!String(market.source).startsWith('github:')) continue;
    const source = market.source.slice('github:'.length);
    pluginStep(ctx, `marketplace ${source}`, ['plugin', 'marketplace', 'add', source]);
  }
  for (const id of [...(manifest.enabled ?? []), ...(manifest.disabled ?? [])]) {
    if (!id.endsWith('@gitkraken')) pluginStep(ctx, `plugin ${id}`, ['plugin', 'install', id]);
  }
  console.log('Note: enabled/disabled state comes from settings.json enabledPlugins. gitkraken is installed by the GitKraken app.');
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
  if (lock && existsSync(stamp) && readFileSync(stamp, 'utf8') === sha256(lock)) {
    note(ctx, `ok ${name} dependencies (lockfile unchanged)`);
    return;
  }
  const [program, args] = usePnpm ? ['pnpm', ['--dir', dir, 'install', '--frozen-lockfile']] : lock ? ['npm', ['ci', '--prefix', dir]] : ['npm', ['install', '--prefix', dir, '--no-audit', '--no-fund']];
  const result = act(ctx, `${program} ${args.join(' ')}`, () => runProgram(program, args));
  if (result && result.status !== 0) throw new InstallError(`${name} dependencies: ${program} exited ${result.status}`);
  if (result && lock && existsSync(join(dir, 'node_modules'))) writeFileSync(stamp, sha256(lock));
  note(ctx, `${name} dependencies`);
}

/** Installs the dependencies of each named tool of the root's home/tools. */
export function installToolDeps(ctx, names) {
  for (const name of names) installOneTool(ctx, name);
}
