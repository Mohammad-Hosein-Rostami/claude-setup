// Every reason the Bash guard can give, sorted into named classes. lib/bounce-once.mjs uses them to tell a reason the agent can fix by
// rewriting its command (a bounce class) from one that still needs the owner, and to name the latter in its deny text without repeating
// any command text, path or host: a class name is fixed text. decide() uses them to keep advice (quality rules) apart from what asks.
// Exports: BOUNCE_CLASS (the four bounce classes by key), BOUNCE_CLASSES, ADVICE_CLASS, ADVICE_CLASSES, ASK_CLASSES (every class that asks
// the owner), reasonClass(reason) -> name | undefined, isAdviceReason(reason), splitAdvice(reasons) -> {asks, advice},
// keepsDialog(reasons) -> boolean (an outward or hidden action: it asks even under CLAUDE_GUARD_ASK=allow, lib/timed-ask.mjs).
// The bounce classes match exactly (the reason constants of lib/shell-hazards.mjs, lib/raw-risk.mjs and lib/runtime-values.mjs; a literal
// secret is no reason at all since owner G1, 2026-11-23). The advice classes match exactly too, against the closed set of texts their rules can give (one of them holds a branch name,
// so it matches as a whole text over a fixed charset): being advice is what lets
// a command run without the owner, so another rule's reason that merely contains advice wording (from command text) stays an ask. Every
// other class matches the fixed part of its rule's wording, so a reworded rule loses its class.
// tests/pre-bash-guard-reason-classes.test.mjs checks that every reason the guard gives for the strings in its tests (template strings included) has a class and that
// each class has a test command, so a new rule without a class, or a class without a test, fails the suite.
// A reason only the backstop parser found (it ends with BACKSTOP_MARK) has the class of the plain reason.
import { BRANCH_MOVE_ADVICE } from './branch-move.mjs';
import { LOCKFILES, lockfileAdvice } from './command-checks.mjs';
import { COPY_BRANCH_ADVICE_PATTERN } from './git-advice.mjs';
import { MERGE_COMMIT_ADVICE } from './merge-commit.mjs';
import { DEPLOY_REASON_TAIL, DEPLOY_TOOLS } from './deploy.mjs';
import { DOCKER_RM_ADVICE } from './docker-advice.mjs';
import { RISKY_REASON } from './raw-risk.mjs';
import { ARITHMETIC_REASON, RUNTIME_VALUE_REASON } from './runtime-values.mjs';
import { SPLIT_VARIABLE_REASON, VARIABLE_COMMAND_REASON } from './shell-hazards.mjs';
import { BACKSTOP_MARK, DESTRUCTIVE_PREFIX } from './verdict.mjs';
import { WAIT_ADVICE } from './wait-advice.mjs';

export const BOUNCE_CLASS = Object.freeze({
  variableCommand: 'variable command word',
  splitVariable: 'variable holding several words as the command',
  riskyWord: 'risky word in shell expansion',
  tooComplex: 'word or arithmetic known only at run time', // arithmetic on run-time text, a word filled in at run time (fixes spec X7)
});
export const BOUNCE_CLASSES = Object.values(BOUNCE_CLASS);

const EXACT_BOUNCE_REASONS = new Map([
  [VARIABLE_COMMAND_REASON, BOUNCE_CLASS.variableCommand],
  [SPLIT_VARIABLE_REASON, BOUNCE_CLASS.splitVariable],
  [RISKY_REASON, BOUNCE_CLASS.riskyWord],
  [`${DESTRUCTIVE_PREFIX}${RISKY_REASON}`, BOUNCE_CLASS.riskyWord],
  [ARITHMETIC_REASON, BOUNCE_CLASS.tooComplex],
  [RUNTIME_VALUE_REASON, BOUNCE_CLASS.tooComplex],
]);

// Quality rules: the hook denies the first send with the advice and lets the identical retry run (lib/bounce-once.mjs), never the owner.
export const ADVICE_CLASS = Object.freeze({
  lockfile: 'hand-edited lockfile',
  mergeCommit: 'merge commit',
  branchMove: 'branch moved by plumbing',
  copyBranch: 'copy of an existing branch',
  sleepWait: 'wait by sleeping',
  dockerRm: 'docker rm without -v',
});
export const ADVICE_CLASSES = Object.values(ADVICE_CLASS);
// every text an advice rule can give, exactly (see the header)
const EXACT_ADVICE_REASONS = new Map([
  ...[...LOCKFILES].map((name) => [lockfileAdvice(name), ADVICE_CLASS.lockfile]),
  [MERGE_COMMIT_ADVICE, ADVICE_CLASS.mergeCommit],
  [BRANCH_MOVE_ADVICE, ADVICE_CLASS.branchMove],
  [WAIT_ADVICE, ADVICE_CLASS.sleepWait],
  [DOCKER_RM_ADVICE, ADVICE_CLASS.dockerRm],
]);
// the advice text that holds a branch name: matched as a WHOLE text over a fixed charset (lib/git-advice.mjs), never by "contains"
const ADVICE_PATTERNS = [
  [COPY_BRANCH_ADVICE_PATTERN, ADVICE_CLASS.copyBranch],
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
  ['rm -r with a brace expansion that cannot be listed', /^DESTRUCTIVE: rm (?:-r|that may be recursive \([^)]*\)) with a brace expansion that cannot be listed/],
  ['rm -r with a target too long to check', /^DESTRUCTIVE: rm (?:-r|that may be recursive \([^)]*\)) with a target too long to check \(/],
  ['rm -r outside the project', /^DESTRUCTIVE: rm (?:-r|that may be recursive \([^)]*\)) outside the project \(/],
  ['rm -r that empties a whole folder', /^DESTRUCTIVE: rm (?:-r|that may be recursive \([^)]*\)) that empties a whole folder \(/],
  // round 9 (lib/other-deleters.mjs, lib/find-delete.mjs, lib/guard-state-write.mjs)
  ['find deleting a whole folder', /^DESTRUCTIVE: find deleting that empties a whole folder \(/],
  ['another deleter outside the project or on a whole folder', /^DESTRUCTIVE: (?:rimraf|rsync --delete|\S+ Remove-Item -Recurse|\S+ rd \/s|\S+ code deleting a tree) (?:outside the project|that empties a whole folder|with a target too long|with a brace expansion) /],
  ['another deleter with targets it cannot read', /^DESTRUCTIVE: (?:\S+ code deletes a folder tree at a path the guard cannot read|.+ with targets the guard cannot read); check/],
  ['a recursive delete through a link made in the line', /^DESTRUCTIVE: a recursive delete through a link made in the same line \(/],
  // owner FR6 scratch areas (lib/scratch-area.mjs, lib/find-delete.mjs, lib/other-deleters.mjs)
  ['a scratch delete on a line that may make links', /^DESTRUCTIVE: a delete in a scratch area \(.+\) on a line whose .+ may make a link/],
  ['find deleting through links', /^DESTRUCTIVE: find deleting with -L or -follow: /],
  ['rsync --delete through destination links', /^DESTRUCTIVE: rsync --delete that follows the links in its destination \(/],
  ["a change to the guard's own files", /^changes the guard's own files \(/],
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
  ['forge merge', /^(?:glab|hub|tea) .*merges a pull request into the target branch/],
  ['forge release change', /^(?:glab|hub|tea) .* changes a published release/],
  ['forge api write', /^(?:glab|hub|tea) api \w+ changes data on the forge/],
  ['git update-ref', /^git update-ref moves a ref by plumbing/],
  ['interpreter code that builds its command', /^interpreter code runs a command it builds from pieces/],
  ['PowerShell -EncodedCommand', /^PowerShell -EncodedCommand runs base64 text/],
  ['interpreter reading code from stdin', /^\S+ reads its code from stdin/],
  ['$IFS in the line', /^the line expands \$IFS/],
  ['package publish', /^\S+ publish releases a package to a registry/],
  ['deploy or cloud change', new RegExp(`^(?:${DEPLOY_TOOLS.join('|')}) .+ ${DEPLOY_REASON_TAIL}$`)], // tool and verb are fixed text (lib/deploy.mjs)
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
  ['command too complex', /^command too complex to check/],
  ['guard error', /^guard error(?:: \w+)?$/], // the hook's own fallback adds the error class (`guard error: TypeError`)
  ['guard input unreadable', /^the guard could not read its input /], // written by the hook itself, before any rule ran
];
export const ASK_CLASSES = ASK_CLASS_PATTERNS.map(([name]) => name);

// The owner's standing rule "confirm every outward-facing action" (push, publish, PR merge, deploy, prod-host writes): these classes keep
// their dialog under CLAUDE_GUARD_ASK=allow.
const OUTWARD_CLASSES = new Set(['force push', '+refspec force push', 'git push --mirror', 'remote branch or tag delete', 'git push',
  'gh api graphql mutation', 'gh api write to a repository', 'gh repo visibility change', 'gh secret change', 'gh workflow run',
  'gh repo delete or rename', 'gh release change', 'gh pr merge', 'forge merge', 'forge release change', 'forge api write',
  'package publish', 'deploy or cloud change', 'gh ssh-key add of a private key', 'production host write', 'credential file next to a sender']);
// What runs is hidden from the guard, so it may be one of those: these keep their dialog too (a class-less reason as well).
const HIDDEN_CLASSES = new Set([...BOUNCE_CLASSES, 'git runs a command it cannot read', 'git -c alias', 'interpreter code that builds its command',
  'PowerShell -EncodedCommand', 'interpreter reading code from stdin', '$IFS in the line', 'shell reading commands from stdin', 'env -S',
  'su -c', 'eval of a variable', 'command name it cannot read', 'brace expansion it cannot list', 'alias that asks', 'nesting too deep',
  'command too long', 'command too complex', 'guard error', 'guard input unreadable']);

/**
 * Whether an ask must still show its dialog when the person turned asks off (CLAUDE_GUARD_ASK=allow).
 * @param {string[]} reasons the ask's reasons (decide's `reasons`, or the one reason of a guard error)
 * @returns {boolean} true when any reason is an outward action, hides what runs, or has no class
 */
export function keepsDialog(reasons) {
  return reasons.some((reason) => {
    const name = reasonClass(reason);
    return name === undefined || OUTWARD_CLASSES.has(name) || HIDDEN_CLASSES.has(name);
  });
}

const withoutMark = (reason) => (reason.endsWith(BACKSTOP_MARK) ? reason.slice(0, -BACKSTOP_MARK.length) : reason);

/**
 * @param {string} reason ONE reason (decide's `reasons` or `advice`, or decideSafely's "guard error")
 * @returns {string | undefined} its class name (a BOUNCE_CLASSES, ADVICE_CLASSES or ASK_CLASSES entry), or undefined for wording no class knows
 */
export function reasonClass(reason) {
  const plain = withoutMark(reason);
  if (adviceClassOf(plain) !== undefined) return adviceClassOf(plain);
  if (EXACT_BOUNCE_REASONS.has(plain)) return EXACT_BOUNCE_REASONS.get(plain);
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
