// The copy-branch brief gate of agent-model-guard.mjs: a re-done lane continues its own branch. A writer brief that tells the agent to create
// `<lane>-2`, `<lane>-fix`, `<lane>-v2`, `<lane>-redo` (or any `<stem>-<n>|fix|fixes|v<n>|redo`) while `<lane>` exists, or says "new branch off
// <existing branch>", is sent back once with the same-branch steps. Why: a branch copy per fix round left old branches and worktrees behind
// (round 4, git-root-cause.md proposal 2); the copy name is also what the Bash guard's git advice catches at `git checkout -b`.
// Exports: copyBranchBriefAdvice(input, env) -> { deny: false } | { deny: true, reason }, copyBranchStem(name, repoDir, deadline) -> existing stem | null,
// branchNames(prompt) (pure, the names a brief tells the agent to create), TOTAL_DEADLINE_MS.
// TODO(round4-G): copyBranchStem is lane G's function in lib/git-advice.mjs (spec section 9); this local copy takes the same name and folder plus a
// deadline, the way git-advice.mjs calls it: `(dir, args) => runGit(dir, args, env, deadline)`. When G has landed, delete it here and import it
// from ./git-advice.mjs (the one place that knows the copy-name rule).
// Names come from the prompt, which is untrusted: a name is only tested against a strict character set and looked up with `git show-ref`
// as a full ref (`refs/heads/<name>`), so it can never act as an option; the prompt text is never copied into the advice.
// Invariants: never throws; one hardened, read-only git call per candidate name (at most MAX_NAMES), each with a timeout and all of them within
// one total deadline (TOTAL_DEADLINE_MS; past it no git starts and the rest of the names count as not existing, so the brief passes); no repository or no git
// means no advice. The prompt is read only up to MAX_SCAN_CHARS and every pattern is linear in it (the hook has a 5 s timeout and a killed hook
// skips the gates after it): `worktree add` allows at most MAX_WORDS_BEFORE_B words before `-b`, on one line, and names are trimmed by a loop.
import { spawnSync } from 'node:child_process';
import { devNull } from 'node:os';
import { isAbsolute } from 'node:path';
import { isWritingAgent } from './writer-agents.mjs';

const MAX_NAMES = 8; // a brief names a few branches; the cap bounds the git calls of one send
const MAX_SCAN_CHARS = 32 * 1024; // a brief is a few KB; text past this is pasted material, not instructions
const MAX_WORDS_BEFORE_B = 8; // words between `worktree add` and `-b` (a path, `--detach`, `--no-track`, ...)
const GIT_TIMEOUT_MS = 1000; // one local ref lookup takes a few ms
export const TOTAL_DEADLINE_MS = 2000; // all lookups of one brief together: well under the hook's 5 s timeout, so the later gates and the model pin still run
const DEADLINE_ENV = 'COPY_BRANCH_DEADLINE_MS'; // a shorter or longer total for the test suite (a positive whole number of ms, else the default)
const GIT_TIMEOUT_ENV = 'COPY_BRANCH_GIT_TIMEOUT_MS'; // a longer bound for the test suite: on a busy machine a lookup past 1 s means no advice
const LEADING_NOISE = '`\'"([';
const TRAILING_NOISE = '`\'"),.;:]';
const NAME = /^[A-Za-z0-9][\w./-]{0,199}$/;
const COPY_SUFFIX = /^(.+)-(\d+|fix|fixes|v\d+|redo)$/;
const REPOSITORY_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'];
// config that would make a read-only git call run a program; given on the command line, so it beats the repository's own config
const HARDENED = ['-c', 'core.fsmonitor=false', '-c', 'safe.bareRepository=explicit', '-c', `core.hooksPath=${devNull}`];
const CREATING_PHRASES = [
  /\bcheckout\s+-[bB]\s+(\S+)/g,
  /\bswitch\s+-[cC]\s+(\S+)/g,
  new RegExp(String.raw`\bworktree\s+add\s+(?:\S+[^\S\n]+){0,${MAX_WORDS_BEFORE_B}}?-b\s+(\S+)`, 'g'),
  /\bgit\s+branch\s+(\S+)/g, // an option (-d, -m) is no name: the NAME test drops it
  /\bnew branch\s+(?:named |called )?(?!off\b|from\b|based\b)(\S+)/gi,
];
const BRANCH_OFF = /\bnew branch\s+(?:off|from|based on)\s+(\S+)/gi;
const ADVICE = 'A re-done lane continues the same branch: remove its old worktree, then `git switch <lane> && git rebase <base>` '
  + '(implementer.md, "Same branch on a re-do"). Do not create a copy of an existing branch (`<lane>-2`, `-fix`, `-v2`, `-redo`).';

/** The word without quotes, brackets and sentence punctuation around it (a loop, not a regex: a long run of them must not cost quadratic time). */
function cleaned(word) {
  let start = 0;
  let end = word.length;
  while (start < end && LEADING_NOISE.includes(word[start])) start += 1;
  while (end > start && TRAILING_NOISE.includes(word[end - 1])) end -= 1;
  return word.slice(start, end);
}

/**
 * The branch names a brief tells an agent to create, and the existing branches it says to branch off.
 * @param {string} prompt the Agent call's prompt
 * @returns {{ created: string[], offOf: string[] }} candidate names (strict character set, at most MAX_NAMES each, no duplicates)
 */
export function branchNames(prompt) {
  const text = prompt.slice(0, MAX_SCAN_CHARS);
  const pick = (patterns) => [...new Set(patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((found) => cleaned(found[1]))))]
    .filter((name) => NAME.test(name)).slice(0, MAX_NAMES);
  return { created: pick(CREATING_PHRASES), offOf: pick([BRANCH_OFF]) };
}

/** The environment variable as a positive whole number of milliseconds, else `fallback` (-1, 0, 1.5, text and an unset variable all give the fallback). */
function positiveMs(variable, fallback) {
  const value = Number(process.env[variable]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** True when the local branch `name` exists in the repository at `repoDir` (false for no repository, no git, any failure or a passed `deadline`, in performance.now() ms). */
function branchExists(name, repoDir, deadline) {
  if (!NAME.test(name) || typeof repoDir !== 'string' || !isAbsolute(repoDir)) return false;
  const remaining = deadline - performance.now();
  // spawnSync reads a timeout of 0 as "no timeout", so git never starts with nothing left
  if (!(remaining > 0)) return false;
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const variable of REPOSITORY_VARIABLES) delete env[variable];
  const result = spawnSync('git', [...HARDENED, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`], { cwd: repoDir, env, encoding: 'utf8', timeout: Math.ceil(Math.min(remaining, positiveMs(GIT_TIMEOUT_ENV, GIT_TIMEOUT_MS))) }); // whole ms: spawnSync rejects a fraction
  return result.status === 0;
}

/**
 * The existing branch a new branch name copies.
 * @param {string} name the branch about to be created
 * @param {string} repoDir an absolute folder inside the repository
 * @param {number} deadline performance.now() time in ms after which no git is started (default: none)
 * @returns {string | null} the stem when `name` is `<stem>-<n>|-fix|-fixes|-v<n>|-redo` and `<stem>` exists locally, else null
 */
export function copyBranchStem(name, repoDir, deadline = Infinity) {
  const stem = COPY_SUFFIX.exec(name)?.[1];
  return stem !== undefined && branchExists(stem, repoDir, deadline) ? stem : null;
}

/**
 * Whether a writer brief should be sent back once for creating a copy of an existing branch.
 * @param {unknown} input the hook input: tool_input {subagent_type, prompt}, cwd
 * @param {Record<string, string | undefined>} env process environment (HOME and CLAUDE_PROJECT_DIR for the agent files)
 * @returns {{ deny: false } | { deny: true, reason: string }}
 */
export function copyBranchBriefAdvice(input, env) {
  try {
    const { subagent_type: type, prompt } = input?.tool_input ?? {};
    if (typeof prompt !== 'string' || !isWritingAgent(type, env)) return { deny: false };
    const repoDir = typeof input.cwd === 'string' ? input.cwd : env.CLAUDE_PROJECT_DIR;
    const { created, offOf } = branchNames(prompt);
    const deadline = performance.now() + positiveMs(DEADLINE_ENV, TOTAL_DEADLINE_MS);
    const copies = created.some((name) => copyBranchStem(name, repoDir, deadline) !== null) || offOf.some((name) => branchExists(name, repoDir, deadline));
    return copies ? { deny: true, reason: ADVICE } : { deny: false };
  } catch {
    return { deny: false }; // a quality hint, not a safety rule: any failure lets the call run
  }
}
