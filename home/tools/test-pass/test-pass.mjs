#!/usr/bin/env node
// CLI of `test-pass`: runs a test command and, when it passes on a clean tree, remembers that this tree passed.
// Usage: test-pass.mjs run [--repo <dir>] [--suite] [--quiet] [-- <cmd...>]
//        test-pass.mjs check <sha> [--repo <dir>] [--suite]
//        test-pass.mjs suite show [--repo <dir>]
//   run          runs <cmd> (no shell) in the repo and exits with its code. With --suite and no command it runs the repo's declared
//                full-suite command through the shell; with --suite and a command, the command must be the declared one.
//                --quiet prints one line on success and the last lines of the output on failure.
//   check        exit 0 when a PASS is recorded for the tree of <sha>, 1 when none; with --suite only a full-suite PASS counts
//   suite show   prints the declared full-suite command (package.json `test` script, else the CLAUDE.md `Tests:` bullet)
// Exit codes: run = the command's; check 0 PASS, 1 none; every command 2 for a usage error, a folder that is not a repo, or an
//   undeclared or different suite command.
// Invariants: a record is written only when the command exits 0, the tree had no uncommitted change before it started, and HEAD's
//   tree is unchanged after it. Records live in lib/store.mjs. Exports: hasPass, declaredSuite (for git-tidy land).
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { commitOf, declaredSuite, hasPass, isCleanTree, recordPass, treeOf } from './lib/store.mjs';

export { declaredSuite, hasPass };

const EXIT_NONE = 1;
const EXIT_USAGE = 2;
const TAIL_LINES = 60; // lines of a failed quiet run that are printed
const USAGE = 'usage: test-pass.mjs run [--repo <dir>] [--suite] [--quiet] [-- <cmd...>] | check <sha> [--repo <dir>] [--suite] | suite show [--repo <dir>]';

class UsageError extends Error {}

/** Splits argv at the first `--`: [before, command words]. */
const splitCommand = (argv) => {
  const at = argv.indexOf('--');
  return at === -1 ? [argv, []] : [argv.slice(0, at), argv.slice(at + 1)];
};

function parseArgs(argv) {
  const [words, command] = splitCommand(argv);
  const options = { name: words[0], repo: process.cwd(), suite: false, quiet: false, positional: [], command };
  const rest = words.slice(1);
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--suite') options.suite = true;
    else if (rest[i] === '--quiet') options.quiet = true;
    else if (rest[i] === '--repo' && rest[i + 1] !== undefined) options.repo = rest[++i];
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
  const result = command.shell
    ? spawnSync(command.text, { cwd: repo, shell: true, stdio, encoding: 'utf8', maxBuffer: 256 << 20 })
    : spawnSync(command.args[0], command.args.slice(1), { cwd: repo, stdio, encoding: 'utf8', maxBuffer: 256 << 20 });
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

function main(argv) {
  try {
    const options = parseArgs(argv);
    if (options.name === 'run') return run(options);
    if (options.name === 'check') return check(options);
    if (options.name === 'suite' && options.positional[0] === 'show') return showSuite(options);
    throw new UsageError(USAGE);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`test-pass: ${error.message}`);
    return EXIT_USAGE;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
