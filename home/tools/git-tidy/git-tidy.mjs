#!/usr/bin/env node
// CLI of `git-tidy`: checks that the history is one straight line (no merge commits) and finds the branches and worktrees
// whose work is already on the base; `prune` removes exactly those, and only when it can prove they are merged.
// Usage: git-tidy.mjs check [dir] [--base <branch>] [--json]
//        git-tidy.mjs prune [dir] [--base <branch>] [--apply] [--include-recent] [--json]
//        git-tidy.mjs land <branch> [dir] [--base <branch>] [--rebase-only] --tip <sha> [--brief <file>] [--matrix <abs lane matrix>] [--json]
//   --tip is the full sha the caller expects the lane to be at: required for a full land (exit 2 without it), optional with --rebase-only;
//   a branch that is not at it exits 9 before anything changes; a full land lands only that sha (a rebase that rewrites it is exit 5, the lane
//   stays rebased: land again with the new tip). The removed flag `--checks` and the old UI waiver flag (any `--...waive...`) are refused with exit 2.
//   --brief is the lane's brief: the request the UI check plan reads, and the paths that may add files over the size limit;
//   --matrix is the lane's coverage matrix (its Figma frames, widths and locales raise the plan; never lower it).
//        git-tidy.mjs range <sha> [dir] [--base <branch>] [--landed <sha>] [--json]
//        --include-recent  lifts only the rule that keeps a worktree used in the last 60 minutes, and not for a lane
//                          with no commit of its own yet (it stays protected for those 60 minutes)
// land: rebases the lane onto the base, fast-forwards the base and cleans up (no test or review step). Exit: 0 landed and check
//   clean (or --rebase-only done), 1 landed with findings left, 2 usage or base folder not
//   ready, 3 conflict, 5 base moved (during the landing, or since the `--tip` was rebased), 6 ui-proof: the check plan of the rebased
//   diff (`ui-proof check --plan --base <base> --tip <rebased tip>` with the brief and the matrix, lib/ui-plan-check.mjs) is not proved, or
//   it is not none and no --brief was given, or the ui-proof tool cannot be loaded (always on: no waiver); a proved plan other than pixel
//   prints `ui plan <depth>: proved` and its `follow-up:` lines (JSON `uiPlan`), 7 new-file-size:
//   the lane adds a file over the commit gate's MAX_NEW_FILE_BYTES that the `--brief` file does not name (no brief names none).
//   8 upstream-moved: after a fetch of the base's upstream (timeout; offline is a WARN line), the upstream holds commits the base lacks:
//   `git pull --rebase` first. 9 tip-moved: `refs/heads/<branch>` is not the `--tip` sha (changed since the caller read it; nothing was touched).
//   A landing prints the published count (`published N ...`; JSON `upstream`).
//   A landing prints `from <sha>`, the base tip before the fast-forward (JSON: `from`).
// range: the base's reflog step that landed the given sha's patches (lib/landed-range.mjs), printed as `from <sha>` and `to <sha>`
//   (JSON `{ from, to }`); exit 0 found, 1 not in the reflog, 2 usage.
// Exit codes: check 0 clean, 1 findings; prune 0 (also when there is nothing to do), 1 when --apply could not remove
// something it planned to (the line says why); both 2 for a usage error, a folder that is not a git repository, a base
// branch that cannot be found, a main checkout with no branch checked out or a lane checked out, a git command that fails
// unexpectedly, or (prune --apply) a repository in the middle of a rebase, merge or similar.
//        git-tidy.mjs lane claim|list|release|reclaim --repo <abs> ...: the lane folder pool, its own flags and exit codes (lib/lane-cli.mjs)
// Invariants: logic lives in lib/; this file parses arguments, prints and sets the exit code. Only `prune --apply`, `land` and `lane`
//   (claim, release, reclaim) write, but for the base mark every command writes for a base read from the main checkout
//   (`branch.<b>.cs-base`, lib/repo.mjs openRepo; a failed mark is a stderr warning).
import { runCheck } from './lib/check.mjs';
import { UsageError } from './lib/git.mjs';
import { readFileSync } from 'node:fs';
import { landLane } from './lib/land.mjs';
import { runLaneCommand } from './lib/lane-cli.mjs';
import { landedRange } from './lib/landed-range.mjs';
import { pruneRepo } from './lib/prune.mjs';
import { openRepo } from './lib/repo.mjs';
import { formatCheck, formatLand, formatPrune, landExitCode, pruneExitCode } from './lib/report.mjs';

const EXIT_FINDINGS = 1;
const EXIT_USAGE = 2;
const EXIT_NOT_FOUND = 1;
const MAX_BRIEF_BYTES = 1024 * 1024; // a brief is text; the first MB is what the commit gate reads too
const USAGE = 'usage: git-tidy.mjs check [dir] [--base <branch>] [--json]\n       git-tidy.mjs prune [dir] [--base <branch>] [--apply] [--include-recent] [--json]\n       git-tidy.mjs land <branch> [dir] [--base <branch>] [--rebase-only] [--tip <sha>] [--brief <file>] [--matrix <abs>] [--json]\n       git-tidy.mjs range <sha> [dir] [--base <branch>] [--landed <sha>] [--json]\n       git-tidy.mjs lane claim|list|release|reclaim --repo <abs> ... (run `git-tidy.mjs lane` for its usage)';
const FULL_SHA = /^[0-9a-f]{40}$/;
const COMMANDS = ['check', 'prune', 'land', 'range'];
const VALUE_FLAGS = { '--brief': ['land', 'brief'], '--tip': ['land', 'tip'], '--landed': ['range', 'landed'], '--matrix': ['land', 'matrix'] };
const REMOVED_FLAGS = { '--checks': 'landing has no test or review step, and the UI proof always runs' };
// The owner's old UI waiver flag (removed 2026-11-23, R28: no waivers) and any flag like it: refused as removed, with the reason.
const WAIVER_FLAG = /^--[\w-]*waive/;
const WAIVER_REMOVED = 'there are no UI waivers: the check plan of the rebased diff decides the UI proof (ui-proof plan)';
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/])/;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command)) throw new UsageError(USAGE);
  const options = { command, branch: null, dir: null, base: null, json: false, apply: false, includeRecent: false, rebaseOnly: false, brief: null, tip: null, landed: null, matrix: null };
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
    } else if (Object.hasOwn(REMOVED_FLAGS, arg)) throw new UsageError(`${arg} was removed: ${REMOVED_FLAGS[arg]}. ${USAGE}`);
    else if (WAIVER_FLAG.test(arg)) throw new UsageError(`${arg} was removed: ${WAIVER_REMOVED}. ${USAGE}`);
    else if (arg.startsWith('--')) throw new UsageError(`unknown flag ${arg} for ${command}. ${USAGE}`);
    else if ((command === 'land' || command === 'range') && options.branch === null) options.branch = arg;
    else if (options.dir === null) options.dir = arg;
    else throw new UsageError(`one folder only. ${USAGE}`);
  }
  if (command === 'land' && options.branch === null) throw new UsageError(`land needs the lane's branch name. ${USAGE}`);
  if (command === 'range' && options.branch === null) throw new UsageError(`range needs the sha to look for. ${USAGE}`);
  if (options.tip !== null && !FULL_SHA.test(options.tip)) throw new UsageError(`--tip needs a full 40-character sha, got ${JSON.stringify(options.tip)}. ${USAGE}`);
  if (command === 'land' && !options.rebaseOnly && options.tip === null) throw new UsageError(`land needs --tip <full sha of the lane's tip>. ${USAGE}`);
  if (options.matrix !== null && !ABSOLUTE_PATH.test(options.matrix)) throw new UsageError(`--matrix must be an absolute path, got ${JSON.stringify(options.matrix)}`);
  options.dir ??= process.cwd();
  return options;
}

function runPrune(repo, options) {
  const items = pruneRepo(repo, { apply: options.apply, includeRecent: options.includeRecent });
  console.log(formatPrune({ base: repo.base, baseSource: repo.baseSource, apply: options.apply, items }, options.json));
  return options.apply ? pruneExitCode(items) : 0;
}

/**
 * The UI step of a full land (lib/ui-plan-check.mjs, which uses the ui-proof tool next to this one): `check(repoDir, baseSha, tip)` gives
 * null when the check plan is proved, else the reason; `outcome()` is the last check's `{ plan, depth }`: what it proved (`{ depth,
 * followUps }`, or null for no row pointer) and the depth it printed (null: today's pixel-qa check). Always on, no waiver: when the step
 * cannot be loaded every landing is refused with that reason (fail closed).
 */
async function loadUiCheck(options) {
  let runPlanCheck;
  try {
    ({ runPlanCheck } = await import('./lib/ui-plan-check.mjs'));
  } catch (error) {
    return { check: () => `the ui-proof tool cannot be loaded (${error.message}), so the UI check plan cannot be proved`, outcome: () => ({ plan: null, depth: null }) };
  }
  let last = { plan: null, depth: null };
  const check = (repoDir, baseSha, tip) => {
    const { why, plan, depth } = runPlanCheck({ repoDir, baseSha, tip, brief: options.brief, matrix: options.matrix });
    last = { plan, depth };
    return why;
  };
  return { check, outcome: () => last };
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
  // Rebase, ff-only and prune always run; the new-file size rule and the UI check plan hold every full landing.
  const ui = await loadUiCheck(options);
  const checks = options.rebaseOnly ? {} : { uiCheck: ui.check, briefText };
  const landed = landLane(repo, options.branch, { rebaseOnly: options.rebaseOnly, tip: options.tip, ...checks });
  // The JSON keys are added only when set, so a lane with no UI file (and a pixel plan) prints what it printed before.
  const { plan, depth } = ui.outcome();
  const extra = landed.status === 'landed' && plan !== null ? { uiPlan: plan } : landed.status === 'ui-proof' && depth !== null ? { uiDepth: depth } : {};
  const result = { ...landed, ...extra };
  console.log(formatLand(result, options.json));
  return landExitCode(result);
}

async function main(argv) {
  if (argv[0] === 'lane') return runLaneCommand(argv.slice(1)); // its own flags and exit codes (lib/lane-cli.mjs)
  try {
    const options = parseArgs(argv);
    const repo = openRepo(options.dir, options.base);
    if (repo.baseMarkWarning !== null) console.error(`git-tidy: warning: ${repo.baseMarkWarning}`);
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
