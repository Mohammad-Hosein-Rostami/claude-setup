// Outward actions that always need the owner's confirmation: `git push`, `gh release *`, `gh pr merge`, package publish.
// Exports: parsePushArgs(rest), pushAsk(options), outwardAsk(cmd, args) -> reason | undefined.
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

const PUSH_VALUE_OPTIONS = new Set(['--push-option', '--repo', '--receive-pack', '--exec']);
const PUSH_VALUE_SHORT = 'o'; // `-o option`; also last in a cluster (`-uo opt`) or attached (`-oopt`)
const MIN_DRY_RUN_PREFIX = '--dry'.length; // git accepts any unique prefix of a long option; `--dry` is unique

/**
 * Splits the words after `git push` into options and positionals, consuming option values (`-o x`, `--repo r`, `--exec e`)
 * so a value is never mistaken for a flag (`-o -f` is not a force push, `-o -n` is not a dry run).
 * A short cluster that contains `o` is cut after the `o` (`-fovalue` -> `-fo`); what follows is its value.
 * @param {string[]} rest words after `push`
 * @returns {{options: string[], positional: string[]}}
 */
export function parsePushArgs(rest) {
  const options = [];
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i];
    if (word === '--') positional.push(...rest.slice(i + 1));
    if (word === '--') break;
    if (word.startsWith('--')) {
      options.push(word);
      if (PUSH_VALUE_OPTIONS.has(word)) i += 1;
    } else if (word.startsWith('-') && word.length > 1) {
      const valueAt = word.indexOf(PUSH_VALUE_SHORT, 1);
      options.push(valueAt === -1 ? word : word.slice(0, valueAt + 1));
      if (valueAt === word.length - 1) i += 1;
    } else positional.push(word);
  }
  return { options, positional };
}

/** `--dry-run` (or a unique prefix of it), or a short cluster with `n` (`-n`, `-nu`) among its flags. */
const isDryRun = (options) => options.some((o) => (o.startsWith('--') ? o.length >= MIN_DRY_RUN_PREFIX && '--dry-run'.startsWith(o) : /^-[a-zA-Z]*n/.test(o)));

/**
 * @param {string[]} options option words of a `git push` call, from parsePushArgs
 * @returns {string | undefined} ask reason; undefined for a dry run
 */
export const pushAsk = (options) => (isDryRun(options) ? undefined : 'git push publishes commits to a remote; confirm with the owner');

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
