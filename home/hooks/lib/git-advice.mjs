// C37 advice for the Bash guard, the three git advices in one call. Exports: gitAdvice(command, cwd, env, deps) -> string[] (the advice texts, in
// order: merge commit, branch move, copy branch), copyBranchStem(name, repoDir) -> stem | null,
// COPY_BRANCH_ADVICE_PATTERN (what lib/reason-classes.mjs matches: the advice text holds a branch name, so its class is a full-text pattern
// over a fixed charset, never "contains the words").
//  - Merge commit and branch move: lib/merge-commit.mjs and lib/branch-move.mjs, pure.
//  - Copy branch: `git checkout -b|-B X`, `git switch -c|-C|--create X`, `git branch X`, `git worktree add -b|-B X` where X is `<stem>-<n>`, `-fix`,
//    `-fixes`, `-v<n>` or `-redo` and the branch `<stem>` exists in the folder: a re-done lane continues the same branch. The folder is the
//    cwd, a `cd <dir> &&` before the command, or `git -C <dir>`.
// The copy-branch advice asks git (a hardened call: no hooks, no fsmonitor, no embedded bare repository, no pager, no prompt) and decides from its answer; ANY
// git error, timeout, unknown answer or exception gives no advice for that rule, so the command goes through (an advice never blocks what it cannot judge).
// All git calls of one command line share ONE time budget (ADVICE_BUDGET_MS): a repository that makes git hang (a FIFO as .git/HEAD) costs a
// command at most that long, never one timeout per git reading, so the guard hook cannot run into its own timeout. After a `cd` it cannot read
// (`cd "$X"`, `pushd`, `cd -`) or with an unknown start folder (cwd null) the folder is unknown and a reading gives no advice.
// `deps` lets a test replace the git runner.
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { branchMoveAdvice } from './branch-move.mjs';
import { asGitSubcommand, commandOf } from './command-of.mjs';
import { parseGitArgs } from './git-options.mjs';
import { mergeCommitAdvice, withoutSubstitutions } from './merge-commit.mjs';
import { segments, stripHeredocs } from './shell-words.mjs';

const ADVICE_BUDGET_MS = 2000; // for every git call of one command line together
const COPY_BRANCH_NAME = /^(.+)-(?:\d+|fix|fixes|v\d+|redo)$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/; // a branch or ref we are willing to put in advice text and hand to git
const MAY_NEED_ADVICE = /checkout|switch|branch|worktree|merge/; // cheap first look, after quotes, backslashes and blanks are dropped
const SPELLING_BREAKS = /["'\\\s]/g;
const KEEP_SAME_BRANCH = 'a re-done lane continues the same branch (C37)';
const copyRetry = 'If a separate branch is really intended, send the same command again and it runs.';
/** Advice text for creating `name` while `stem` exists. Both are SAFE_REF text. */
const copyBranchAdvice = (stem, name) => `${KEEP_SAME_BRANCH}: branch ${stem} already exists, so switch to it (git switch ${stem}), rebase it onto the base `
  + `and keep committing there instead of creating ${name}. ${copyRetry}`;
const escapeText = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const REF_TEXT = '[A-Za-z0-9][A-Za-z0-9._/-]*';
export const COPY_BRANCH_ADVICE_PATTERN = new RegExp(`^${escapeText(KEEP_SAME_BRANCH)}: branch (${REF_TEXT}) already exists, so switch to it \\(git switch \\1\\), `
  + `rebase it onto the base and keep committing there instead of creating ${REF_TEXT}\\. ${escapeText(copyRetry)}$`);


/**
 * Hardened git: no repository hooks or fsmonitor, no embedded bare repository, no pager, no prompt, no GIT_* from the caller.
 * @param {string} dir folder to run in
 * @param {string[]} args git arguments
 * @param {Record<string, string | undefined>} env caller environment (its GIT_* variables are dropped)
 * @param {number} deadline time (ms since the epoch) after which no git is started and a running one is stopped
 * @returns {string | null} trimmed stdout, or null on any failure or when the deadline has passed
 */
export function runGit(dir, args, env = process.env, deadline = Date.now() + ADVICE_BUDGET_MS) {
  const timeout = deadline - Date.now();
  if (timeout <= 0) return null;
  const clean = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('GIT_')));
  const options = { cwd: dir, encoding: 'utf8', timeout, env: { ...clean, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1' } };
  const hardened = ['-c', 'core.fsmonitor=false', '-c', 'safe.bareRepository=explicit', '-c', 'core.pager=cat', '-c', 'core.hooksPath=/dev/null'];
  const result = spawnSync('git', [...hardened, ...args], options);
  return result.error === undefined && result.status === 0 ? result.stdout.trim() : null;
}

const DEFAULT_DEPS = { git: runGit };

/**
 * @param {string} name a branch about to be created
 * @param {string} repoDir a folder of the repository
 * @param {(dir: string, args: string[]) => string | null} git the git runner (a test replaces it)
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
const BRANCH_OTHER_MODES = new Set(['--merged', '--no-merged', '--contains', '--no-contains', '--points-at', '-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-l', '--list', '-a', '--all', '-r', '--remotes', '--show-current', '-u', '--set-upstream-to', '--unset-upstream', '--edit-description']);

/** The branch name a git subcommand reading would create, or undefined. */
function createdBranch({ sub, rest }) {
  if (sub === 'checkout') return valueAfter(rest, ['-b', '-B']);
  if (sub === 'switch') return valueAfter(rest, ['-c', '-C', '--create', '--force-create']);
  if (sub === 'branch') return rest.some((word) => BRANCH_OTHER_MODES.has(word)) ? undefined : positionalWords(rest)[0];
  return sub === 'worktree' && rest[0] === 'add' ? valueAfter(rest, ['-b', '-B']) : undefined;
}

/** The folder a `cd` word moves to (literal paths only); null when it is not known: `cd "$X"`, `cd -`, `cd ~user`, or a relative path from an unknown folder. */
function afterCd(dir, args) {
  const target = args.find((word) => !word.startsWith('-') || word === '-') ?? '~';
  if (target === '-' || /[$`*?]/.test(target) || (target.startsWith('~') && target !== '~' && !target.startsWith('~/'))) return null;
  const expanded = target === '~' || target.startsWith('~/') ? target.replace('~', homedir()) : target;
  if (isAbsolute(expanded)) return resolve(expanded);
  return dir === null ? null : resolve(dir, expanded);
}

/** The folder git runs in: `dir` moved by each literal `-C` option of this reading (relative ones from the folder before); null when unknown. */
const gitFolder = (dir, options) => options.filter((option) => option[0] === '-C' && option[1] !== undefined).reduce((from, [, next]) => {
  if (/[$`*?]/.test(next)) return null;
  return isAbsolute(next) ? next : from === null ? null : resolve(from, next);
}, dir);

/** Advice for one git command reading: a copy branch. `scope` is `{dir, deps, env, deadline}`. */
function readingAdvice({ sub, rest }, options, scope) {
  const { deps, env, deadline } = scope;
  const folder = gitFolder(scope.dir, options);
  if (folder === null) return [];
  const name = createdBranch({ sub, rest });
  if (name === undefined) return [];
  const stem = copyBranchStem(name, folder, (where, args) => deps.git(where, args, env, deadline));
  return stem === null ? [] : [copyBranchAdvice(stem, name)];
}

/** The copy-branch advice of the command line; a failure anywhere gives none. `cwd` null is an unknown folder. */
function repositoryAdvice(command, cwd, env, deps) {
  if (!MAY_NEED_ADVICE.test(command.replace(SPELLING_BREAKS, ''))) return [];
  const found = [];
  const scope = { dir: cwd, deps, env, deadline: Date.now() + ADVICE_BUDGET_MS };
  for (const words of segments(withoutSubstitutions(stripHeredocs(command)))) {
    const { cmd, args } = asGitSubcommand(commandOf(words));
    if (cmd === 'cd') scope.dir = afterCd(scope.dir, args);
    if (cmd === 'pushd' || cmd === 'popd') scope.dir = null;
    if (cmd !== 'git') continue;
    const { options, subcommands } = parseGitArgs(args);
    for (const reading of subcommands) found.push(...readingAdvice(reading, options, scope));
  }
  return found;
}

/**
 * @param {string} command raw command text
 * @param {string | null} cwd the folder the command starts in; null when unknown (no repository advice)
 * @param {Record<string, string | undefined>} env environment handed to git
 * @param {{git?: typeof runGit}} deps replaceable git runner
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
