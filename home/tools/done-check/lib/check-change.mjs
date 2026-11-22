// The done-check orchestration (design sections 3 and 6): one change in, one Verdict out. Scope -> plan -> reuse of an earlier green run
// of the same change -> run the checks at head -> base compare of the failures -> verdict -> ledger row -> one status line.
// Exports: checkChange(scope, options) -> Promise<Verdict>, repoIdOf(top) -> string (the hashed repo id of the ledger rows).
// What it decides: a kind FAILs when it has a failure the base does not have (types, lint, tests) or any weakened-test item; a kind
//   that could not run is `not-run` and never blocks and is never ok. At a stop (`where: 'stop'`) a FAIL blocks, except when the same
//   change key was blocked before or the agent was blocked MAX_BLOCKS_IN_A_ROW times already: then it is `left-open` (the caller, the
//   hook, owns that count and passes it as `priorBlocks`). At a land or a manual run a FAIL always blocks. Empty scope: verdict `skipped`,
//   no ledger row. DONE_CHECK_SKIP=all: verdict `skipped`, no command runs, one ledger row.
// Invariants: the change key mixes the plan fingerprint into Scope.key, so a changed set of commands is a new change. The same key in the
//   ledger after an ok or reused run (with no time or error not-run) is `reused` and runs no command. The risk classes are always computed
//   fresh. Result files made for the tools are removed after the run (and old ones of a crashed run after a day). The ledger holds counts
//   only. Total time: the head checks take at most `deadlineMs`, the base side at most BASE_DEADLINE_MS more.
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { worktreeOf } from '../../../hooks/lib/gated-folder.mjs';
import { compareWithBase } from './base-compare.mjs';
import { BASE_DEADLINE_MS, CHECK_KINDS, LAND_DEADLINE_MS, MAX_BLOCKS_IN_A_ROW, STOP_DEADLINE_MS } from './contract.mjs';
import { planChecks } from './detect.mjs';
import { appendRun, ledgerFile, readLedger } from './ledger.mjs';
import { loadRiskRules, riskClasses } from './risk.mjs';
import { runPlan } from './run-checks.mjs';
import { weakenedTests } from './test-diff.mjs';
import { lineOf, reasonOf } from './verdict-text.mjs';

const WHERES = ['stop', 'land', 'manual'];
const REPO_ID_CHARS = 16;
const RUN_ID_BYTES = 6;
const STALE_RESULT_FILE_MS = 24 * 60 * 60 * 1000;
const WHY_PRIORITY = ['time', 'error']; // of several reasons a whole kind did not run, these are shown first
const SKIPPED_KINDS = ['types', 'lint', 'tests'];
const hashOf = (text) => createHash('sha256').update(text).digest('hex');

/** The hashed id of the repository a folder belongs to (all worktrees of one repository share it); a non-git folder hashes its own path. */
export function repoIdOf(top) {
  return hashOf(worktreeOf(top)?.commonDir ?? top).slice(0, REPO_ID_CHARS);
}

/** An earlier run of the same change that can stand in for a new run: ok or reused, and every check it did not run was not cut short. */
function earlierGreenRun(repo, key, env) {
  const cutShort = (check) => check.result === 'not-run' && WHY_PRIORITY.includes(check.why);
  return readLedger({ env }).runs.findLast((row) => row.repo === repo && row.key === key && ['ok', 'reused'].includes(row.verdict)
    && !Object.values(row.checks).some(cutShort)) ?? null;
}

/** The packages of the plan as `<folder>: ` prefixes (empty for the project root), in command order. */
const packageNameOf = (scope, cmd) => (cmd.cwd === scope.top ? '' : `${relative(scope.top, cmd.cwd).split('\\').join('/')}: `);

/** One member per planned command (its head result judged against the base answer) and one per command that could not be planned. */
function membersOf({ scope, plan, results, answers }) {
  const cmds = plan.packages.flatMap((one) => one.cmds);
  const members = cmds.map((cmd, index) => {
    const result = results[index];
    const answer = answers.get(index);
    const oldIds = answer?.oldIds;
    const old = oldIds ? result.failures.filter((failure) => oldIds.has(failure.id)) : [];
    const fresh = result.result === 'fail' ? result.failures.filter((failure) => !old.includes(failure)) : [];
    const judged = result.result === 'fail' ? (fresh.length > 0 ? 'fail' : 'ok') : result.result;
    return { kind: cmd.kind, name: `${packageNameOf(scope, cmd)}${cmd.label}`, result: judged, why: result.why, ms: result.ms, fresh, old, baseWhy: answer?.unavailable };
  });
  const skipped = plan.skipped.map((entry) => ({ kind: entry.kind, name: entry.label, result: 'not-run', why: entry.why, ms: 0, fresh: [], old: [] }));
  return [...members, ...skipped];
}

/** The weakened-test scan as one member: not run without a git base, else ok or one failure per item. */
function weakenedMember(scope) {
  if (!scope.git || !scope.base) return { kind: 'tests-weakened', name: 'tests-weakened', result: 'not-run', why: 'not-supported', ms: 0, fresh: [], old: [] };
  const started = Date.now();
  const fresh = weakenedTests(scope);
  return { kind: 'tests-weakened', name: 'tests-weakened', result: fresh.length > 0 ? 'fail' : 'ok', ms: Date.now() - started, fresh, old: [] };
}

/** The members of one kind merged into the kind's result: fail beats ok beats none beats not-run. */
function summarize(kind, members) {
  const fresh = members.flatMap((member) => member.fresh);
  const has = (result) => members.some((member) => member.result === result);
  const result = fresh.length > 0 ? 'fail' : has('ok') ? 'ok' : has('none') ? 'none' : 'not-run';
  const reasons = members.map((member) => member.why).filter(Boolean);
  const why = result === 'not-run' ? (WHY_PRIORITY.find((reason) => reasons.includes(reason)) ?? reasons[0] ?? 'error') : undefined;
  return { kind, result, fresh, old: members.flatMap((member) => member.old), ms: members.reduce((sum, member) => sum + member.ms, 0), ...(why ? { why } : {}) };
}

/** Line parts the ledger row cannot hold: which package or command did not run when a kind has several, a base that was not compared. */
function notesOf(plan, scope, groups) {
  const notes = [];
  for (const members of groups.values()) {
    if (members.length > 1) notes.push(...members.filter((member) => member.result === 'not-run').map((member) => `not run: ${member.name} (${member.why})`));
  }
  if (scope.base !== null && [...groups.values()].flat().some((member) => member.baseWhy)) notes.push('base: unavailable');
  if (plan.packages.some((one) => one.fromChange)) notes.push('commands from this change');
  return notes;
}

const rowCheck = (summary) => ({ result: summary.result, new: summary.fresh.length, old: summary.old.length, ms: summary.ms, ...(summary.why ? { why: summary.why } : {}) });

/** Removes the result files of this plan, and result files of a crashed run older than a day; false when a file could not be removed. */
function tidyResultFiles(plan, env) {
  try {
    for (const cmd of plan.packages.flatMap((one) => one.cmds)) if (cmd.outputFile) rmSync(cmd.outputFile, { force: true });
    const folder = join(dirname(ledgerFile(env)), 'out');
    for (const name of readdirSync(folder)) {
      if (Date.now() - statSync(join(folder, name)).mtimeMs > STALE_RESULT_FILE_MS) rmSync(join(folder, name), { force: true });
    }
    return true;
  } catch (error) {
    return error.code === 'ENOENT'; // no result folder: nothing was made, nothing is left
  }
}

/** The risk classes of the change (names only) and a line part when the rule file was bad (the built-in rules were used). */
function riskOf(scope) {
  const { rules, warning } = loadRiskRules();
  return { classes: [...new Set(riskClasses(scope, rules).map((entry) => entry.class))], warning };
}

/** `block`, `left-open` or `ok` for the merged kinds; a stop that was blocked on this key or too often before is left open. */
function decide({ failing, where, key, priorBlocks }) {
  if (!failing) return { verdict: 'ok', tries: 0 };
  if (where !== 'stop') return { verdict: 'block', tries: 0 };
  if (priorBlocks.lastKey === key) return { verdict: 'left-open', tries: 0 };
  if (priorBlocks.inARow >= MAX_BLOCKS_IN_A_ROW) return { verdict: 'left-open', tries: priorBlocks.inARow };
  return { verdict: 'block', tries: 0 };
}

/** Runs the weakened-test scan and the planned commands, then the base compare; returns the kinds merged and why the base was not compared. */
async function runChecks({ scope, plan, repo, deadlineMs, startedAt }) {
  const weakened = weakenedMember(scope);
  const results = await runPlan(plan, scope, { deadlineMs: Math.max(1, deadlineMs - (Date.now() - startedAt)) });
  const answers = await compareWithBase({ scope, plan, results, repoId: repo, budgetMs: Math.min(BASE_DEADLINE_MS, deadlineMs) });
  const groups = Map.groupBy([...membersOf({ scope, plan, results, answers }), weakened], (member) => member.kind);
  const summaries = CHECK_KINDS.filter((kind) => groups.has(kind)).map((kind) => summarize(kind, groups.get(kind)));
  return { groups, summaries, baseWhy: [...groups.values()].flat().find((member) => member.baseWhy)?.baseWhy };
}

/**
 * Checks one change and decides what the stop, land or manual run does with it.
 * @param {import('./contract.mjs').Scope | Promise<import('./contract.mjs').Scope>} scopeOrPromise the change (a Promise is awaited)
 * @param {{ where: 'stop'|'land'|'manual', session?: string, agent?: string, env?: NodeJS.ProcessEnv, deadlineMs?: number,
 *   priorBlocks?: { lastKey: string|null, inARow: number } }} options `deadlineMs` caps the head checks (default: STOP_DEADLINE_MS at a stop,
 *   else LAND_DEADLINE_MS); `priorBlocks` is the caller's block state of this agent: the key it blocked last and how many blocks in a row
 * @returns {Promise<import('./contract.mjs').Verdict>} the verdict, its line, the reason (for `block`), the risk classes and the ledger row
 * @throws {RangeError} a bad `where` or `deadlineMs`; {Error} when the plan cannot be made (the state folder) or a git call of a lib fails
 */
export async function checkChange(scopeOrPromise, options) {
  const { where, session = '', agent = '', env = process.env, priorBlocks = { lastKey: null, inARow: 0 } } = options;
  const deadlineMs = options.deadlineMs ?? (where === 'stop' ? STOP_DEADLINE_MS : LAND_DEADLINE_MS);
  if (!WHERES.includes(where)) throw new RangeError(`checkChange: where must be one of ${WHERES.join(', ')}, got ${where}`);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new RangeError(`checkChange: deadlineMs must be a positive number, got ${deadlineMs}`);
  const startedAt = Date.now();
  const scope = await scopeOrPromise;
  const files = scope.files.length + scope.wide.length;
  const repo = repoIdOf(scope.top ?? '');
  const risk = files === 0 ? { classes: [], warning: undefined } : riskOf(scope);
  const row = { v: 1, id: randomBytes(RUN_ID_BYTES).toString('hex'), at: new Date().toISOString(), where, session, agent, repo, base: scope.base, key: scope.key, files, checks: {}, verdict: 'ok', risk: risk.classes, ms: 0 };
  const finish = (verdict, extra = {}) => {
    row.verdict = verdict;
    row.ms = Date.now() - startedAt;
    const notes = [...(extra.notes ?? []), ...(risk.warning ? ['risk rules file is bad, built-in rules used'] : [])];
    if (files > 0 && !appendRun(row, { env })) notes.push('ledger not written');
    return { verdict, line: lineOf(row, { notes, tries: extra.tries ?? 0 }), reason: extra.reason ?? null, risk: risk.classes, row };
  };
  if (files === 0) return finish('skipped');
  if ((env.DONE_CHECK_SKIP ?? '').split(',').map((name) => name.trim()).includes('all')) {
    for (const kind of SKIPPED_KINDS) row.checks[kind] = { result: 'not-run', new: 0, old: 0, ms: 0, why: 'skipped-env' };
    return finish('skipped');
  }
  const plan = planChecks(scope, env);
  row.key = hashOf(`${scope.key}\n${plan.fingerprint}`);
  let earlier = null;
  try {
    earlier = earlierGreenRun(repo, row.key, env);
  } catch (error) {
    return finish('ok', { notes: [`ledger unreadable (${error.code ?? error.message}): no reuse`] });
  }
  if (earlier) {
    row.checks = earlier.checks;
    return finish('reused');
  }
  let ran;
  let cleaned = false;
  try {
    ran = await runChecks({ scope, plan, repo, deadlineMs, startedAt });
  } finally {
    cleaned = tidyResultFiles(plan, env);
  }
  for (const summary of ran.summaries) row.checks[summary.kind] = rowCheck(summary);
  const { verdict, tries } = decide({ failing: ran.summaries.some((summary) => summary.result === 'fail'), where, key: row.key, priorBlocks });
  const notes = [...notesOf(plan, scope, ran.groups), ...(cleaned ? [] : ['result files not removed'])];
  return finish(verdict, { notes, tries, reason: verdict === 'block' ? reasonOf(ran.summaries, { baseWhy: ran.baseWhy }) : null });
}
