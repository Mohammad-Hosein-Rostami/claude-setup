#!/usr/bin/env node
// CLI of `git-tidy`: checks that the history is one straight line (no merge commits) and finds the branches and worktrees
// whose work is already on the base; `prune` removes exactly those, and only when it can prove they are merged.
// Usage: git-tidy.mjs check [dir] [--base <branch>] [--json]
//        git-tidy.mjs prune [dir] [--base <branch>] [--apply] [--include-recent] [--json]
//        git-tidy.mjs land <branch> [dir] [--base <branch>] [--rebase-only] [--brief <file>] [--checks <cat,...>] [--json]
//   --checks names categories the owner turned on (the land workflow passes its args.checks); it can only add checks, never turn one off.
//        git-tidy.mjs range <reviewed-sha> [dir] [--base <branch>] [--landed <sha>] [--json]
//        --include-recent  lifts only the rule that keeps a worktree used in the last 60 minutes, and not for a lane
//                          with no commit of its own yet (it stays protected for those 60 minutes)
// land: rebases the lane onto the base, needs a full-suite PASS (test-pass tool) on the rebased tip, fast-forwards the base and
//   cleans up. Exit: 0 landed and check clean (or --rebase-only done), 1 landed with findings left, 2 usage or base folder not
//   ready, 3 conflict, 4 no suite PASS at the tip, 5 base moved during the landing, 6 ui-proof: the UI files differ from the base and
//   `ui-proof check --tip <rebased tip>` does not exit 0 (or the ui-proof tool cannot be loaded; no flag turns it off), 7 new-file-size:
//   the lane adds a file over the commit gate's MAX_NEW_FILE_BYTES that the `--brief` file does not name (no brief names none).
//   8 upstream-moved: after a fetch of the base's upstream (timeout; offline is a WARN line), the upstream holds commits the base lacks:
//   `git pull --rebase` first. A landing prints the published count (`published N ...`; JSON `upstream`).
//   A landing prints `from <sha>`, the base tip before the fast-forward (JSON: `from`).
// range: the base's reflog step that landed the reviewed sha's patches (lib/landed-range.mjs), printed as `from <sha>` and `to <sha>`
//   (JSON `{ from, to }`); exit 0 found, 1 not in the reflog, 2 usage.
// Exit codes: check 0 clean, 1 findings; prune 0 (also when there is nothing to do), 1 when --apply could not remove
// something it planned to (the line says why); both 2 for a usage error, a folder that is not a git repository, a base
// branch that cannot be found, a git command that fails unexpectedly, or (prune --apply) a repository in the middle of a
// rebase, merge or similar, or a base not given with --base while main, master or develop all exist.
// Invariants: logic lives in lib/; this file parses arguments, prints and sets the exit code. Only `prune --apply` writes.
import { runCheck } from './lib/check.mjs';
import { UsageError } from './lib/git.mjs';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOn } from '../../hooks/lib/checks-on.mjs';
import { landLane } from './lib/land.mjs';
import { landedRange } from './lib/landed-range.mjs';
import { pruneRepo } from './lib/prune.mjs';
import { openRepo } from './lib/repo.mjs';
import { formatCheck, formatLand, formatPrune, landExitCode, pruneExitCode } from './lib/report.mjs';

const EXIT_FINDINGS = 1;
const EXIT_USAGE = 2;
const EXIT_NOT_FOUND = 1;
const MAX_BRIEF_BYTES = 1024 * 1024; // a brief is text; the first MB is what the commit gate reads too
const UI_PROOF_TIMEOUT_MS = 60_000;
const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: git-tidy.mjs check [dir] [--base <branch>] [--json]\n       git-tidy.mjs prune [dir] [--base <branch>] [--apply] [--include-recent] [--json]\n       git-tidy.mjs land <branch> [dir] [--base <branch>] [--rebase-only] [--brief <file>] [--checks <cat,...>] [--json]\n       git-tidy.mjs range <reviewed-sha> [dir] [--base <branch>] [--landed <sha>] [--json]';
const COMMANDS = ['check', 'prune', 'land', 'range'];
const VALUE_FLAGS = { '--brief': ['land', 'brief'], '--checks': ['land', 'checks'], '--landed': ['range', 'landed'] };

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command)) throw new UsageError(USAGE);
  const options = { command, branch: null, dir: null, base: null, json: false, apply: false, includeRecent: false, rebaseOnly: false, brief: null, checks: null, landed: null };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--apply' && command === 'prune') options.apply = true;
    else if (arg === '--include-recent' && command === 'prune') options.includeRecent = true;
    else if (arg === '--rebase-only' && command === 'land') options.rebaseOnly = true;
    else if (VALUE_FLAGS[arg]?.[0] === command) {
      if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) throw new UsageError(`${arg} needs a value. ${USAGE}`);
      options[VALUE_FLAGS[arg][1]] = rest[++i];
    } else if (arg === '--base') {
      if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) throw new UsageError(`--base needs a branch name. ${USAGE}`);
      options.base = rest[++i];
    } else if (arg.startsWith('--')) throw new UsageError(`unknown flag ${arg} for ${command}. ${USAGE}`);
    else if ((command === 'land' || command === 'range') && options.branch === null) options.branch = arg;
    else if (options.dir === null) options.dir = arg;
    else throw new UsageError(`one folder only. ${USAGE}`);
  }
  if (command === 'land' && options.branch === null) throw new UsageError(`land needs the lane's branch name. ${USAGE}`);
  if (command === 'range' && options.branch === null) throw new UsageError(`range needs the reviewed sha. ${USAGE}`);
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

// The UI proof belongs to the ui-proof tool next to this one (its one definition of UI files, F7). It cannot be turned off: when the tool
// cannot be loaded, every landing is refused with that reason (fail closed), since no one can tell whether UI files changed.
async function loadUiCheck() {
  let changedUiFiles;
  try {
    ({ changedUiFiles } = await import('../ui-proof/lib/ui-files.mjs'));
  } catch (error) {
    return () => `the ui-proof tool cannot be loaded (${error.message}), so the UI files cannot be checked`;
  }
  return (repoDir, baseSha, tip) => {
    if (changedUiFiles(repoDir, baseSha, tip).length === 0) return null;
    const run = spawnSync(process.execPath, [join(TOOLS_DIR, 'ui-proof', 'ui-proof.mjs'), 'check', '--tip', tip, '--repo', repoDir], { encoding: 'utf8', timeout: UI_PROOF_TIMEOUT_MS });
    if (run.status === 0) return null;
    return (run.stdout || run.stderr || `ui-proof check did not finish (${run.error?.message ?? `exit ${run.status}`})`).trim().split('\n')[0];
  };
}

/** The brief's text (its first MB), or null with no --brief; an unreadable brief is a usage error, never "no brief". */
function briefTextOf(file) {
  if (file === null) return null;
  try {
    return readFileSync(file, 'utf8').slice(0, MAX_BRIEF_BYTES);
  } catch (error) {
    throw new UsageError(`--brief ${file} cannot be read: ${error.message}`);
  }
}

function runRange(repo, options) {
  const found = landedRange(repo, options.branch, { landed: options.landed });
  console.log(options.json ? JSON.stringify(found ?? { from: null, to: null }) : (found ? `from ${found.from}\nto ${found.to}` : 'range: not found in the base reflog'));
  return found ? 0 : EXIT_NOT_FOUND;
}

async function runLand(repo, options) {
  const briefText = briefTextOf(options.brief);
  // The suite PASS and the UI proof are checks: they hold a landing only when the owner turned `test` / `ui` on with /check for the
  // session that lands ($CLAUDE_CODE_SESSION_ID; hooks/lib/checks-on.mjs, spec r9-checks-off). Rebase, ff-only and prune always run.
  const checkOn = (category) => isOn(category) || String(options.checks ?? '').split(',').includes(category); // --checks only adds
  const hasPass = checkOn('test') ? await loadHasPass() : () => true;
  const uiCheck = checkOn('ui') ? await loadUiCheck() : () => null;
  const checks = options.rebaseOnly ? { hasPass: () => false } : { hasPass, uiCheck, briefText };
  const result = landLane(repo, options.branch, { rebaseOnly: options.rebaseOnly, ...checks });
  console.log(formatLand(result, options.json));
  return landExitCode(result);
}

async function main(argv) {
  try {
    const options = parseArgs(argv);
    const repo = openRepo(options.dir, options.base);
    if (options.command === 'land') return await runLand(repo, options);
    if (options.command === 'range') return runRange(repo, options);
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
