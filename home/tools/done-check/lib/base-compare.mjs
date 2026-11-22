// The base compare of one done-check run (design 3.3): for each typecheck or test command that failed on the change, which of its
// failures does the base commit have too (old, not the agent's) and which does it not (new).
// Exports: compareWithBase({ scope, plan, results, repoId, budgetMs, env }) -> Promise<Map<number, BaseAnswer>>,
//   findFlaky({ scope, plan, results, answers, budgetMs }) -> Promise<Map<number, Set<string>>>.
// Rules: only `types` and `tests` commands that failed are compared (lint looks at changed lines only). A typecheck runs again at the
//   base as it is; tests run again at the base for the failing test files only (the command is rebuilt from the head command: a vitest or
//   jest or node --test file list; a test file the base does not have cannot be an old failure). Answers are cached per (repo, base, package,
//   kind, command and test files) through base-run.mjs. All base work (tree and runs) shares one budget. A run that cannot be read, a base
//   tree that cannot be made, no git base, or a command shape it does not know answer `unavailable`: the caller then says the failures "may
//   be older than your change", never that they are old.
// Flaky: a test that newly fails at head (not an old failure) is run once more at head, its test file alone; one that passes the second time
//   is flaky (the caller reports it and does not block). A rerun that cannot finish or read leaves the failure new.
// Invariants: nothing throws for a bad base; the temp base tree is removed on every path (P15); the head results are never changed here.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { baseTree, cachedBase, saveBase } from './base-run.mjs';
import { runPlan } from './run-checks.mjs';

const COMPARED_KINDS = new Set(['types', 'tests']);
const BUILD_INFO_FLAG = '--tsBuildInfoFile';
const NO_BASE = 'no git base';

/**
 * @typedef {{ oldIds: Set<string> } | { unavailable: string }} BaseAnswer the ids that also fail at the base, or why they are unknown
 */

const withSlashes = (path) => path.replaceAll('\\', '/');

/** The argument for a test file in a command that runs in `cmd.cwd`: relative to it, never starting with `-`. */
function fileArg(cmd, top, file) {
  const path = withSlashes(relative(cmd.cwd, join(top, file)));
  return path.startsWith('-') ? `./${path}` : path;
}

/** The head command of a test run rebuilt to run only `files` (arguments for `cmd.cwd`); null for a tool it does not know. */
function testCommandFor(cmd, files, changedArgs) {
  const { argv } = cmd;
  if (argv.includes('--test')) return { ...cmd, argv: [...argv.slice(0, argv.findIndex((arg) => arg.startsWith('--test-reporter')) + 1), ...files] };
  if (cmd.label === 'vitest') {
    const at = argv.indexOf('--passWithNoTests');
    const front = argv.slice(0, at + 1).filter((arg) => arg !== '--run').map((arg) => (arg === 'related' ? 'run' : arg));
    return at < 0 ? null : { ...cmd, argv: [...front, ...argv.slice(at + 1).filter((arg) => !changedArgs.has(arg)), ...files] };
  }
  if (cmd.label === 'jest') return { ...cmd, argv: [...argv.filter((arg) => arg !== '--findRelatedTests' && !changedArgs.has(arg)), ...files] };
  return null;
}

/** A typecheck command for the base tree: the same, with its own incremental file so the head's cache is not overwritten. */
function typesCommandFor(cmd, treeRoot) {
  const at = cmd.argv.indexOf(BUILD_INFO_FLAG);
  return at < 0 ? cmd : { ...cmd, argv: cmd.argv.map((arg, index) => (index === at + 1 ? join(treeRoot, 'base.tsbuildinfo') : arg)) };
}

/** What to ask for each failed command: its cache label, and (for tests) the failing test files. */
function wantedFor(scope, cmds, results) {
  const changedArgs = (cmd) => new Set(scope.files.map((file) => fileArg(cmd, scope.top, file)));
  return results.flatMap((result, index) => {
    const cmd = cmds[index];
    if (result.result !== 'fail' || !COMPARED_KINDS.has(cmd.kind)) return [];
    const where = withSlashes(relative(scope.top, cmd.cwd));
    if (cmd.kind === 'types') return [{ index, cmd, label: `types|${where}|${cmd.label}`, files: [] }];
    const files = [...new Set(result.failures.map((failure) => failure.file))].sort();
    const hash = createHash('sha256').update(files.join('\0')).digest('hex').slice(0, 16);
    return [{ index, cmd, label: `tests|${where}|${cmd.label}|${hash}`, files, changedArgs: changedArgs(cmd) }];
  });
}

/** The base command of one wanted entry inside `tree`, an answer when none is needed, or `unavailable`. */
function baseCommandOf(wanted, scope, tree) {
  if (wanted.cmd.kind === 'types') return { run: typesCommandFor(wanted.cmd, dirname(tree.dir)) };
  const present = wanted.files.filter((file) => existsSync(join(tree.dir, file)));
  if (present.length === 0) return { answer: { oldIds: new Set() } }; // a test file the base lacks is new
  const run = testCommandFor(wanted.cmd, present.map((file) => fileArg(wanted.cmd, scope.top, file)), wanted.changedArgs);
  return run ? { run } : { answer: { unavailable: `cannot rerun ${wanted.cmd.label} for single test files` } };
}

/** Runs the base commands of `wanted` in `tree` within `leftMs`, saves what it reads to the cache, and fills `answers`. */
async function runAtBase({ wanted, scope, tree, repoId, leftMs, answers, env }) {
  const planned = wanted.map((entry) => ({ entry, ...baseCommandOf(entry, scope, tree) }));
  for (const item of planned.filter((one) => one.answer)) answers.set(item.entry.index, item.answer);
  const runnable = planned.filter((item) => item.run);
  if (runnable.length === 0) return;
  const plan = { packages: [{ root: scope.top, pm: '', cmds: runnable.map((item) => item.run) }], skipped: [], fingerprint: '' };
  const results = await runPlan(plan, scope, { deadlineMs: Math.max(1, leftMs), dir: tree.dir });
  for (const [position, item] of runnable.entries()) {
    const result = results[position];
    if (result.result === 'not-run') { answers.set(item.entry.index, { unavailable: `the base run did not finish (${result.why})` }); continue; }
    const oldIds = new Set(result.failures.map((failure) => failure.id));
    answers.set(item.entry.index, { oldIds });
    await saveBase(repoId, scope.base, item.entry.label, oldIds, env);
  }
}

/**
 * Finds, for every failed typecheck or test command, which failures the base has too.
 * @param {{ scope: import('./contract.mjs').Scope, plan: import('./contract.mjs').Plan, results: import('./contract.mjs').CheckResult[], repoId: string, budgetMs: number, env?: NodeJS.ProcessEnv }} input
 *   `results` are the head results in plan order (one per command); `budgetMs` is the most the whole base side may take;
 *   `env` names the HOME of the base cache (default process.env)
 * @returns {Promise<Map<number, BaseAnswer>>} per command index (only failed types and tests commands)
 */
export async function compareWithBase({ scope, plan, results, repoId, budgetMs, env = process.env }) {
  const startedAt = Date.now();
  const wanted = wantedFor(scope, plan.packages.flatMap((one) => one.cmds), results);
  const answers = new Map();
  if (wanted.length === 0) return answers;
  if (!scope.git || !scope.base) return new Map(wanted.map((entry) => [entry.index, { unavailable: NO_BASE }]));
  const missing = [];
  for (const entry of wanted) {
    const cached = await cachedBase(repoId, scope.base, entry.label, env);
    if (cached) answers.set(entry.index, { oldIds: cached });
    else missing.push(entry);
  }
  if (missing.length === 0) return answers;
  const tree = await baseTree(scope.top, scope.base, { deadlineMs: budgetMs });
  if (tree.unavailable) {
    for (const entry of missing) answers.set(entry.index, { unavailable: tree.unavailable });
    return answers;
  }
  try {
    await runAtBase({ wanted: missing, scope, tree, repoId, leftMs: budgetMs - (Date.now() - startedAt), answers, env });
  } finally {
    tree.cleanup();
  }
  return answers;
}

/**
 * Finds the new test failures that pass when their test file is run once more at head.
 * @param {{ scope: import('./contract.mjs').Scope, plan: import('./contract.mjs').Plan, results: import('./contract.mjs').CheckResult[], answers: Map<number, BaseAnswer>, budgetMs: number }} input
 *   `answers` come from compareWithBase (a failure with an old id is not new); `budgetMs` is the most the reruns may take together
 * @returns {Promise<Map<number, Set<string>>>} per tests command index, the ids of its new failures that were flaky (only commands that have some)
 */
export async function findFlaky({ scope, plan, results, answers, budgetMs }) {
  const cmds = plan.packages.flatMap((one) => one.cmds);
  const reruns = [];
  results.forEach((result, index) => {
    const cmd = cmds[index];
    if (cmd.kind !== 'tests' || result.result !== 'fail') return;
    const fresh = result.failures.filter((failure) => !answers.get(index)?.oldIds?.has(failure.id));
    const files = [...new Set(fresh.map((failure) => failure.file))].sort();
    const changedArgs = new Set(scope.files.map((file) => fileArg(cmd, scope.top, file)));
    const run = files.length > 0 ? testCommandFor(cmd, files.map((file) => fileArg(cmd, scope.top, file)), changedArgs) : null;
    if (run) reruns.push({ index, run, fresh });
  });
  const flaky = new Map();
  if (reruns.length === 0 || budgetMs <= 0) return flaky;
  const again = await runPlan({ packages: [{ root: scope.top, pm: '', cmds: reruns.map((item) => item.run) }], skipped: [], fingerprint: '' }, scope, { deadlineMs: budgetMs });
  for (const [position, { index, fresh }] of reruns.entries()) {
    if (!['ok', 'fail'].includes(again[position].result)) continue; // the rerun said nothing: the failure stays new
    const failingAgain = new Set(again[position].failures.map((failure) => failure.id));
    const passed = fresh.filter((failure) => !failingAgain.has(failure.id)).map((failure) => failure.id);
    if (passed.length > 0) flaky.set(index, new Set(passed));
  }
  return flaky;
}
