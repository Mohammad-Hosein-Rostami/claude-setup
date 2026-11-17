// C37 advice for the Bash guard, all four git advices in one call. Exports: gitAdvice(command, cwd, env, deps) -> string[] (the advice texts, in
// order: merge commit, branch move, copy branch, no PASS), copyBranchStem(name, repoDir) -> stem | null (also used by the workflow `build`),
// COPY_BRANCH_ADVICE_PATTERN and NO_PASS_ADVICE_PATTERN (what lib/reason-classes.mjs matches: the advice text holds a branch name or a commit,
// so its class is a full-text pattern over a fixed charset, never "contains the words").
//  - Merge commit and branch move: lib/merge-commit.mjs and lib/branch-move.mjs, pure.
//  - Copy branch: `git checkout -b|-B X`, `git switch -c|-C|--create X`, `git branch X`, `git worktree add -b|-B X` where X is `<stem>-<n>`, `-fix`,
//    `-fixes`, `-v<n>` or `-redo` and the branch `<stem>` exists in the folder: a re-done lane continues the same branch. The folder is the
//    cwd, a `cd <dir> &&` before the command, or `git -C <dir>`.
//  - No PASS: `git merge --ff-only <ref>` in a folder on main, master or develop, when the test-pass tool has no full-suite PASS for the commit
//    <ref> names: land with `git-tidy land`, or run the suite in the lane worktree first.
// Both new advices ask git (a hardened call: no hooks, no fsmonitor, no pager, no prompt, a 5 s limit) and decide from its answer; ANY git error,
// timeout, unknown answer or exception gives no advice for that rule, so the command goes through (an advice never blocks what it cannot judge).
// The PASS answer comes from `home/tools/test-pass/test-pass.mjs check <sha> --repo <dir> --suite` (exit 0 PASS, 1 none, else unknown); when that tool
// is not installed there is no PASS advice. `deps` lets a test replace the git runner and the PASS check.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { branchMoveAdvice } from './branch-move.mjs';
import { asGitSubcommand, commandOf } from './command-of.mjs';
import { parseGitArgs } from './git-options.mjs';
import { mergeCommitAdvice, withoutSubstitutions } from './merge-commit.mjs';
import { segments, stripHeredocs } from './shell-words.mjs';

const GIT_TIMEOUT_MS = 5000;
const BASE_BRANCHES = new Set(['main', 'master', 'develop']);
const COPY_BRANCH_NAME = /^(.+)-(?:\d+|fix|fixes|v\d+|redo)$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/; // a branch or ref we are willing to put in advice text and hand to git
const MAY_NEED_ADVICE = /checkout|switch|branch|worktree|merge/; // cheap first look, after quotes, backslashes and blanks are dropped
const SPELLING_BREAKS = /["'\\\s]/g;
const TEST_PASS_TOOL = fileURLToPath(new URL('../../tools/test-pass/test-pass.mjs', import.meta.url));
const SHORT_SHA = 12;
const PASS_UNKNOWN = Symbol('unknown');

const KEEP_SAME_BRANCH = 'a re-done lane continues the same branch (C37)';
const copyRetry = 'If a separate branch is really intended, send the same command again and it runs.';
const passRetry = 'If this merge is really intended, send the same command again and it runs.';
/** Advice text for creating `name` while `stem` exists. Both are SAFE_REF text. */
const copyBranchAdvice = (stem, name) => `${KEEP_SAME_BRANCH}: branch ${stem} already exists, so switch to it (git switch ${stem}), rebase it onto the base `
  + `and keep committing there instead of creating ${name}. ${copyRetry}`;
/** Advice text for a fast-forward merge of `sha` into a base branch with no suite PASS. */
const noPassAdvice = (sha) => `no full-suite PASS at ${sha}: run \`test-pass run --suite\` in the lane worktree, or land with \`git-tidy land\` (C37). ${passRetry}`;

const escapeText = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const REF_TEXT = '[A-Za-z0-9][A-Za-z0-9._/-]*';
export const COPY_BRANCH_ADVICE_PATTERN = new RegExp(`^${escapeText(KEEP_SAME_BRANCH)}: branch (${REF_TEXT}) already exists, so switch to it \\(git switch \\1\\), `
  + `rebase it onto the base and keep committing there instead of creating ${REF_TEXT}\\. ${escapeText(copyRetry)}$`);
export const NO_PASS_ADVICE_PATTERN = new RegExp(`^no full-suite PASS at [0-9a-f]{${SHORT_SHA}}: ${escapeText('run `test-pass run --suite` in the lane worktree, or land with `git-tidy land` (C37). ')}${escapeText(passRetry)}$`);

/** Hardened git: no repository hooks or fsmonitor, no pager, no prompt, no GIT_* from the caller; trimmed stdout, or null on any failure. */
function runGit(dir, args, env = process.env) {
  const clean = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('GIT_')));
  const options = { cwd: dir, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, env: { ...clean, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1' } };
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'core.hooksPath=/dev/null', ...args], options);
  return result.error === undefined && result.status === 0 ? result.stdout.trim() : null;
}

/** The PASS tool's answer for `sha` in `dir`: true (exit 0), false (exit 1: no record) or PASS_UNKNOWN (tool missing or any other exit). */
function suitePassed(dir, sha) {
  if (!existsSync(TEST_PASS_TOOL)) return PASS_UNKNOWN;
  const result = spawnSync(process.execPath, [TEST_PASS_TOOL, 'check', sha, '--repo', dir, '--suite'], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  if (result.error !== undefined) return PASS_UNKNOWN;
  return result.status === 0 ? true : result.status === 1 ? false : PASS_UNKNOWN;
}

const DEFAULT_DEPS = { git: runGit, hasPass: suitePassed };

/**
 * @param {string} name a branch about to be created
 * @param {string} repoDir a folder of the repository
 * @param {typeof runGit} git the git runner (a test replaces it)
 * @returns {string | null} the stem when `name` is `<stem>-<n>|-fix|-fixes|-v<n>|-redo` and a local branch `<stem>` exists; null otherwise, and on any git error
 */
export function copyBranchStem(name, repoDir, git = runGit) {
  const stem = COPY_BRANCH_NAME.exec(name)?.[1];
  if (stem === undefined || !SAFE_REF.test(stem) || !SAFE_REF.test(name)) return null;
  return git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${stem}`]) === null ? null : stem;
}

/** Positional (non-option) words of a subcommand's arguments, up to `--`. */
const positionalWords = (rest) => rest.slice(0, rest.indexOf('--') === -1 ? rest.length : rest.indexOf('--')).filter((word) => !word.startsWith('-'));
/** The word after the first of `flags` in `rest`, or undefined when no flag is there. */
function valueAfter(rest, flags) {
  const at = rest.findIndex((word) => flags.includes(word));
  return at === -1 ? undefined : rest[at + 1];
}
const BRANCH_OTHER_MODES = new Set(['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-l', '--list', '-a', '--all', '-r', '--remotes', '--show-current', '-u', '--set-upstream-to', '--unset-upstream', '--edit-description']);

/** The branch name a git subcommand reading would create, or undefined. */
function createdBranch({ sub, rest }) {
  if (sub === 'checkout') return valueAfter(rest, ['-b', '-B']);
  if (sub === 'switch') return valueAfter(rest, ['-c', '-C', '--create', '--force-create']);
  if (sub === 'branch') return rest.some((word) => BRANCH_OTHER_MODES.has(word)) ? undefined : positionalWords(rest)[0];
  return sub === 'worktree' && rest[0] === 'add' ? valueAfter(rest, ['-b', '-B']) : undefined;
}

/** The folder a `cd` word moves to (literal paths only), else the same folder. */
function afterCd(dir, args) {
  const target = args.find((word) => !word.startsWith('-'));
  if (target === undefined || /[$`*?]/.test(target)) return dir;
  return resolve(dir, target === '~' || target.startsWith('~/') ? target.replace('~', homedir()) : target);
}

/** The folder git runs in: `dir` moved by each literal `-C` option of this reading (relative ones from the folder before). */
const gitFolder = (dir, options) => options.filter((option) => option[0] === '-C' && option[1] !== undefined).reduce((from, [, next]) => (isAbsolute(next) ? next : resolve(from, next)), dir);

/** Advice for one git command reading: a copy branch or a fast-forward merge into a base without a PASS. */
function readingAdvice({ sub, rest }, options, dir, deps, env) {
  const folder = gitFolder(dir, options);
  const name = createdBranch({ sub, rest });
  if (name !== undefined) {
    const stem = copyBranchStem(name, folder, (where, args) => deps.git(where, args, env));
    return stem === null ? [] : [copyBranchAdvice(stem, name)];
  }
  if (sub !== 'merge' || !rest.includes('--ff-only')) return [];
  const ref = positionalWords(rest)[0];
  if (ref === undefined || !SAFE_REF.test(ref)) return [];
  const branch = deps.git(folder, ['symbolic-ref', '--short', '-q', 'HEAD'], env);
  if (branch === null || !BASE_BRANCHES.has(branch)) return [];
  const sha = deps.git(folder, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], env);
  if (sha === null || deps.hasPass(folder, sha) !== false) return [];
  return [noPassAdvice(sha.slice(0, SHORT_SHA))];
}

/** The copy-branch and no-PASS advice of the command line; a failure anywhere gives none. */
function repositoryAdvice(command, cwd, env, deps) {
  if (!MAY_NEED_ADVICE.test(command.replace(SPELLING_BREAKS, ''))) return [];
  const found = [];
  let dir = cwd;
  for (const words of segments(withoutSubstitutions(stripHeredocs(command)))) {
    const { cmd, args } = asGitSubcommand(commandOf(words));
    if (cmd === 'cd') dir = afterCd(dir, args);
    if (cmd !== 'git') continue;
    const { options, subcommands } = parseGitArgs(args);
    for (const reading of subcommands) found.push(...readingAdvice(reading, options, dir, deps, env));
  }
  return found;
}

/**
 * @param {string} command raw command text
 * @param {string} cwd the folder the command starts in
 * @param {Record<string, string | undefined>} env environment handed to git
 * @param {{git?: typeof runGit, hasPass?: (dir: string, sha: string) => boolean | symbol | undefined}} deps replaceable git runner and PASS check
 * @returns {string[]} advice texts without repeats; [] when none applies or anything could not be judged
 */
export function gitAdvice(command, cwd, env = process.env, deps = {}) {
  const both = { ...DEFAULT_DEPS, ...deps };
  let repository = [];
  try {
    repository = repositoryAdvice(command, cwd, env, both);
  } catch {
    repository = []; // a rule that cannot judge stays silent: the other advices and every ask are unaffected
  }
  return [...new Set([...mergeCommitAdvice(command), ...branchMoveAdvice(command), ...repository])];
}
