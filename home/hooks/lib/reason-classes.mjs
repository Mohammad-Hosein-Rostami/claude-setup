// Every reason the Bash guard can give, sorted into named classes. lib/bounce-once.mjs uses them to tell a reason the agent can fix by
// rewriting its command (a bounce class) from one that still needs the owner, and to name the latter in its deny text without repeating
// any command text, path or host: a class name is fixed text. decide() uses them to keep advice (quality rules) apart from what asks.
// Exports: BOUNCE_CLASS (the four bounce classes by key), BOUNCE_CLASSES, ADVICE_CLASS, ADVICE_CLASSES, ASK_CLASSES (every class that asks
// the owner), reasonClass(reason) -> name | undefined, isAdviceReason(reason), splitAdvice(reasons) -> {asks, advice}.
// The bounce classes match exactly (the reason constants of lib/shell-hazards.mjs and lib/raw-risk.mjs, a literal-secret reason of
// lib/verdict.mjs). The advice classes match exactly too, against the closed set of texts their rules can give (two of them hold a branch name or
// a commit, so they match as a whole text over a fixed charset): being advice is what lets
// a command run without the owner, so another rule's reason that merely contains advice wording (from command text) stays an ask. Every
// other class matches the fixed part of its rule's wording, so a reworded rule loses its class.
// tests/pre-bash-guard-reason-classes.test.mjs checks that every reason the guard gives for the strings in its tests has a class and that
// each class has a test command, so a new rule without a class, or a class without a test, fails the suite.
// A reason only the backstop parser found (it ends with BACKSTOP_MARK) has the class of the plain reason.
import { BRANCH_MOVE_ADVICE } from './branch-move.mjs';
import { LOCKFILES, lockfileAdvice } from './command-checks.mjs';
import { COPY_BRANCH_ADVICE_PATTERN, NO_PASS_ADVICE_PATTERN } from './git-advice.mjs';
import { MERGE_COMMIT_ADVICE } from './merge-commit.mjs';
import { RISKY_REASON } from './raw-risk.mjs';
import { SPLIT_VARIABLE_REASON, VARIABLE_COMMAND_REASON } from './shell-hazards.mjs';
import { BACKSTOP_MARK, DESTRUCTIVE_PREFIX, secretKindOf } from './verdict.mjs';
import { WAIT_ADVICE } from './wait-advice.mjs';

export const BOUNCE_CLASS = Object.freeze({
  variableCommand: 'variable command word',
  splitVariable: 'variable holding several words as the command',
  riskyWord: 'risky word in shell expansion',
  secret: 'secret',
});
export const BOUNCE_CLASSES = Object.values(BOUNCE_CLASS);

const EXACT_BOUNCE_REASONS = new Map([
  [VARIABLE_COMMAND_REASON, BOUNCE_CLASS.variableCommand],
  [SPLIT_VARIABLE_REASON, BOUNCE_CLASS.splitVariable],
  [RISKY_REASON, BOUNCE_CLASS.riskyWord],
  [`${DESTRUCTIVE_PREFIX}${RISKY_REASON}`, BOUNCE_CLASS.riskyWord],
]);

// Quality rules: the hook denies the first send with the advice and lets the identical retry run (lib/bounce-once.mjs), never the owner.
export const ADVICE_CLASS = Object.freeze({
  lockfile: 'hand-edited lockfile',
  mergeCommit: 'merge commit',
  branchMove: 'branch moved by plumbing',
  copyBranch: 'copy of an existing branch',
  noPass: 'merge into the base without a suite PASS',
  sleepWait: 'wait by sleeping',
});
export const ADVICE_CLASSES = Object.values(ADVICE_CLASS);
// every text an advice rule can give, exactly (see the header)
const EXACT_ADVICE_REASONS = new Map([
  ...[...LOCKFILES].map((name) => [lockfileAdvice(name), ADVICE_CLASS.lockfile]),
  [MERGE_COMMIT_ADVICE, ADVICE_CLASS.mergeCommit],
  [BRANCH_MOVE_ADVICE, ADVICE_CLASS.branchMove],
  [WAIT_ADVICE, ADVICE_CLASS.sleepWait],
]);
// advice texts that hold a branch name or a commit: matched as a WHOLE text over a fixed charset (lib/git-advice.mjs), never by "contains"
const ADVICE_PATTERNS = [
  [COPY_BRANCH_ADVICE_PATTERN, ADVICE_CLASS.copyBranch],
  [NO_PASS_ADVICE_PATTERN, ADVICE_CLASS.noPass],
];
const adviceClassOf = (plain) => EXACT_ADVICE_REASONS.get(plain) ?? ADVICE_PATTERNS.find(([pattern]) => pattern.test(plain))?.[1];

// [class name, the fixed part of its rule's reason]. Names hold no comma or semicolon: a deny text lists them joined with "; ".
const ASK_CLASS_PATTERNS = [
  ['force push', /^DESTRUCTIVE: force push overwrites remote history/],
  ['+refspec force push', /^DESTRUCTIVE: a \+refspec push is a force push/],
  ['git push --mirror', /^DESTRUCTIVE: git push --mirror overwrites the remote$/],
  ['remote branch or tag delete', /^DESTRUCTIVE: deleting a remote branch or tag$/],
  ['disk or device wipe', /^DESTRUCTIVE: \S+ can wipe a disk or device$/],
  ['rm hidden behind a variable', /^DESTRUCTIVE: \S+ with -rf flags hides the command/],
  ['rm -r on paths read from stdin', /^DESTRUCTIVE: .+ runs rm -r on paths read from stdin/],
  ['find deleting outside the project', /^DESTRUCTIVE: find deleting outside the project \(/],
  ['rm -r with a brace expansion that cannot be listed', /^DESTRUCTIVE: rm -r with a brace expansion that cannot be listed/],
  ['rm -r with a target too long to check', /^DESTRUCTIVE: rm -r with a target too long to check \(/],
  ['rm -r outside the project', /^DESTRUCTIVE: rm -r outside the project \(/],
  ['HUSKY=0', /^HUSKY=0 skips the git hooks$/],
  ['git -c core.hooksPath', /^git -c core\.hooksPath bypasses the git hooks$/],
  ['git -c alias', /^git -c alias\.\* defines a command for this call/],
  ['git --no-verify', /^git --no-verify skips the git hooks$/],
  ['git runs a command it cannot read', /^git runs a command this guard cannot read/],
  ['git push', /^git push publishes commits to a remote/],
  ['gh api graphql mutation', /^gh api graphql sends a mutation/],
  ['gh api write to a repository', /^gh api [A-Z]+ on .+ changes a repository, merge or release/],
  ['gh repo visibility change', /^gh repo edit --visibility changes who can see the repository/],
  ['gh secret change', /^gh secret \S+ changes a secret stored on GitHub/],
  ['gh workflow run', /^gh workflow run starts a workflow/],
  ['gh repo delete or rename', /^gh repo \S+ changes or removes a repository/],
  ['gh release change', /^gh release changes a published release/],
  ['gh pr merge', /^gh pr merge changes the target branch/],
  ['package publish', /^\S+ publish releases a package to a registry/],
  ['keychain secret print', /^security \S+ prints a stored secret into the transcript/],
  ['gh auth token print', /^gh auth token prints a stored secret into the transcript/],
  ['gh ssh-key add of a private key', /^gh ssh-key add uploads a key file that is not a \.pub public key/],
  ['production host write', /, a production host; confirm with the owner/],
  ['credential file next to a sender', / in the same command line as a private credential file \(/],
  ['shell reading commands from stdin', /^\S+ reads its commands from stdin/],
  ['env -S', /^env -S runs a command given as one string/],
  ['su -c', /^su -c runs a command string as another user/],
  ['eval of a variable', /^eval of a variable or substitution hides the command/],
  ['command name it cannot read', /^a command name this guard cannot read/],
  ['brace expansion it cannot list', /^a brace expansion this guard cannot list/],
  ['alias that asks', /^alias defines a command that asks: /],
  ['nesting too deep', /^commands are nested too deeply to check/],
  ['command too long', /^command too long to check/],
  ['guard error', /^guard error$/],
];
export const ASK_CLASSES = ASK_CLASS_PATTERNS.map(([name]) => name);

const withoutMark = (reason) => (reason.endsWith(BACKSTOP_MARK) ? reason.slice(0, -BACKSTOP_MARK.length) : reason);

/**
 * @param {string} reason ONE reason (decide's `reasons` or `advice`, or decideSafely's "guard error")
 * @returns {string | undefined} its class name (a BOUNCE_CLASSES, ADVICE_CLASSES or ASK_CLASSES entry), or undefined for wording no class knows
 */
export function reasonClass(reason) {
  const plain = withoutMark(reason);
  if (adviceClassOf(plain) !== undefined) return adviceClassOf(plain);
  if (EXACT_BOUNCE_REASONS.has(plain)) return EXACT_BOUNCE_REASONS.get(plain);
  if (secretKindOf(plain) !== undefined) return BOUNCE_CLASS.secret;
  return ASK_CLASS_PATTERNS.find(([, pattern]) => pattern.test(plain))?.[0];
}

/**
 * @param {string} reason ONE reason, with or without the backstop mark
 * @returns {boolean} true only for a text an advice rule gives (an exact match, see the header)
 */
export const isAdviceReason = (reason) => adviceClassOf(withoutMark(reason)) !== undefined;

/**
 * Splits the reasons of one command line into those that go to the owner (asks, and bounces whose retry asks) and advice, which never does.
 * @param {string[]} reasons every reason found, advice included
 * @returns {{asks: string[], advice: string[]}} asks unchanged and in order; advice without the backstop mark and without repeats
 */
export function splitAdvice(reasons) {
  const asks = reasons.filter((reason) => !isAdviceReason(reason));
  const advice = [...new Set(reasons.filter(isAdviceReason).map(withoutMark))];
  return { asks, advice };
}
