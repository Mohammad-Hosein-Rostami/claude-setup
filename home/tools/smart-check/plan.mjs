// Purpose: the smart check's plan (spec r9-smart-check 2): read one change from git, take its facts, and say per check kind
//   none | scoped | full with one reason line each (rules first, then the model and the 20% exploration, which only raise).
// Usage: node plan.mjs [--cwd <dir>] [--base <ref>] [--job <kind>] [--paths a,b,...] [--json] [--no-label]
//   --paths   only these repo-relative paths count (the Stop hook passes the session's edited files); default every changed path
//   --job     bugfix | feature | refactor | docs | config | ui-pixel | hooks-or-gates (default: read from the change)
// Exports: buildPlan(options), planText(plan), PINNED.
// Exit codes: 0 a plan was printed (or "nothing to check"), 2 usage.
// Invariants: read-only (git reads, the ledger, the model file); outside a git repo or with no change it returns { skip } at once;
//   the plan never lowers a rule's level: the model and exploration only raise, and owner-on categories are full by `owner`.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { changedPaths, gitOf, gitTop, laneBase, MAX_FILES, newFileReader, readChange } from './lib/git-changes.mjs';
import { changeFacts } from './lib/facts.mjs';
import { affectedOf, consumerCounter, figmaJobOf, projectFacts } from './lib/project.mjs';
import { planRows, proseHasCommands, raiseLevel } from './lib/rules.mjs';
import { boundRaises, explorePick, featuresOf, guardedKinds, loadModels, modelRaises, noisyKinds } from './lib/model.mjs';
import { readRows, recentCatches, stateDir, stats } from './ledger.mjs';

/** The pinned checks: every change, never sampled, about 0 tokens (spec 3). */
export const PINNED = ['parse', 'imports', 'deps', 'never-weaken', 'secrets', 'placeholders', 'size-caps', 'scope', 'hook-load'];
const TOP_DECILE = 0.9;
const MIN_RISK_HISTORY = 50; // ledger changes before "top tenth of risk" means anything

/** A cheap risk score (round 1, 8.3 item 4: Kamei metrics, the cheap ones). */
const riskScore = (facts) => Math.log1p(facts.stats.added) + facts.stats.dirs + 2 * facts.stats.newFiles + 3 * facts.riskyClasses.length;

/** True when this change's risk is in the top tenth of the ledger's changes. */
function topDecile(score, rows) {
  const scores = [...new Map(rows.filter((row) => row.type === 'run' && typeof row.risk === 'number').map((row) => [row.change, row.risk])).values()].sort((a, b) => a - b);
  return scores.length >= MIN_RISK_HISTORY && score >= scores[Math.floor(scores.length * TOP_DECILE)];
}

/** The id of a change: a hash of its base and its changed lines, so the same diff is never checked twice. */
function changeId(base, files) {
  const hash = createHash('sha256').update(String(base));
  for (const file of files) hash.update(`\0${file.path}\0${file.added.map((l) => l.text).join('\n')}\0${file.removed.map((l) => l.text).join('\n')}`);
  return hash.digest('hex').slice(0, 16);
}

/** Applies the model and the exploration pick: each may raise one kind's level, never lower one. */
function learnedRows(rows, facts, ledger, random) {
  const models = loadModels(stateDir());
  const guarded = guardedKinds(ledger);
  const features = featuresOf(facts);
  const { perKind } = stats(ledger);
  const overBound = boundRaises(perKind);
  const noisy = noisyKinds(perKind);
  const raised = rows.map((row) => {
    const reportOnly = noisy.has(row.check) ? { reportOnly: true } : {};
    if (row.by !== 'rule' || row.level === 'full') return { ...row, ...reportOnly };
    if (overBound.has(row.check)) return { ...row, ...reportOnly, level: raiseLevel(row.level), how: `${raiseLevel(row.level)} level of ${row.check} (raised)`, by: 'ledger', reason: `${row.reason}; miss-rate bound over 1%: one level up` };
    if (modelRaises(models, row.check, features, guarded)) return { ...row, ...reportOnly, level: raiseLevel(row.level), how: `${raiseLevel(row.level)} level of ${row.check} (raised)`, by: 'model', reason: `${row.reason}; model: likely to find more one level up` };
    return { ...row, ...reportOnly };
  });
  const explore = explorePick(raised, random);
  return raised.map((row) => (row.check === explore ? { ...row, level: raiseLevel(row.level), how: `${raiseLevel(row.level)} level of ${row.check} (raised)`, by: 'explore', reason: `${row.reason}; exploration (20%): one level up` } : row));
}

/** The changed paths, kept to `only` when the caller names them. */
function pathsOf(git, base, only) {
  const all = changedPaths(git, base);
  if (!only) return all;
  const keep = new Set(only);
  return { tracked: all.tracked.filter((path) => keep.has(path)), untracked: all.untracked.filter((path) => keep.has(path)) };
}

/**
 * The plan of one change.
 * @param {{cwd: string, base?: string, job?: string, paths?: string[], ownerOn?: string[], scope?: string, random?: () => number,
 *   label?: (facts: object) => Promise<string[]>}} options `paths`: repo-relative paths that count (null: all); `label`: the add-only
 *   Haiku label (lib/label.mjs) for a change the rules cannot classify
 * @returns {Promise<{skip: string} | {top: string, base: string|null, change: string, facts: object, rows: object[], pinned: string[], files: object[], risk: number, features: number[]}>}
 */
export async function buildPlan({ cwd, base: requested, job, paths: only = null, ownerOn = [], scope = '', random = Math.random, label = null }) {
  const top = gitTop(cwd);
  if (top === null) return { skip: 'not a git repo' };
  const git = gitOf(top);
  const base = laneBase(git, requested);
  const paths = pathsOf(git, base, only);
  const count = paths.tracked.length + paths.untracked.length;
  if (count === 0) return { skip: 'no change' };
  const files = readChange(git, base, paths);
  const facts = changeFacts(files, { readNew: newFileReader(top), jobKind: job, consumersOf: consumerCounter(git), truncated: count > MAX_FILES });
  const project = projectFacts(top);
  const affected = project.affectedScript ? affectedOf(top, facts.paths) : null;
  const ledger = readRows();
  const risk = riskScore(facts);
  const context = {
    project, ownerOn, figmaJob: job === 'ui-pixel' || figmaJobOf(top, scope), affectedShare: affected?.share ?? 0, affectedReason: affected?.reason ?? '', affectedCount: affected?.tests.length,
    textReadByTests: (affected?.tests.length ?? 0) > 0, recentCatches: recentCatches(ledger), riskTopDecile: topDecile(risk, ledger),
    proseHasCommands: proseHasCommands(files),
  };
  let rows = planRows(facts, context);
  if (label) rows = await label(facts, rows);
  rows = learnedRows(rows, facts, ledger, random);
  return { top, base, change: changeId(base, files), facts, rows, pinned: PINNED, files, risk, features: featuresOf(facts), affected, project };
}

/** The plan as text (round 2, 8.2 shape): one head line, one line per kind, the pinned list. */
export function planText(plan) {
  if (plan.skip) return `smart-check: nothing to check (${plan.skip})`;
  const { stats, code } = plan.facts;
  const exports = code.exportsChanged.length ? `, exports changed in ${code.exportsChanged.length} file(s)` : '';
  const head = `smart-check plan (${stats.files} files, ${stats.dirs} dirs, +${stats.added} -${stats.deleted}${exports}; job ${plan.facts.jobKind})`;
  const lines = plan.rows.map((row) => `  ${row.check.padEnd(8)} ${row.level.padEnd(6)} ${(row.how || '-').slice(0, 60).padEnd(60)} reason: ${row.reason}${row.by === 'rule' ? '' : ` [${row.by}]`}`);
  return [head, ...lines, `  pinned   ${plan.pinned.join(', ')}`].join('\n');
}

/** Reads `--name value` flags (a flag with no value is true). */
const flagsOf = (args) => Object.fromEntries(args.flatMap((arg, i) => (arg.startsWith('--') ? [[arg.slice(2), args[i + 1] === undefined || args[i + 1].startsWith('--') ? true : args[i + 1]]] : [])));

async function main(args) {
  const flags = flagsOf(args);
  if (flags.help) { console.log('usage: plan.mjs [--cwd <dir>] [--base <ref>] [--job <kind>] [--paths a,b] [--json] [--no-label]'); return 0; }
  const paths = typeof flags.paths === 'string' ? flags.paths.split(',').filter(Boolean) : null;
  const { labelChange } = await import('./lib/label.mjs').catch(() => ({ labelChange: null }));
  const plan = await buildPlan({ cwd: typeof flags.cwd === 'string' ? flags.cwd : process.cwd(), base: typeof flags.base === 'string' ? flags.base : undefined,
    job: typeof flags.job === 'string' ? flags.job : undefined, paths, label: flags['no-label'] ? null : labelChange });
  if (flags.json) {
    const { files, ...shown } = plan;
    console.log(JSON.stringify(shown, null, 2));
  } else console.log(planText(plan));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
