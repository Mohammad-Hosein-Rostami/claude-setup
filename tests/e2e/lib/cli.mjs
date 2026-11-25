// The e2e runner's command line and its scenario list. Exports: SCENARIO_IDS, LIVE_SWITCH, USAGE, UsageError, parseArgs(argv,
// defaults), loadScenarios(ids), liveAllowed(env).
// Why: a usage error (an unknown flag or scenario id, a missing value, no selection) must end the runner with exit 2 before
// anything is made or started, and a live run (real `claude` sessions on the owner's subscription) must never start without the
// owner's switch, so a slip of `--all` in a script costs nothing (plan Lane C: the skip switch).
// Invariants: parsing only reads argv; `--list` and `--dry-run` need no switch (they start nothing); E11 (the leak check over the
// whole run) always runs last.
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Every scenario, in run order (plan section 9). */
export const SCENARIO_IDS = Object.freeze(['E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9', 'E10', 'E11']);
/** The owner's switch for a live run: only `CS_E2E_LIVE=1` starts real sessions. */
export const LIVE_SWITCH = 'CS_E2E_LIVE';
const SCENARIO_KEYS = ['id', 'title', 'model', 'minutes', 'needsShims', 'setup', 'run', 'check'];

export const USAGE = `usage: node tests/e2e/run.mjs --list
       node tests/e2e/run.mjs --dry-run [--only <id,...> | --all] [--setup-from <checkout>] [--real-home]
       ${LIVE_SWITCH}=1 node tests/e2e/run.mjs (--only <id,...> | --all) [--out <dir>] [--setup-from <checkout>] [--real-home]
         [--no-stored-login]
  --list         the scenarios, one per line
  --dry-run      print every setup step and the exact command lines; start nothing (no ${LIVE_SWITCH} needed)
  --only E0,E7   run these scenarios (ids: ${SCENARIO_IDS.join(' ')})
  --all          run every scenario
  --out <dir>    where results.json and the redacted logs go (default: a new folder in the temp root)
  --setup-from   the checkout under test (default: the one this runner is in)
  --real-home    the children use the real HOME instead of a temp one (only with the owner's OK; E9 needs it)
  --no-stored-login  without CLAUDE_CODE_OAUTH_TOKEN, do not read the claude-account store; the preflight decides
exit: 0 every check passed, 1 a check failed or did not run, 2 usage error, no ${LIVE_SWITCH}=1 or no login, 3 stopped at a usage limit`;

/** A command line the runner cannot run (exit 2). */
export class UsageError extends Error {}

const VALUE_FLAGS = new Set(['--only', '--out', '--setup-from']);
const SWITCH_FLAGS = new Set(['--list', '--dry-run', '--all', '--real-home', '--no-stored-login', '--help']);

/**
 * @param {string[]} argv the arguments after the script
 * @param {{setupFrom: string}} defaults the checkout this runner is in
 * @returns {{mode: 'help' | 'list' | 'dry' | 'live', ids: string[], out: string | null, setupFrom: string, realHomeMode: boolean,
 *   storedLogin: boolean}}
 * @throws {UsageError}
 */
export function parseArgs(argv, { setupFrom }) {
  const flags = new Map();
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at];
    if (SWITCH_FLAGS.has(arg)) flags.set(arg, true);
    else if (VALUE_FLAGS.has(arg)) {
      const value = argv[at + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      flags.set(arg, value);
      at += 1;
    } else throw new UsageError(`unknown argument: ${arg}`);
  }
  if (flags.has('--help')) return { mode: 'help', ids: [], out: null, setupFrom, realHomeMode: false, storedLogin: true };
  if (flags.has('--only') && flags.has('--all')) throw new UsageError('--only and --all cannot both be given');
  const ids = flags.has('--only') ? selectIds(flags.get('--only')) : [...SCENARIO_IDS];
  const mode = flags.has('--list') ? 'list' : flags.has('--dry-run') ? 'dry' : 'live';
  if (mode === 'live' && !flags.has('--only') && !flags.has('--all')) throw new UsageError('name the scenarios: --only <id,...> or --all');
  const from = flags.get('--setup-from') ?? setupFrom;
  if (!existsSync(join(from, 'home', 'agents'))) throw new UsageError(`--setup-from ${from} is not a claude-setup checkout (no home/agents)`);
  return { mode, ids, out: flags.get('--out') ?? null, setupFrom: realpathSync(from), realHomeMode: flags.has('--real-home'),
    storedLogin: !flags.has('--no-stored-login') };
}

/** @returns {string[]} the named ids in run order (E11 last) @throws {UsageError} for an empty list or an unknown id */
function selectIds(list) {
  const named = list.split(',').map((part) => part.trim().toUpperCase()).filter(Boolean);
  if (named.length === 0) throw new UsageError('--only needs at least one scenario id');
  const unknown = named.filter((name) => !SCENARIO_IDS.includes(name));
  if (unknown.length > 0) throw new UsageError(`unknown scenario id: ${unknown.join(', ')} (ids: ${SCENARIO_IDS.join(' ')})`);
  return SCENARIO_IDS.filter((one) => named.includes(one));
}

/** @returns {boolean} true only when the owner's switch is exactly `1` */
export const liveAllowed = (env = process.env) => env[LIVE_SWITCH] === '1';

/**
 * @param {string[]} ids
 * @returns {Promise<object[]>} the scenario modules, each checked for the full interface
 * @throws {Error} when a module lacks part of it
 */
export async function loadScenarios(ids) {
  const here = fileURLToPath(new URL('../scenarios/', import.meta.url));
  const modules = await Promise.all(ids.map((one) => import(pathToFileURL(join(here, `${one}.mjs`)).href)));
  for (const [index, module] of modules.entries()) {
    const missing = SCENARIO_KEYS.filter((key) => module[key] === undefined);
    if (missing.length > 0 || module.id !== ids[index]) throw new Error(`e2e: scenario ${ids[index]} lacks ${missing.join(', ') || 'its id'}`);
  }
  return modules;
}
