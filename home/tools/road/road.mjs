#!/usr/bin/env node
// Purpose: CLI of a road of steps (spec-stages; README.md beside this file): check the road file, write its STATUS rows, say what the next
//   step runs, gate a finished step, and join a lane (the contract judging of a built lane).
// Usage: road.mjs check <road.json>
//        road.mjs rows <road.json> [--base <sha>] [--fix <N> <name>]
//        road.mjs next <road.json> --budget <1-5>
//        road.mjs gate <road.json> [--step <N>]
//        road.mjs join <road.json> --road-sha256 <hex> --lane <name> --worktree <abs> --base <40-hex> [--tests <abs>] [--dispute] [--checks <cat,...>] [--json]
// Exit: 0 ok / PASS, 1 refused / FAIL (also `next` printing `baseline needed: <road>.s<N>`), 2 usage (also `next` without --budget or
//   outside 1-5, and a --base sha that is not an ancestor of the base tip or that already holds a landed patch of the road). `join`: 0 joined
//   clean, 3 joined with findings, 1 refused, 2 usage (lib/road-join.mjs).
// Exports: runRoad(argv, { run, isUiPath, now }) -> { code, out }.
// Invariants: the road's STATUS.md is the file beside the road file; rows are added only through status.mjs's runStatus and read only with
//   the estimator's parseWorkItems (no second parser, P12). Every subprocess runs without a shell, with its own timeout (road-gate.mjs).
//   The main guard compares real paths, so the CLI works through the ~/.claude link.
import { spawnSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseWorkItems } from '../estimate/lib/items.mjs';
import { readStatusFile } from '../status/status-file.mjs';
import { runStatus } from '../status/status.mjs';
import { MAX_ROW_ID_CHARS, LANE_NAME, readRoad, roadRows, uiMatrixProblems } from './lib/road-file.mjs';
import { isOn } from '../../hooks/lib/checks-on.mjs';
import { GIT_TIMEOUT_MS, gateStep } from './lib/road-gate.mjs';
import { joinLane } from './lib/road-join.mjs';
import { buildArgs, isUiLane, landedLine, roadStartTip, stepState } from './lib/road-state.mjs';

const USAGE = 'usage: road.mjs check <road.json> | rows <road.json> [--base <sha>] [--fix <N> <name>] | next <road.json> --budget <1-5> | gate <road.json> [--step <N>] | join <road.json> --road-sha256 <hex> --lane <name> --worktree <abs> --base <40-hex> [--tests <abs>] [--dispute] [--checks <cat,...>] [--json]';
const TOOLS = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL_FILES = { 'git-tidy': 'git-tidy/git-tidy.mjs', 'test-pass': 'test-pass/test-pass.mjs', 'audit-log': 'review-tier/audit-log.mjs', 'ui-proof': 'ui-proof/ui-proof.mjs' };
const HEX = /^[0-9a-f]{7,40}$/;
const OPEN_CHECK = /^([a-z][a-z0-9-]{0,7})\.s\d+\.check$/i;
const BASE_TAIL = /, base [0-9a-f]{40}$/;
const MAX_BUDGET = 5;
// The UI-file rule when the ui-proof tool is not installed: markup and style files (fail closed: more lanes count as UI, never fewer).
const FALLBACK_UI = /\.(?:tsx|jsx|vue|svelte|html?|css|scss|sass|less)$|(?:^|\/)(?:styles?|themes?)\//i;

class UsageError extends Error {}

/** Runs one program with argv, no shell; a missing tool is exit 127 with the reason. */
function runProgram(file, argv, timeoutMs) {
  const [command, args] = file === 'git' ? ['git', argv] : [process.execPath, [join(TOOLS, TOOL_FILES[file]), ...argv]];
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 << 20 });
  if (result.error) return { exit: 127, out: result.error.message };
  return { exit: result.status ?? 128, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

async function loadUiPath() {
  try {
    const { isUiPath } = await import('../ui-proof/lib/ui-files.mjs');
    return (file) => isUiPath(file, true);
  } catch {
    return (file) => FALLBACK_UI.test(file);
  }
}

function loadRoad(path) {
  if (typeof path !== 'string' || path.startsWith('--')) throw new UsageError(USAGE);
  const file = resolve(path);
  const read = readRoad(file);
  return { file, statusFile: join(dirname(file), 'STATUS.md'), ...read };
}

/** The rows of the road's STATUS.md; [] when it does not exist yet (rows makes it through runStatus). */
function itemsOf(statusFile) {
  let read;
  try {
    read = readStatusFile(statusFile);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (read.text === undefined) throw new Error(`${statusFile} ${read.refused ?? 'cannot be read'}`);
  return parseWorkItems(read.text).items;
}

function flagValue(rest, name) {
  const at = rest.indexOf(name);
  if (at === -1) return undefined;
  if (rest[at + 1] === undefined || rest[at + 1].startsWith('--')) throw new UsageError(`${name} needs a value. ${USAGE}`);
  return rest[at + 1];
}

/** The base tip to write into step 1's check row: --base (checked) or the current tip. */
function startTip(road, items, given, run) {
  const tip = run('git', ['-C', road.repo, 'rev-parse', '--verify', `refs/heads/${road.base}^{commit}`], GIT_TIMEOUT_MS);
  if (tip.exit !== 0) throw new UsageError(`cannot read ${road.base} in ${road.repo}`);
  if (given === undefined) return tip.out.trim();
  const sha = run('git', ['-C', road.repo, 'rev-parse', '--verify', `${HEX.test(given) ? given : 'not-a-sha'}^{commit}`], GIT_TIMEOUT_MS);
  if (sha.exit !== 0) throw new UsageError(`--base ${given} is not a commit`);
  const full = sha.out.trim();
  if (run('git', ['-C', road.repo, 'merge-base', '--is-ancestor', full, tip.out.trim()], GIT_TIMEOUT_MS).exit !== 0) throw new UsageError(`--base ${full} is not an ancestor of ${road.base}`);
  const holds = items.map((item) => landedLine(item.evidence)).filter(Boolean)
    .some((landed) => run('git', ['-C', road.repo, 'merge-base', '--is-ancestor', landed.to, full], GIT_TIMEOUT_MS).exit === 0);
  if (holds) throw new UsageError(`--base ${full} already holds a landed patch of the road`);
  return full;
}

/** Creates an empty STATUS.md (status.mjs adds the Work items section); an existing file is left as it is. */
function ensureStatusFile(statusFile) {
  try {
    writeFileSync(statusFile, '# STATUS\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

const sameItem = (a, b) => a === b || a.replace(BASE_TAIL, '') === b.replace(BASE_TAIL, '');

function fixRows(road, items, rest) {
  const at = rest.indexOf('--fix');
  const [n, name] = [Number(rest[at + 1]), rest[at + 2]];
  if (!Number.isInteger(n) || n < 1 || n > road.steps.length || !LANE_NAME.test(String(name))) throw new UsageError(`--fix needs a step number and a lane name. ${USAGE}`);
  const check = items.find((item) => item.id.toLowerCase() === `${road.road}.s${n}.check`);
  if (check?.done != null) return { refused: `step ${n}'s check row is done: a fix after the gate is a new step` };
  const id = `${road.road}.s${n}.fix-${name}`;
  if (`${id}-land`.length > MAX_ROW_ID_CHARS) return { refused: `${id}-land is over ${MAX_ROW_ID_CHARS} chars` };
  return { rows: [{ id, item: `rework: ${name}`, size: 'S' }, { id: `${id}-land`, item: `close: review and land fix-${name}`, size: 'M' }] };
}

function rows(road, ctx, rest, run) {
  const items = itemsOf(ctx.statusFile);
  const other = items.find((item) => item.done == null && OPEN_CHECK.test(item.id) && OPEN_CHECK.exec(item.id)[1].toLowerCase() !== road.road);
  if (other) return { code: 1, out: `refused: ${ctx.statusFile} already holds an open road (${other.id}); one open road per STATUS.md` };
  let wanted;
  if (rest.includes('--fix')) {
    const fix = fixRows(road, items, rest);
    if (fix.refused) return { code: 1, out: `refused: ${fix.refused}` };
    wanted = fix.rows;
  } else {
    wanted = roadRows(road, roadStartTip(road, items) ?? startTip(road, items, flagValue(rest, '--base'), run));
  }
  if (items.length === 0) ensureStatusFile(ctx.statusFile);
  const existing = new Map(items.map((item) => [item.id.toLowerCase(), item]));
  const clash = wanted.find((row) => existing.has(row.id.toLowerCase()) && !sameItem(existing.get(row.id.toLowerCase()).item, row.item));
  if (clash) return { code: 1, out: `refused: row ${clash.id} exists with another item; the road id ${road.road} is used by another job` };
  const added = [];
  for (const row of wanted.filter((candidate) => !existing.has(candidate.id.toLowerCase()))) {
    const result = runStatus(['--file', ctx.statusFile, 'add', row.id, row.item, row.size]);
    if (result.code !== 0) return { code: 1, out: [...added.map((id) => `added ${id}`), `refused at ${row.id}: ${result.message}`].join('\n') };
    added.push(row.id);
  }
  return { code: 0, out: [...added.map((id) => `added ${id}`), `road ${road.road}: ${added.length} rows added`].join('\n') };
}

function next(road, ctx, rest, run, isUiPath) {
  const budget = Number(flagValue(rest, '--budget'));
  if (!Number.isInteger(budget) || budget < 1 || budget > MAX_BUDGET) throw new UsageError(`next needs --budget <1-5> (your lane budget). ${USAGE}`);
  const items = itemsOf(ctx.statusFile);
  if (items.length === 0) return { code: 1, out: `no rows in ${ctx.statusFile}: run rows first` };
  const state = stepState(road, items);
  const step = road.steps[state.step - 1];
  const baseline = step.lanes.some((lane) => isUiLane(lane, isUiPath)) ? 'yes' : 'no';
  const result = { road: road.road, step: state.step, of: state.of, state: state.state, form: state.form, held: state.held, carried: state.carried,
    lanes: state.lanes.map(({ lane }) => lane.name), writers: Math.min(state.lanes.length + state.lanes.filter(({ lane }) => lane.acceptanceTests).length, budget, MAX_BUDGET), baseline };
  if (state.state === 'build' && baseline === 'yes') {
    const label = `${road.road}.s${state.step}`;
    if (run('ui-proof', ['has', '--step', label, '--repo', road.repo], GIT_TIMEOUT_MS).exit !== 0) return { code: 1, out: `${JSON.stringify(result)}\nbaseline needed: ${label}` };
  }
  const args = state.state === 'build' && state.form === 'build' ? { args: buildArgs(road, state, ctx.statusFile, budget) } : {};
  return { code: 0, out: JSON.stringify({ ...result, ...args }, null, 2) };
}

function gate(road, ctx, rest, run, isUiPath) {
  const items = itemsOf(ctx.statusFile);
  const given = flagValue(rest, '--step');
  const step = given === undefined ? stepState(road, items).step : Number(given);
  if (!Number.isInteger(step) || step < 1 || step > road.steps.length) throw new UsageError(`--step must be 1-${road.steps.length}. ${USAGE}`);
  const result = gateStep(road, items, step, run, { isUiPath, checkOn: (category) => isOn(category) }); // $CLAUDE_CODE_SESSION_ID's /check switch
  return { code: result.pass ? 0 : 1, out: [...result.lines, `road ${road.road} step ${step}: ${result.pass ? 'PASS' : 'FAIL'}`].join('\n') };
}

/**
 * Runs one road command.
 * @param {string[]} argv the arguments after the script name
 * @param {{ run?: typeof runProgram, isUiPath?: (path: string) => boolean }} [deps] injected for tests
 * @returns {Promise<{ code: number, out: string }>}
 */
export async function runRoad(argv, { run = runProgram, isUiPath = undefined } = {}) {
  const [command, path, ...rest] = argv;
  try {
    if (!['check', 'rows', 'next', 'gate', 'join'].includes(command)) throw new UsageError(USAGE);
    const ctx = loadRoad(path);
    if (ctx.road === null) return { code: 1, out: ['refused:', ...ctx.problems.map((problem) => `- ${problem}`)].join('\n') };
    const warnings = ctx.warnings.map((warning) => `WARN ${warning}`);
    const uiPath = isUiPath ?? (await loadUiPath());
    if (command === 'check') {
      const missing = uiMatrixProblems(ctx.road, uiPath);
      if (missing.length > 0) return { code: 1, out: ['refused:', ...missing.map((problem) => `- ${problem}`)].join('\n') };
      return { code: 0, out: [...warnings, `road ${ctx.road.road}: ${ctx.road.steps.length} steps, ok`].join('\n') };
    }
    if (command === 'join') return joinLane(ctx.road, ctx.sha256, rest);
    const result = command === 'rows' ? rows(ctx.road, ctx, rest, run) : command === 'next' ? next(ctx.road, ctx, rest, run, uiPath) : gate(ctx.road, ctx, rest, run, uiPath);
    return { ...result, out: [...warnings, result.out].join('\n') };
  } catch (error) {
    return { code: error instanceof UsageError ? 2 : 1, out: `road: ${error.message}` };
  }
}

// ~/.claude/tools is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { code, out } = await runRoad(process.argv.slice(2));
  ([0, 3].includes(code) ? process.stdout : process.stderr).write(`${out}\n`); // 3 = join finished with findings: its report is the output
  process.exitCode = code;
}
