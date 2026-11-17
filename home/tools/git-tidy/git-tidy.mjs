#!/usr/bin/env node
// CLI of `git-tidy`: checks that the history is one straight line (no merge commits) and finds the branches and worktrees
// whose work is already on the base; `prune` removes exactly those, and only when it can prove they are merged.
// Usage: git-tidy.mjs check [dir] [--base <branch>] [--json]
//        git-tidy.mjs prune [dir] [--base <branch>] [--apply] [--include-recent] [--json]
//        git-tidy.mjs land <branch> [dir] [--base <branch>] [--rebase-only] [--json]
//        --include-recent  lifts only the rule that keeps a worktree used in the last 60 minutes, and not for a lane
//                          with no commit of its own yet (it stays protected for those 60 minutes)
// land: rebases the lane onto the base, needs a full-suite PASS (test-pass tool) on the rebased tip, fast-forwards the base and
//   cleans up. Exit: 0 landed and check clean (or --rebase-only done), 1 landed with findings left, 2 usage or base folder not
//   ready, 3 conflict, 4 no suite PASS at the tip, 5 base moved during the landing.
// Exit codes: check 0 clean, 1 findings; prune 0 (also when there is nothing to do), 1 when --apply could not remove
// something it planned to (the line says why); both 2 for a usage error, a folder that is not a git repository, a base
// branch that cannot be found, a git command that fails unexpectedly, or (prune --apply) a repository in the middle of a
// rebase, merge or similar, or a base not given with --base while main, master or develop all exist.
// Invariants: logic lives in lib/; this file parses arguments, prints and sets the exit code. Only `prune --apply` writes.
import { runCheck } from './lib/check.mjs';
import { UsageError } from './lib/git.mjs';
import { landLane } from './lib/land.mjs';
import { pruneRepo } from './lib/prune.mjs';
import { openRepo } from './lib/repo.mjs';
import { formatCheck, formatLand, formatPrune, landExitCode, pruneExitCode } from './lib/report.mjs';

const EXIT_FINDINGS = 1;
const EXIT_USAGE = 2;
const USAGE = 'usage: git-tidy.mjs check [dir] [--base <branch>] [--json]\n       git-tidy.mjs prune [dir] [--base <branch>] [--apply] [--include-recent] [--json]\n       git-tidy.mjs land <branch> [dir] [--base <branch>] [--rebase-only] [--json]';
const COMMANDS = ['check', 'prune', 'land'];

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command)) throw new UsageError(USAGE);
  const options = { command, branch: null, dir: null, base: null, json: false, apply: false, includeRecent: false, rebaseOnly: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--apply' && command === 'prune') options.apply = true;
    else if (arg === '--include-recent' && command === 'prune') options.includeRecent = true;
    else if (arg === '--rebase-only' && command === 'land') options.rebaseOnly = true;
    else if (arg === '--base') {
      if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) throw new UsageError(`--base needs a branch name. ${USAGE}`);
      options.base = rest[++i];
    } else if (arg.startsWith('--')) throw new UsageError(`unknown flag ${arg} for ${command}. ${USAGE}`);
    else if (command === 'land' && options.branch === null) options.branch = arg;
    else if (options.dir === null) options.dir = arg;
    else throw new UsageError(`one folder only. ${USAGE}`);
  }
  if (command === 'land' && options.branch === null) throw new UsageError(`land needs the lane's branch name. ${USAGE}`);
  options.dir ??= process.cwd();
  return options;
}

function runPrune(repo, options) {
  const items = pruneRepo(repo, { apply: options.apply, includeRecent: options.includeRecent });
  console.log(formatPrune({ base: repo.base, baseSource: repo.baseSource, apply: options.apply, items }, options.json));
  return options.apply ? pruneExitCode(items) : 0;
}

// The suite PASS record belongs to the test-pass tool next to this one; without it nothing can have a PASS, so landing stops at exit 4.
async function loadHasPass() {
  try {
    return (await import('../test-pass/test-pass.mjs')).hasPass;
  } catch (error) {
    console.error(`git-tidy: the test-pass tool cannot be loaded (${error.message}); no commit has a recorded PASS`);
    return () => false;
  }
}

async function runLand(repo, options) {
  const result = landLane(repo, options.branch, { rebaseOnly: options.rebaseOnly, hasPass: options.rebaseOnly ? () => false : await loadHasPass() });
  console.log(formatLand(result, options.json));
  return landExitCode(result);
}

async function main(argv) {
  try {
    const options = parseArgs(argv);
    const repo = openRepo(options.dir, options.base);
    if (options.command === 'land') return await runLand(repo, options);
    if (options.command === 'prune') return runPrune(repo, options);
    const result = runCheck(repo);
    console.log(formatCheck({ base: repo.base, baseSource: repo.baseSource, ...result }, options.json));
    return result.findings.length > 0 ? EXIT_FINDINGS : 0;
  } catch (error) {
    // Any failure is exit 2, never Node's default 1: 1 must only ever mean findings or something left unremoved.
    console.error(`git-tidy: ${error instanceof UsageError ? '' : 'unexpected git failure: '}${error.message}`);
    return EXIT_USAGE;
  }
}

process.exitCode = await main(process.argv.slice(2));
