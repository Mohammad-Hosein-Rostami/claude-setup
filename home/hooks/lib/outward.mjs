// Outward actions that always need the owner's confirmation: `git push`, `gh release *`, `gh pr merge`, package publish.
// Exports: pushAsk(flags), outwardAsk(cmd, args) -> reason | undefined.
// The guard turns a reason into a PreToolUse permissionDecision "ask", which prompts even in bypassPermissions mode.
// Read-only or rehearsal forms stay allowed: `git push --dry-run`, `npm publish --dry-run`, `gh release list|view|download`.
// Pure, no I/O. Deny rules (force push, mirror, delete) are checked first by the caller and win over an ask.

const GH_VALUE_OPTIONS = new Set(['-R', '--repo', '--hostname']);
const GH_RELEASE_READ = new Set(['list', 'view', 'download']);
const PUBLISH_VALUE_OPTIONS = new Set(['--filter', '-F', '-C', '--prefix', '-w', '--workspace', '--registry', '--cwd', '--dir']);
const PUBLISHERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'lerna', 'npx']);

const positionals = (args, valueOptions) => {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('-')) out.push(args[i]);
    else if (valueOptions.has(args[i])) i += 1;
  }
  return out;
};

// exactly `--dry-run` or `-n`: a cluster such as `-on` is something else (`-o` takes a value), so it is not a rehearsal
const isDryRun = (flags) => flags.some((f) => f === '--dry-run' || f === '-n');

/**
 * @param {string[]} flags option words of a `git push` call
 * @returns {string | undefined} ask reason; undefined for a dry run
 */
export const pushAsk = (flags) => (isDryRun(flags) ? undefined : 'git push publishes commits to a remote; confirm with the owner');

function ghAsk(args) {
  const [group, action] = positionals(args, GH_VALUE_OPTIONS);
  if (group === 'release' && !GH_RELEASE_READ.has(action)) return 'gh release changes a published release; confirm with the owner';
  if (group === 'pr' && action === 'merge') return 'gh pr merge changes the target branch; confirm with the owner';
  return undefined;
}

function publishAsk(cmd, args) {
  if (args.includes('--dry-run')) return undefined;
  const [first, second] = positionals(args, PUBLISH_VALUE_OPTIONS);
  const publishes = first === 'publish' || (['npm', 'changeset'].includes(first) && second === 'publish');
  return publishes ? `${cmd} publish releases a package to a registry; confirm with the owner` : undefined;
}

/**
 * Reason to ask the owner before running this command, or undefined.
 * @param {string} cmd command name (gh, npm, pnpm, yarn, bun, lerna, npx; others give undefined)
 * @param {string[]} args words after the command
 */
export function outwardAsk(cmd, args) {
  if (cmd === 'gh') return ghAsk(args);
  return PUBLISHERS.has(cmd) ? publishAsk(cmd, args) : undefined;
}
