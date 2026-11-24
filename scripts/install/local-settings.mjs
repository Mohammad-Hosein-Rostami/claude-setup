#!/usr/bin/env node
// Purpose: this machine's own values in the git-ignored settings/local.json, for the sync script (scripts/sync-machines.mjs):
//   the sync targets, the phase's CLI pin, and the values that are not machine-specific, which the sync copies to each target.
// Usage: node scripts/install/local-settings.mjs targets             (prints {machine, cliVersion, targets, defaulted} as JSON)
//        node scripts/install/local-settings.mjs shared <out.json>   (writes the keys `claudeSetup.shared` names)
//        node scripts/install/local-settings.mjs merge-shared <in.json>  (merges such a file into this machine's local.json)
// Exports: readLocal, syncConfig, sharedPart, mergeShared.
// Invariants: local.json's `claudeSetup` key (dropped from settings.json by merge-settings.jq) is validated before use: a target
//   name or ssh host that is not a plain word is refused (it goes into ssh and scp commands); without targets the one target is
//   `pc` over `ssh pc` (the two-machine default) and `defaulted` says so. merge-shared never touches `claudeSetup` and never
//   copies a machine-specific key; nothing here is pushed anywhere.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCAL = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'settings', 'local.json');
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const DEFAULT_TARGETS = [{ name: 'pc', ssh: 'pc' }];
const NEVER_SHARED = new Set(['claudeSetup', 'env']); // env holds the machine's pin (DISABLE_UPDATES) and paths

/** local.json as an object ({} when missing); throws on invalid JSON (fail fast: a broken file must be fixed). */
export function readLocal(path = LOCAL) {
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: not a JSON object`);
  return value;
}

function checkTarget(target, index) {
  if (!NAME.test(target?.name ?? '')) throw new Error(`claudeSetup.syncTargets[${index}].name must be a short lower-case word`);
  if (!HOST.test(target.ssh ?? '')) throw new Error(`claudeSetup.syncTargets[${index}].ssh must be an ssh host name`);
  return { name: target.name, ssh: target.ssh };
}

/**
 * The sync's view of local.json.
 * @param {object} local the parsed local.json
 * @returns {{machine: string, cliVersion: string, targets: {name: string, ssh: string}[], defaulted: boolean}}
 * @throws {Error} for a bad target, machine name or pin
 */
export function syncConfig(local) {
  const setup = local.claudeSetup ?? {};
  const machine = setup.machine ?? 'mac';
  if (!NAME.test(machine)) throw new Error('claudeSetup.machine must be a short lower-case word');
  if (setup.cliVersion !== undefined && !VERSION.test(setup.cliVersion)) throw new Error('claudeSetup.cliVersion must be x.y.z');
  const given = Array.isArray(setup.syncTargets) && setup.syncTargets.length > 0;
  const targets = given ? setup.syncTargets.map(checkTarget) : DEFAULT_TARGETS;
  return { machine, cliVersion: setup.cliVersion ?? '', targets, defaulted: !given };
}

/** The keys of local.json that `claudeSetup.shared` names (never claudeSetup or env). */
export function sharedPart(local) {
  const keys = (local.claudeSetup?.shared ?? []).filter((key) => typeof key === 'string' && !NEVER_SHARED.has(key) && key in local);
  return Object.fromEntries(keys.map((key) => [key, local[key]]));
}

/** `local` with the shared values of another machine laid over it; claudeSetup and env stay this machine's. */
export function mergeShared(local, shared) {
  const kept = Object.fromEntries(Object.entries(shared).filter(([key]) => !NEVER_SHARED.has(key)));
  return { ...local, ...kept };
}

function run([command, file]) {
  const local = readLocal();
  if (command === 'targets') console.log(JSON.stringify(syncConfig(local)));
  else if (command === 'shared' && file) writeFileSync(file, `${JSON.stringify(sharedPart(local), null, 2)}\n`);
  else if (command === 'merge-shared' && file) writeFileSync(LOCAL, `${JSON.stringify(mergeShared(local, readLocal(file)), null, 2)}\n`);
  else throw new Error('usage: local-settings.mjs targets | shared <out.json> | merge-shared <in.json>');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    console.error(`local-settings: ${error.message}`);
    process.exitCode = 1;
  }
}
