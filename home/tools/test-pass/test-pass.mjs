#!/usr/bin/env node
// CLI of `test-pass`: runs a test command and, when it passes on a clean tree, remembers that this tree passed.
// Usage: test-pass.mjs run [--repo <dir>] [--suite] [--quiet] [-- <cmd...>]
//        test-pass.mjs check <sha> [--repo <dir>] [--suite]
//        test-pass.mjs suite show [--repo <dir>]
//        test-pass.mjs record [--repo <dir>] [--role <role>] [--tests <id,...>] [--report <file>] [--target <name>] -- <cmd...>
//        test-pass.mjs mutants [--repo <dir>] --patch <file> [--patch <file>...] [--timeout-ms <n>] -- <keep-green cmd...>
//        test-pass.mjs proof <sha> [--repo <dir>] [--handover <file>] [--real-target]
//   run          runs <cmd> (no shell) in the repo and exits with its code. With --suite and no command it runs the repo's declared
//                full-suite command through the shell; with --suite and a command, the command must be the declared one.
//                --quiet prints one line on success and the last lines of the output on failure.
//   check        exit 0 when a PASS is recorded for the tree of <sha>, 1 when none; with --suite only a full-suite PASS counts
//   suite show   prints the declared full-suite command (package.json `test` script, else the CLAUDE.md `Tests:` bullet)
//   record       runs <cmd> (no shell) on a clean tree, reads the counts from its output (or --report), and writes a proof record
//                {sha, cmd, role, tests, selected, passed, failed, skipped, exit, verdict} pass or fail; exits with the command's code
//                (role: repro | acceptance | keep-green | suite | target; default keep-green)
//   mutants      applies each mutant patch to a private copy, runs the keep-green command, and records `mutants: <killed>/<n>`
//   proof        reads the proof records of <sha> and refuses what verify-done must refuse (lib/proof-check.mjs); prints the
//                verdict line a runner copies; exit 0 accepted, 1 refused
// Exit codes: run = the command's; check 0 PASS, 1 none; every command 2 for a usage error, a folder that is not a repo, or an
//   undeclared or different suite command.
// Invariants: a record is written only when the command exits 0, the tree had no uncommitted change before it started, and HEAD's
//   tree is unchanged after it. Records live in lib/store.mjs. Exports: hasPass, declaredSuite (for git-tidy land).
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runMutants } from './lib/mutants.mjs';
import { checkProof } from './lib/proof-check.mjs';
import { ROLES, countsOf, proofsOf, verdictOf, writeProof } from './lib/proof-store.mjs';
import { commitOf, declaredSuite, hasPass, isCleanTree, recordPass, treeOf } from './lib/store.mjs';

export { declaredSuite, hasPass };

// Every command runs inside this wrapper: it gives the run its own TMPDIR and removes it afterwards, so a suite cannot fill the disk with temp folders.
const WITH_RUN_TMP = fileURLToPath(new URL('../disk-free/with-run-tmp.mjs', import.meta.url));
const EXIT_NONE = 1;
const EXIT_USAGE = 2;
const TAIL_LINES = 60; // lines of a failed quiet run that are printed
const USAGE = 'usage: test-pass.mjs run [--repo <dir>] [--suite] [--quiet] [-- <cmd...>] | check <sha> [--repo <dir>] [--suite] | suite show [--repo <dir>]'
  + ' | record [--repo <dir>] [--role <role>] [--tests <ids>] [--report <file>] [--target <name>] -- <cmd...>'
  + ' | mutants [--repo <dir>] --patch <file>... [--timeout-ms <n>] -- <cmd...> | proof <sha> [--repo <dir>] [--handover <file>] [--real-target]';
const VALUE_FLAGS = new Set(['--repo', '--role', '--tests', '--report', '--target', '--handover', '--timeout-ms']);
const MUTANT_TIMEOUT_MS = 600000; // one keep-green run of a mutant; a longer run counts as killed (the mutant hung it)

class UsageError extends Error {}

/** Splits argv at the first `--`: [before, command words]. */
const splitCommand = (argv) => {
  const at = argv.indexOf('--');
  return at === -1 ? [argv, []] : [argv.slice(0, at), argv.slice(at + 1)];
};

function parseArgs(argv) {
  const [words, command] = splitCommand(argv);
  const options = { name: words[0], repo: process.cwd(), suite: false, quiet: false, realTarget: false, positional: [], patches: [], values: {}, command };
  const rest = words.slice(1);
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--suite') options.suite = true;
    else if (rest[i] === '--quiet') options.quiet = true;
    else if (rest[i] === '--real-target') options.realTarget = true;
    else if (rest[i] === '--repo' && rest[i + 1] !== undefined) options.repo = rest[++i];
    else if (rest[i] === '--patch' && rest[i + 1] !== undefined) options.patches.push(rest[++i]);
    else if (VALUE_FLAGS.has(rest[i]) && rest[i + 1] !== undefined) options.values[rest[i].slice(2)] = rest[++i];
    else if (rest[i].startsWith('--')) throw new UsageError(`unknown flag ${rest[i]}. ${USAGE}`);
    else options.positional.push(rest[i]);
  }
  return options;
}

/** The command to run: { text, args | null, shell } or throws UsageError for an undeclared or different suite command. */
function commandToRun(options) {
  if (!options.suite) {
    if (options.command.length === 0) throw new UsageError(`run needs a command after --. ${USAGE}`);
    return { text: options.command.join(' '), args: options.command, shell: false };
  }
  const declared = declaredSuite(options.repo);
  if (declared === null) throw new UsageError('this repo declares no full-suite command: add a `test` script to the root package.json or a "Tests: `<cmd>`" bullet to CLAUDE.md');
  if (options.command.length > 0 && options.command.join(' ') !== declared) {
    throw new UsageError(`"${options.command.join(' ')}" is not the declared full-suite command "${declared}"; a suite PASS is only recorded for the declared command (change it in the repo, there is no override)`);
  }
  return { text: declared, args: null, shell: true };
}

function execute(command, repo, quiet) {
  const stdio = quiet ? 'pipe' : 'inherit';
  const started = Date.now();
  const wrapped = command.shell ? ['--shell', '--', command.text] : ['--', ...command.args];
  const result = spawnSync(process.execPath, [WITH_RUN_TMP, ...wrapped], { cwd: repo, stdio, encoding: 'utf8', maxBuffer: 256 << 20 });
  const code = result.status ?? 1;
  const ms = Date.now() - started;
  if (quiet && code === 0) console.log(`test-pass: ${command.text} passed in ${(ms / 1000).toFixed(1)} s`);
  if (quiet && code !== 0) console.log(`${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd().split('\n').slice(-TAIL_LINES).join('\n'));
  if (result.error) console.error(`test-pass: could not run ${command.text}: ${result.error.message}`);
  return { code, ms };
}

function run(options) {
  const command = commandToRun(options);
  const treeBefore = treeOf(options.repo, 'HEAD');
  if (treeBefore === null) throw new UsageError(`${options.repo} is not a git repository with a commit`);
  const cleanBefore = isCleanTree(options.repo);
  const { code, ms } = execute(command, options.repo, options.quiet);
  if (code !== 0) return code;
  const record = { tree: treeBefore, sha: commitOf(options.repo, 'HEAD') ?? '', cmd: command.text, suite: options.suite, at: new Date().toISOString(), ms };
  if (!cleanBefore) console.error('test-pass: not recorded: the tree had uncommitted changes when the command started');
  else if (treeOf(options.repo, 'HEAD') !== treeBefore) console.error('test-pass: not recorded: HEAD\'s tree changed during the run');
  else if (!recordPass(options.repo, record, process.env)) console.error('test-pass: not recorded: the state folder is not usable');
  return 0;
}

function check(options) {
  if (options.positional.length !== 1) throw new UsageError(`check needs one commit. ${USAGE}`);
  if (treeOf(options.repo, options.positional[0]) === null) throw new UsageError(`unknown commit ${options.positional[0]} in ${options.repo}`);
  return hasPass(options.repo, options.positional[0], { suite: options.suite }) ? 0 : EXIT_NONE;
}

function showSuite(options) {
  const declared = declaredSuite(options.repo);
  if (declared === null) return EXIT_NONE;
  console.log(declared);
  return 0;
}

/** The clean commit a proof record names: { sha, tree }, or throws UsageError (a dirty tree would record files the sha does not hold). */
function cleanCommit(repo) {
  const sha = commitOf(repo, 'HEAD');
  if (sha === null) throw new UsageError(`${repo} is not a git repository with a commit`);
  if (!isCleanTree(repo)) throw new UsageError('the tree has uncommitted changes: commit first, a proof record names a sha and must hold only its files');
  return { sha, tree: treeOf(repo, 'HEAD') };
}

/** `record`: run the command with its output captured, read the counts, write the proof row; exits with the command's code. */
function recordProof(options) {
  if (options.command.length === 0) throw new UsageError(`record needs a command after --. ${USAGE}`);
  const role = options.values.role ?? 'keep-green';
  if (!ROLES.includes(role) || role === 'mutants') throw new UsageError(`--role must be one of ${ROLES.filter((name) => name !== 'mutants').join(', ')}`);
  const { sha, tree } = cleanCommit(options.repo);
  const result = spawnSync(process.execPath, [WITH_RUN_TMP, '--', ...options.command], { cwd: options.repo, stdio: 'pipe', encoding: 'utf8', maxBuffer: 256 << 20 });
  const exit = result.status ?? 1;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  console.log(output.trimEnd().split('\n').slice(-TAIL_LINES).join('\n'));
  const counts = countsOf(options.values.report === undefined ? output : readReport(options.values.report));
  const tests = (options.values.tests ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  const row = { sha, tree, cmd: options.command.join(' '), role, tests, ...(counts ?? { selected: null, passed: null, failed: null, skipped: null, skippedNames: [] }), exit, verdict: verdictOf(counts, exit), ...(options.values.target ? { target: options.values.target } : {}), at: new Date().toISOString() };
  if (!writeProof(options.repo, row, process.env)) console.error('test-pass: proof not recorded: the state folder is not usable');
  else console.log(`test-pass: recorded ${role} ${row.verdict} for ${sha.slice(0, 8)}: ${row.passed ?? '?'} passed, ${row.failed ?? '?'} failed, exit ${exit}`);
  return exit;
}

/** The text of a test runner's report file, or throws UsageError. */
function readReport(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new UsageError(`cannot read the report file ${path}: ${error.code ?? error.message}`);
  }
}

/** `mutants`: count the mutants the keep-green command kills and record `mutants: <killed>/<n>`. */
function recordMutants(options) {
  if (options.command.length === 0 || options.patches.length === 0) throw new UsageError(`mutants needs --patch <file> and a keep-green command after --. ${USAGE}`);
  const { sha, tree } = cleanCommit(options.repo);
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: options.repo, encoding: 'utf8' }).stdout.trim();
  const timeoutMs = Number(options.values['timeout-ms'] ?? MUTANT_TIMEOUT_MS);
  const run = runMutants({ repo: top, patches: options.patches, command: options.command, timeoutMs });
  for (const result of run.results) console.log(`${result.patch}: ${result.outcome}${result.timedOut ? ' (timed out)' : ''}`);
  if (run.error) {
    console.error(`test-pass: no mutant count: ${run.error}`);
    return EXIT_NONE;
  }
  const row = { sha, tree, cmd: options.command.join(' '), role: 'mutants', tests: [], exit: 0, verdict: 'MUTANTS', mutants: { killed: run.killed, n: run.n, results: run.results }, at: new Date().toISOString() };
  if (!writeProof(options.repo, row, process.env)) console.error('test-pass: mutants not recorded: the state folder is not usable');
  console.log(`mutants: ${run.killed}/${run.n}`);
  return 0;
}

/** `proof <sha>`: accept or refuse the hand-over of <sha> from its proof records. */
function proof(options) {
  if (options.positional.length !== 1) throw new UsageError(`proof needs one commit. ${USAGE}`);
  const sha = commitOf(options.repo, options.positional[0]);
  if (sha === null) throw new UsageError(`unknown commit ${options.positional[0]} in ${options.repo}`);
  const handover = options.values.handover === undefined ? '' : readReport(options.values.handover);
  const isAncestor = (older, newer) => spawnSync('git', ['merge-base', '--is-ancestor', older, newer], { cwd: options.repo }).status === 0;
  const result = checkProof({ sha, rows: proofsOf(options.repo, process.env), isAncestor, handover, realTarget: options.realTarget });
  for (const refusal of result.refusals) console.log(`refused: ${refusal}`);
  console.log(result.verdictLine);
  return result.ok ? 0 : EXIT_NONE;
}

const COMMANDS = { run, check, record: recordProof, mutants: recordMutants, proof };

function main(argv) {
  try {
    const options = parseArgs(argv);
    if (Object.hasOwn(COMMANDS, options.name)) return COMMANDS[options.name](options);
    if (options.name === 'suite' && options.positional[0] === 'show') return showSuite(options);
    throw new UsageError(USAGE);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`test-pass: ${error.message}`);
    return EXIT_USAGE;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
