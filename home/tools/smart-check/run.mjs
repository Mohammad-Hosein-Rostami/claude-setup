// Purpose: run the smart check (spec r9-smart-check 2-8): build the plan, run the pinned checks, run each kind at its planned level
//   (cheapest first, inside one deadline), write one ledger row per check, queue skipped levels for a background run, print the report.
// Usage: node run.mjs [--cwd <dir>] [--base <ref>] [--job <kind>] [--paths a,b] [--brief-files a,b] [--seconds <n>] [--json]
//        node run.mjs --background [--seconds <n>]      (runs the queued skipped checks and writes their result as truth rows)
// Exports: runSmartCheck(options), runBackground(seconds), DEFAULT_SECONDS.
// Exit codes: 0 PASS (or nothing to check), 1 FAIL (something to act on), 2 usage.
// Invariants: never edits the project; owner-on categories are not run again (their own gates run them); a kind that did not run is
//   reported under "not checked" with its reason; the ledger holds paths, kinds, counts and results, never code text.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildPlan } from './plan.mjs';
import { appendRows, queueSkipped, takeQueue } from './ledger.mjs';
import { runPinned } from './lib/pinned.mjs';
import { runKind } from './lib/runners.mjs';
import { raiseLevel } from './lib/rules.mjs';
import { mustAct, reportBlock } from './lib/report.mjs';

export const DEFAULT_SECONDS = 300; // owner: no fixed budget, may pass 5 min when a change needs it "but this should not happen all time"
const ORDER = ['probes', 'types', 'lint', 'tests', 'review', 'build', 'visual', 'security']; // cheapest and highest yield first
const MAX_QUEUED_PER_CHANGE = 2;
const MAX_LEDGER_PATHS = 50;

/** The ledger row of one check (spec 6): change features, kind, level, reason, result, seconds, tokens. */
function ledgerRow(plan, run) {
  const { stats, jobKind } = plan.facts;
  return {
    type: 'run', change: plan.change, repo: plan.top.slice(plan.top.lastIndexOf('/') + 1), job: jobKind, paths: plan.facts.paths.slice(0, MAX_LEDGER_PATHS),
    kinds: [...new Set(Object.values(plan.facts.kinds).flat())], stats, risk: plan.risk, features: plan.features,
    check: run.check, level: run.level, by: run.by, reason: run.reason, result: run.result === 'catch' ? 'catch' : run.result,
    seconds: Math.round((run.seconds ?? 0) * 10) / 10, tokens: run.tokens ?? 0,
  };
}

/** Skipped levels worth a later run: a kind kept below full by a low-risk rule (not one with no file of its kind). */
function skippedOf(plan) {
  return plan.rows.filter((row) => row.by === 'rule' && row.level !== 'full' && row.check !== 'security' && !/^no .* (in this repo|changed|reached)/.test(row.reason))
    .slice(0, MAX_QUEUED_PER_CHANGE).map((row) => ({ change: plan.change, top: plan.top, base: plan.base, paths: plan.facts.paths, check: row.check, level: raiseLevel(row.level) }));
}

/** Runs the plan's rows (owner rows and `none` rows are recorded, not run). */
async function runRows(plan, deadline) {
  const runs = [];
  for (const row of [...plan.rows].sort((a, b) => ORDER.indexOf(a.check) - ORDER.indexOf(b.check))) {
    if (row.by === 'owner') { runs.push({ ...row, result: 'owner', note: row.reason }); continue; }
    if (row.level === 'none') { runs.push({ ...row, result: 'skipped', note: row.reason }); continue; }
    runs.push({ ...row, ...(await runKind(row, plan, deadline)) });
  }
  return runs;
}

/**
 * One smart check of a change.
 * @param {{cwd: string, base?: string, job?: string, paths?: string[], briefFiles?: string[], seconds?: number, ownerOn?: string[],
 *   scope?: string, label?: Function, record?: boolean}} options `record` false: no ledger rows, no queue (a dry run)
 * @returns {Promise<{skip?: string, block: string, act: boolean, change?: string}>}
 */
export async function runSmartCheck(options) {
  const started = Date.now();
  const deadline = started + (options.seconds ?? DEFAULT_SECONDS) * 1000;
  const plan = await buildPlan(options);
  if (plan.skip) return { skip: plan.skip, block: `smart-check: nothing to check (${plan.skip})`, act: false };
  const pinned = runPinned(plan, { briefFiles: options.briefFiles ?? null, deadline });
  const runs = await runRows(plan, deadline);
  const outcome = { pinned, runs, change: plan.change, seconds: (Date.now() - started) / 1000, tokens: runs.reduce((sum, run) => sum + (run.tokens ?? 0), 0) };
  if (options.record !== false) {
    const pinnedRows = pinned.map((p) => ({ check: `pinned:${p.name}`, level: 'pinned', by: 'pinned', reason: 'every change', result: p.findings.length ? 'catch' : 'pass', seconds: p.seconds }));
    appendRows([...pinnedRows, ...runs].map((run) => ledgerRow(plan, run)));
    queueSkipped(skippedOf(plan));
  }
  return { block: reportBlock(outcome), act: mustAct(outcome), change: plan.change, outcome };
}

/**
 * The background run of skipped levels (round 2, 11.3): each queued item whose change is still the same runs at its level; a catch
 * there is an escape of the planned level, a pass is truth "pass". Items whose change moved on are dropped.
 * @param {number} seconds the whole run's budget
 * @returns {Promise<string>} one line per item
 */
export async function runBackground(seconds = DEFAULT_SECONDS) {
  const deadline = Date.now() + seconds * 1000;
  const lines = [];
  for (const item of takeQueue()) {
    if (Date.now() >= deadline) { lines.push(`${item.change} ${item.check}: out of time, dropped`); continue; }
    const plan = await buildPlan({ cwd: item.top, base: item.base, paths: item.paths, random: () => 1 });
    if (plan.skip || plan.change !== item.change) { lines.push(`${item.change} ${item.check}: the change moved on, dropped`); continue; }
    const run = await runKind({ check: item.check, level: item.level, how: '', by: 'background' }, plan, deadline);
    if (!['pass', 'catch'].includes(run.result)) { lines.push(`${item.change} ${item.check} ${item.level}: ${run.result} (${run.note ?? ''})`); continue; }
    appendRows([{ type: 'truth', change: item.change, check: item.check, level: item.level, truth: run.result === 'catch' ? 'escape' : 'pass', source: 'background' }]);
    lines.push(`${item.change} ${item.check} ${item.level}: ${run.result === 'catch' ? 'ESCAPE' : 'pass'}${run.findings ? `\n  ${run.findings.slice(0, 5).join('\n  ')}` : ''}`);
  }
  return lines.length ? lines.join('\n') : 'smart-check background: the queue is empty';
}

const flagsOf = (args) => Object.fromEntries(args.flatMap((arg, i) => (arg.startsWith('--') ? [[arg.slice(2), args[i + 1] === undefined || args[i + 1].startsWith('--') ? true : args[i + 1]]] : [])));
const listOf = (value) => (typeof value === 'string' ? value.split(',').filter(Boolean) : null);

async function main(args) {
  const flags = flagsOf(args);
  const seconds = Number(flags.seconds) > 0 ? Number(flags.seconds) : DEFAULT_SECONDS;
  if (flags.background) { console.log(await runBackground(seconds)); return 0; }
  const { labelChange } = await import('./lib/label.mjs').catch(() => ({ labelChange: null }));
  const result = await runSmartCheck({ cwd: typeof flags.cwd === 'string' ? flags.cwd : process.cwd(), base: typeof flags.base === 'string' ? flags.base : undefined,
    job: typeof flags.job === 'string' ? flags.job : undefined, paths: listOf(flags.paths), briefFiles: listOf(flags['brief-files']), seconds, label: labelChange });
  console.log(flags.json ? JSON.stringify(result.outcome ?? result) : result.block);
  return result.act ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
