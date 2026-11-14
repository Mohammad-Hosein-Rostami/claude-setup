// Every reason the Bash guard can give, sorted into named classes. lib/bounce-once.mjs uses them to tell a reason the agent can fix by
// rewriting its command (a bounce class) from one that still needs the owner, and to name the latter in its deny text without repeating
// any command text, path or host: a class name is fixed text.
// Exports: BOUNCE_CLASS (the four bounce classes by key), BOUNCE_CLASSES, ASK_CLASSES (every other class), reasonClass(reason) -> name | undefined.
// The bounce classes match exactly (the reason constants of lib/shell-hazards.mjs and lib/raw-risk.mjs, a literal-secret reason of
// lib/verdict.mjs); every other class matches the fixed part of its rule's wording, so a reworded rule loses its class.
// tests/pre-bash-guard-reason-classes.test.mjs checks that every reason the guard gives for the strings in its tests has a class and that
// each class has a test command, so a new rule without a class, or a class without a test, fails the suite.
// A reason only the backstop parser found (it ends with BACKSTOP_MARK) has the class of the plain reason.
import { RISKY_REASON } from './raw-risk.mjs';
import { SPLIT_VARIABLE_REASON, VARIABLE_COMMAND_REASON } from './shell-hazards.mjs';
import { BACKSTOP_MARK, DESTRUCTIVE_PREFIX, secretKindOf } from './verdict.mjs';

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
  ['rm -r outside the project', /^DESTRUCTIVE: rm -r outside the project \(/],
  ['HUSKY=0', /^HUSKY=0 skips the git hooks$/],
  ['git -c core.hooksPath', /^git -c core\.hooksPath bypasses the git hooks$/],
  ['git -c alias', /^git -c alias\.\* defines a command for this call/],
  ['git --no-verify', /^git --no-verify skips the git hooks$/],
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
  ['hand-edited lockfile', /^\S+ is generated; the package manager should write it/],
  ['production host write', /, a production host; confirm with the owner/],
  ['credential file next to a sender', / in the same command line as a private credential file \(/],
  ['shell reading commands from stdin', /^\S+ reads its commands from stdin/],
  ['env -S', /^env -S runs a command given as one string/],
  ['su -c', /^su -c runs a command string as another user/],
  ['eval of a variable', /^eval of a variable or substitution hides the command/],
  ['alias that asks', /^alias defines a command that asks: /],
  ['nesting too deep', /^commands are nested too deeply to check/],
  ['command too long', /^command too long to check/],
  ['guard error', /^guard error$/],
];
export const ASK_CLASSES = ASK_CLASS_PATTERNS.map(([name]) => name);

/**
 * @param {string} reason ONE ask reason (decide's `reasons`, or decideSafely's "guard error")
 * @returns {string | undefined} its class name (a BOUNCE_CLASSES or ASK_CLASSES entry), or undefined for wording no class knows
 */
export function reasonClass(reason) {
  const plain = reason.endsWith(BACKSTOP_MARK) ? reason.slice(0, -BACKSTOP_MARK.length) : reason;
  if (EXACT_BOUNCE_REASONS.has(plain)) return EXACT_BOUNCE_REASONS.get(plain);
  if (secretKindOf(plain) !== undefined) return BOUNCE_CLASS.secret;
  return ASK_CLASS_PATTERNS.find(([, pattern]) => pattern.test(plain))?.[0];
}
