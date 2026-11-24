// Outward actions that always need the owner's confirmation: `git push`, `gh release *`, `gh pr merge`, `gh repo edit --visibility`,
// `gh secret set`, `gh workflow run`, a `gh api graphql` mutation, package publish, and the merge and release verbs and `api` writes of
// glab, hub and tea.
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

const MUTATING_METHOD = /^(?:PUT|POST|PATCH|DELETE)$/i;
// the repository itself, merges (`/merge`, `/merges`), releases, refs and branch protection: what `gh api` must not change unasked
const GH_API_SENSITIVE_PATH = /^\/?repos\/[^/]+\/[^/]+(?:\/(?:merges?|releases(?:\/.*)?|git\/refs(?:\/.*)?|branches\/.+\/protection.*|pulls\/\d+\/merge|(?:transfer|archive|rename)))?\/?$/i;

/** The HTTP method of a `gh api` call: -X/--method (also attached: `-XPOST`, `--method=POST`), or POST when -f/-F/--input send a body. */
function ghApiMethod(args) {
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word === '-X' || word === '--method') return args[i + 1];
    if (word.startsWith('--method=')) return word.slice('--method='.length);
    if (/^-X./.test(word)) return word.slice(2);
  }
  return args.some((a) => /^(?:-f|-F|--field|--raw-field|--input)(?:=|$)/.test(a)) ? 'POST' : 'GET';
}

const GRAPHQL_MUTATION = /\bmutation\b/i;

function ghApiAsk(args) {
  if (args[1] === 'graphql' && args.some((a) => GRAPHQL_MUTATION.test(a))) return 'gh api graphql sends a mutation that changes data on GitHub; confirm with the owner';
  const path = args.slice(1).find((a) => !a.startsWith('-') && /\//.test(a));
  if (path === undefined || !MUTATING_METHOD.test(ghApiMethod(args)) || !GH_API_SENSITIVE_PATH.test(path)) return undefined;
  return `gh api ${ghApiMethod(args).toUpperCase()} on ${path} changes a repository, merge or release; confirm with the owner`;
}

function ghAsk(args) {
  const [group, action] = positionals(args, GH_VALUE_OPTIONS);
  if (group === 'api') return ghApiAsk(args.filter((a, i) => !GH_VALUE_OPTIONS.has(args[i - 1]) || i === 0).slice(args.indexOf('api')));
  if (group === 'repo' && action === 'edit' && args.some((a) => /^--visibility(?:=|$)/.test(a))) return 'gh repo edit --visibility changes who can see the repository; confirm with the owner';
  if (group === 'secret' && ['set', 'delete', 'remove'].includes(action)) return `gh secret ${action} changes a secret stored on GitHub; confirm with the owner`;
  if (group === 'workflow' && action === 'run') return 'gh workflow run starts a workflow (it can deploy or publish); confirm with the owner';
  if (group === 'repo' && ['delete', 'archive', 'rename', 'transfer'].includes(action)) return `gh repo ${action} changes or removes a repository; confirm with the owner`;
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

// The other forge CLIs (GitLab's glab, GitHub's older hub, Gitea's tea): [the words naming pull requests or releases, what reads only].
// hub also runs every git command (`hub push`): pre-bash-guard.mjs gives it the git rules too. `glab mr accept` may be an alias of merge;
// asking for it costs one dialog. `tea pulls` and `tea releases` also go by `pull`, `pr`, `release` and `r`.
const FORGE_MERGE_GROUPS = new Map([['glab', new Set(['mr'])], ['tea', new Set(['pulls', 'pull', 'pr'])]]);
const FORGE_MERGE_VERBS = new Set(['merge', 'accept']);
const FORGE_RELEASE_GROUPS = new Map([['glab', new Set(['release'])], ['hub', new Set(['release'])], ['tea', new Set(['releases', 'release', 'r'])]]);
const FORGE_RELEASE_READ = new Set(['list', 'ls', 'view', 'show', 'download']);
// tea's options that take a value and may stand before the verb (`tea -l work pulls merge 1`)
const TEA_VALUE_OPTIONS = new Set([...GH_VALUE_OPTIONS, '-l', '--login', '-r', '--repo', '-R', '--remote', '-o', '--output']);
const FORGE_API = 'api';

// `glab api`, `hub api`, `tea api`: every write asks (-X POST|PUT|PATCH|DELETE, or a body by -f/-F, read as gh's); the forges'
// paths differ too much to single out the risky ones as gh api does
function forgeApiAsk(cmd, args) {
  const method = ghApiMethod(args) ?? '';
  return MUTATING_METHOD.test(method) ? `${cmd} api ${method.toUpperCase()} changes data on the forge; confirm with the owner` : undefined;
}

function forgeAsk(cmd, args) {
  const [group, action] = positionals(args, cmd === 'tea' ? TEA_VALUE_OPTIONS : GH_VALUE_OPTIONS);
  if (group === FORGE_API) return forgeApiAsk(cmd, args);
  const merges = cmd === 'hub' ? group === 'merge' : FORGE_MERGE_GROUPS.get(cmd)?.has(group) && FORGE_MERGE_VERBS.has(action);
  if (merges) return `${cmd} ${cmd === 'hub' ? 'merge' : `${group} ${action}`} merges a pull request into the target branch; confirm with the owner`;
  // `hub release` alone lists the releases; any other verb (create, edit, delete) changes one
  const isRead = action === undefined ? cmd === 'hub' : FORGE_RELEASE_READ.has(action);
  if (FORGE_RELEASE_GROUPS.get(cmd)?.has(group) && !isRead) return `${cmd} ${group} ${action} changes a published release; confirm with the owner`;
  return undefined;
}

/**
 * Reason to ask the owner before running this command, or undefined.
 * @param {string} cmd command name (gh, glab, hub, tea, npm, pnpm, yarn, bun, lerna, npx; others give undefined)
 * @param {string[]} args words after the command
 */
export function outwardAsk(cmd, args) {
  if (cmd === 'gh') return ghAsk(args);
  if (cmd === 'glab' || cmd === 'hub' || cmd === 'tea') return forgeAsk(cmd, args);
  return PUBLISHERS.has(cmd) ? publishAsk(cmd, args) : undefined;
}
