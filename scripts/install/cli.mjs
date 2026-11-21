// Purpose: `install --claude-version <x.y.z>`: the phase pin's CLI install with the Windows trap closed (changes I30, #111067):
//   `claude install <v>` can fail and leave no `claude`, so the old binary is kept aside first, `claude --version` runs right
//   after the install, and the old binary goes back when the version is not the one asked for.
// Exports: CLI_FLOOR, claudeVersion, installClaude.
// Invariants: never below the floor (2.1.326: it covers Windows' 2.1.316 and every platform's 2.1.323); DISABLE_UPDATES, which
//   blocks `claude install` too, is cleared for the child and, for the length of the install only, out of ~/.claude/settings.json
//   (the file is put back byte for byte, failure or not); the kept copy is deleted once the new version answers.
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { InstallError, act, note } from './context.mjs';

export const CLI_FLOOR = '2.1.326';
const CLI_TIMEOUT_MS = 10 * 60 * 1000; // a native install downloads about 200 MB
const VERSION = /(\d+\.\d+\.\d+)/;

const atLeast = (version, floor) => {
  const [a, b] = [version, floor].map((text) => text.split('.').map(Number));
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index];
  return true;
};

function childEnv(env) {
  const { DISABLE_UPDATES, ...rest } = env;
  return rest;
}

/** The path of the `claude` on PATH, or null. */
function claudeOnPath(ctx) {
  const finder = ctx.os === 'windows' ? spawnSync('where', ['claude'], { encoding: 'utf8' }) : spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' });
  const first = finder.status === 0 ? finder.stdout.split(/\r?\n/).find(Boolean) : '';
  return first ? first.trim() : null;
}

/** The version `claude --version` prints, or '' when it does not run. */
export function claudeVersion(ctx) {
  const run = spawnSync('claude', ['--version'], { encoding: 'utf8', shell: ctx.os === 'windows', timeout: 30000 });
  return run.status === 0 ? (VERSION.exec(run.stdout) ?? [])[1] ?? '' : '';
}

/** Runs `change` with env.DISABLE_UPDATES out of ~/.claude/settings.json, then puts the file back as it was. */
function withoutSettingsPin(ctx, change) {
  const path = join(ctx.claudeDir, 'settings.json');
  const before = existsSync(path) ? readFileSync(path) : null;
  let settings = null;
  try {
    settings = before ? JSON.parse(before.toString('utf8')) : null;
  } catch {
    settings = null; // not JSON: left as it is
  }
  if (!settings?.env?.DISABLE_UPDATES) return change();
  delete settings.env.DISABLE_UPDATES;
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  try {
    return change();
  } finally {
    writeFileSync(path, before);
  }
}

function keepOld(ctx, oldPath) {
  if (!oldPath) return null;
  const real = realpathSync(oldPath);
  const kept = join(ctx.backupDir, 'claude-binary', `claude-${Date.now()}`);
  mkdirSync(dirname(kept), { recursive: true });
  copyFileSync(real, kept);
  return { path: oldPath, kept };
}

function restoreOld(old) {
  rmSync(old.path, { force: true });
  mkdirSync(dirname(old.path), { recursive: true });
  copyFileSync(old.kept, old.path);
}

/**
 * Installs Claude Code `version` and proves it answers; else restores the old binary.
 * @param {object} ctx the run context (claudeVersion, os, env, claudeDir, backupDir)
 * @throws {InstallError} exit 2 below the floor; 1 when the install did not give that version (the old binary is back)
 */
export function installClaude(ctx) {
  const wanted = ctx.claudeVersion;
  if (!atLeast(wanted, CLI_FLOOR)) throw new InstallError(`--claude-version ${wanted} is below the floor ${CLI_FLOOR}`, 2);
  if (claudeVersion(ctx) === wanted) {
    note(ctx, `ok claude ${wanted}`);
    return;
  }
  act(ctx, `claude install ${wanted}, then claude --version`, () => {
    const old = keepOld(ctx, claudeOnPath(ctx));
    withoutSettingsPin(ctx, () => spawnSync('claude', ['install', wanted], { stdio: 'inherit', env: childEnv(ctx.env), shell: ctx.os === 'windows', timeout: CLI_TIMEOUT_MS }));
    const found = claudeVersion(ctx);
    if (found === wanted) {
      if (old) rmSync(old.kept, { force: true });
      note(ctx, `claude ${wanted} installed (claude --version answers ${found}); set DISABLE_UPDATES=1 again for the phase pin`);
      return;
    }
    if (old) restoreOld(old);
    throw new InstallError(`claude install ${wanted} left ${found ? `version ${found}` : 'no working claude'}; ${old ? `restored the old binary at ${old.path}` : 'there was no old binary to restore'}`);
  });
}
