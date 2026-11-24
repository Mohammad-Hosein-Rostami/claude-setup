// Deploy and cloud CLIs whose verbs change live infrastructure: they ask the owner like a push or a publish (owner rule: confirm every
// outward-facing action). Exports: DEPLOY_TOOLS (the command names with a rule), DEPLOY_REASON_TAIL (the fixed end of every reason),
// STDIN_ARGUMENTS (stands for the words xargs or parallel adds), deployAsk(cmd, args) -> reason | undefined.
// lib/outward.mjs outwardAsk calls deployAsk first; lib/reason-classes.mjs gives every reason the outward class "deploy or cloud change",
// so it keeps its dialog under CLAUDE_GUARD_ASK=allow, and an outward ask from max runs only on a click (lib/timed-ask.mjs).
// Asks: docker|podman push (also `image|manifest|compose push`, `build|buildx build --push`); kubectl apply|create|delete|replace|patch|
// scale|set|edit|rollout (not `rollout status|history`)|drain|cordon|uncordon|label|annotate|taint|expose|run (not with `--local`, which
// changes only the printed copy); helm install|upgrade|rollback|uninstall (and its aliases delete|del|un)|push; terraform|tofu
// apply|destroy|import|state rm|mv|push; pulumi up|update|destroy|refresh; vercel with no sub-command, with a path, with
// deploy|redeploy|promote|rollback|remove|rm, with --prod, alias (not `alias ls|list`), env add|rm|remove|update; netlify|ntl deploy;
// fly|flyctl deploy|scale|secrets set|unset|apps destroy; wrangler deploy|publish, pages|versions deploy|publish, secret put|delete;
// firebase deploy (and `hosting:channel:deploy`); gcloud with deploy among its first three command words (not right after a verb
// such as describe, whose resource name it is); aws s3 cp|sync to an s3://
// target, s3 mv with an s3:// path, s3 rm|rb, s3api put-*|delete-*|create-*, cloudformation deploy|create-*|update-*|delete-*|
// execute-change-set, ecs update-service; serverless|sls deploy|remove; eas submit|update and `eas build --auto-submit`. Stay allowed:
// every other verb (kubectl get|describe|logs|diff, terraform plan|state list|show, helm list|template, docker build, vercel ls|dev|env ls,
// wrangler dev, aws s3api get-*|list-*|head-*, cloudformation describe-* ...) and every dry run (`--dry-run`, `--dry-run=client|server`,
// aws `--dryrun`; not `--dry-run=none|false|f|0`, which run for real, nor a dry-run flag after `--`, nor one right after an option
// that may take it as its value: `kubectl apply -f --dry-run=client` applies a file named so).
// Command words are read after the tool's options that take a value (`kubectl -n prod apply`); an option this file does not know is read
// both ways, with and without a value (`kubectl --username u apply`), and either reading asking is enough. A lone `-` (stdin) is a word.
// The words after `--` belong to another program (`kubectl exec pod -- rm x`) and are not read.
// Run time (as the git rule, lib/command-checks.mjs): a command word the guard cannot read (`$V`, `$(cmd)`, a backtick body, the `{}`
// that xargs or find fills in, or STDIN_ARGUMENTS) may be any word, also several, so the call asks when one of RUN_TIME_PHRASES in its
// place would ask (`kubectl $V`, `aws s3 cp a "$DEST"`); a value of a known option (`-n "$NS"`) is no command word and stays allowed.
// A reason holds only fixed text (the tool and verb names of this file), never a word of the command. Pure, no I/O.

const DRY_RUN_FLAGS = new Set(['--dry-run', '--dryrun']); // --dryrun: aws s3
// `--dry-run=none` (kubectl) and `--dry-run=false|f|0` (helm reads a Go boolean) change things for real; an empty value is not a mode
const REAL_RUN_VALUES = new Set(['none', 'false', 'f', '0', '']);
const END_OF_OPTIONS = '--';
const STDIN_FILE = '-'; // `aws s3 cp - s3://b/k` uploads stdin: a word, not an option
export const DEPLOY_REASON_TAIL = 'deploys or changes live infrastructure; confirm with the owner';
/** Stands for the words xargs or parallel adds to the command at run time (pre-bash-guard.mjs appends it). */
export const STDIN_ARGUMENTS = '$(stdin)';
const RUN_TIME_WORD = /[$`]|\{\}/; // `$V`, `$(cmd)`, a backtick body, the `{}` of xargs -I{}, parallel and find -exec
// For a word known only at run time: values that make some rule ask (each tool's verbs: the rules below), tried one by one in its place
const RUN_TIME_PHRASES = ['apply', 'push', 'deploy', 'up', 'destroy', 'rm', 'set', 'delete', 'put-object', 'update-service', 'submit',
  's3 rm', 's3://run-time-value'].map((phrase) => phrase.split(' '));

const isOption = (word) => word.startsWith('-') && word !== STDIN_FILE;
/** True when `word` is an option that may take the next word as its value (no `=` of its own). */
const mayTakeValue = (word) => word !== undefined && isOption(word) && !word.includes('=');

/** `--dry-run`, `--dryrun`, or `--dry-run=<mode>` with a mode that only rehearses. */
function isDryRunWord(word) {
  if (DRY_RUN_FLAGS.has(word)) return true;
  const [flag, value] = word.split('=', 2);
  return DRY_RUN_FLAGS.has(flag) && value !== undefined && !REAL_RUN_VALUES.has(value.toLowerCase());
}

/** True for a dry-run word before any `--` that is no option's value (the word before it is no option that may take one). */
function isDryRun(args) {
  const end = args.indexOf(END_OF_OPTIONS);
  const options = end === -1 ? args : args.slice(0, end);
  return options.some((word, at) => isDryRunWord(word) && !mayTakeValue(options[at - 1]));
}

/**
 * The command words of `args`: no option, no value of an option in `valueOptions`, nothing after `--`.
 * @param {boolean} unknownTakesValue the reading where an option missing from `valueOptions` takes the next word as its value
 */
function commandWords(args, valueOptions, unknownTakesValue) {
  const words = [];
  for (let i = 0; i < args.length && args[i] !== END_OF_OPTIONS; i++) {
    if (!isOption(args[i])) words.push(args[i]);
    else if (valueOptions.has(args[i]) || (unknownTakesValue && mayTakeValue(args[i]))) i += 1;
  }
  return words;
}

/** A rule that asks when the first command word is one of `verbs`; it names that verb. */
const firstWordIn = (verbs) => ([verb]) => (verbs.has(verb) ? verb : undefined);

const PUSH_GROUPS = new Set(['image', 'manifest', 'compose']);
const PUSH_FLAG = /^--push(?:=(?!false$).*)?$/; // `--push`, `--push=true`; `--push=false` does not push

function containerAsk([group, action], args) {
  if (group === 'push') return 'push';
  if (PUSH_GROUPS.has(group) && action === 'push') return `${group} push`;
  const builds = group === 'build' || (group === 'buildx' && action === 'build');
  return builds && args.some((word) => PUSH_FLAG.test(word)) ? 'build --push' : undefined;
}

const KUBECTL_WRITES = new Set(['apply', 'create', 'delete', 'replace', 'patch', 'scale', 'set', 'edit', 'rollout', 'drain', 'cordon', 'uncordon',
  'label', 'annotate', 'taint', 'expose', 'run']);
const ROLLOUT_READS = new Set(['status', 'history']); // they watch or list a rollout; max needs them to follow one
const LOCAL_FLAG = /^--local(?:=true)?$/; // `kubectl label|annotate|set --local -f x -o yaml` edits only the printed copy, never the cluster

function kubectlAsk([verb, action], args) {
  if (!KUBECTL_WRITES.has(verb) || (verb === 'rollout' && ROLLOUT_READS.has(action))) return undefined;
  return args.some((word) => LOCAL_FLAG.test(word)) ? undefined : verb;
}

const TERRAFORM_WRITES = new Set(['apply', 'destroy', 'import']);
const TERRAFORM_STATE_WRITES = new Set(['rm', 'mv', 'push']); // `state list|show|pull` only read the state

function terraformAsk([verb, action]) {
  if (TERRAFORM_WRITES.has(verb)) return verb;
  return verb === 'state' && TERRAFORM_STATE_WRITES.has(action) ? `state ${action}` : undefined;
}

// Vercel's commands that do not deploy. Any other first word is a project path, which `vercel <path>` deploys; a command missing here
// only costs a dialog.
const VERCEL_OTHER_COMMANDS = new Set(['api', 'bisect', 'blob', 'build', 'cache', 'certs', 'curl', 'dev', 'dns', 'domains', 'git',
  'help', 'httpstat', 'init', 'inspect', 'install', 'integration', 'link', 'list', 'login', 'logout', 'logs', 'ls', 'open', 'project',
  'projects', 'pull', 'switch', 'target', 'teams', 'telemetry', 'whoami']);
const VERCEL_DEPLOYS = new Set(['deploy', 'redeploy', 'promote', 'rollback', 'remove', 'rm']);
const PROD_FLAG = /^--prod(?:=|$)/;
const VERCEL_LIST = new Set(['ls', 'list']); // `vercel alias ls`; any other alias form (`set`, `rm`, `alias <deployment> <domain>`) points a domain
const VERCEL_ENV_WRITES = new Set(['add', 'rm', 'remove', 'update']); // `env ls|pull` only read the project's variables

function vercelAsk([first, action], args) {
  if (args.some((word) => PROD_FLAG.test(word))) return '--prod';
  if (first === undefined) return '(no sub-command)';
  if (VERCEL_DEPLOYS.has(first)) return first;
  if (first === 'alias') return VERCEL_LIST.has(action) ? undefined : 'alias';
  if (first === 'env') return VERCEL_ENV_WRITES.has(action) ? `env ${action}` : undefined;
  return VERCEL_OTHER_COMMANDS.has(first) ? undefined : 'with a project path';
}

function flyAsk([group, action]) {
  if (group === 'deploy' || group === 'scale') return group;
  if (group === 'apps' && action === 'destroy') return 'apps destroy';
  return group === 'secrets' && (action === 'set' || action === 'unset') ? `secrets ${action}` : undefined;
}

const WRANGLER_DEPLOYS = new Set(['deploy', 'publish']);
const WRANGLER_DEPLOY_GROUPS = new Set(['pages', 'versions']);
const WRANGLER_SECRET_WRITES = new Set(['put', 'delete']);

function wranglerAsk([group, action]) {
  if (WRANGLER_DEPLOYS.has(group)) return group;
  if (WRANGLER_DEPLOY_GROUPS.has(group) && WRANGLER_DEPLOYS.has(action)) return `${group} ${action}`;
  return group === 'secret' && WRANGLER_SECRET_WRITES.has(action) ? `secret ${action}` : undefined;
}

const FIREBASE_DEPLOY = /^(?:[\w-]+:)*deploy$/; // `deploy`, `hosting:channel:deploy`
const firebaseAsk = ([verb]) => (FIREBASE_DEPLOY.test(verb ?? '') ? 'deploy' : undefined);

const GCLOUD_COMMAND_DEPTH = 3; // `gcloud run deploy`, `gcloud beta run deploy`; a later word is a name (`... services describe deploy`)
// verbs that take a resource name: a `deploy` right after one is that name (`gcloud functions describe deploy`), not the deploy verb
const GCLOUD_NAME_VERBS = new Set(['describe', 'delete', 'list', 'logs', 'read', 'get', 'update', 'create', 'cancel']);

function gcloudAsk(words) {
  const at = words.slice(0, GCLOUD_COMMAND_DEPTH).indexOf('deploy');
  return at !== -1 && !GCLOUD_NAME_VERBS.has(words[at - 1]) ? '... deploy' : undefined;
}

const S3_URL = /^s3:\/\//i;
const S3_COPIES = new Set(['cp', 'sync']);
const S3_REMOVES = new Set(['rm', 'rb']);
const S3API_WRITE = /^(?:put|delete|create)-/; // put-object, delete-bucket, create-bucket ...; get-|list-|head- only read
const STACK_CHANGE = /^(?:deploy|execute-change-set|(?:create|update|delete)-.+)$/; // describe-|list-|validate- only read

/** aws: s3 writes (a copy to s3://, a move from or to it, a remove), s3api writes, CloudFormation stack changes, ecs update-service. */
function awsAsk([service, operation = '', ...paths]) {
  if (service === 's3' && S3_COPIES.has(operation) && paths.slice(1).some((path) => S3_URL.test(path))) return `s3 ${operation} to s3://`;
  if (service === 's3' && operation === 'mv' && paths.some((path) => S3_URL.test(path))) return 's3 mv';
  if (service === 's3' && S3_REMOVES.has(operation)) return `s3 ${operation}`;
  if (service === 's3api' && S3API_WRITE.test(operation)) return 's3api write'; // fixed text: the operation name is a command word
  if (service === 'cloudformation' && STACK_CHANGE.test(operation)) return 'cloudformation stack change';
  return service === 'ecs' && operation === 'update-service' ? 'ecs update-service' : undefined;
}

const AUTO_SUBMIT_FLAG = /^--auto-submit(?:-with-profile)?(?:=|$)/; // `eas build --auto-submit` sends the build to the app stores

function easAsk([verb], args) {
  if (verb === 'submit' || verb === 'update') return verb;
  return verb === 'build' && args.some((word) => AUTO_SUBMIT_FLAG.test(word)) ? 'build --auto-submit' : undefined;
}

const DOCKER_VALUE_OPTIONS = ['-c', '--context', '-H', '--host', '--config', '-l', '--log-level', '--tlscacert', '--tlscert', '--tlskey'];
const KUBE_VALUE_OPTIONS = ['-n', '--namespace', '--context', '--cluster', '--kubeconfig', '--user', '-s', '--server', '--token', '--as',
  '--as-group', '--as-uid', '--request-timeout', '--cache-dir', '--certificate-authority', '--client-certificate', '--client-key',
  '--tls-server-name', '-v', '--v', '--profile', '--profile-output', '--log-file'];
const HELM_VALUE_OPTIONS = ['-n', '--namespace', '--kube-context', '--kubeconfig', '--kube-apiserver', '--kube-token', '--kube-as-user',
  '--kube-as-group', '--kube-ca-file', '--registry-config', '--repository-config', '--repository-cache', '--burst-limit', '--qps'];
const PULUMI_VALUE_OPTIONS = ['-C', '--cwd', '-s', '--stack', '--color', '-v', '--verbose', '--tracing'];
const VERCEL_VALUE_OPTIONS = ['--cwd', '-A', '--local-config', '-Q', '--global-config', '-S', '--scope', '-t', '--token', '-T', '--team'];
const NETLIFY_VALUE_OPTIONS = ['--auth', '--filter', '--cwd'];
const FLY_VALUE_OPTIONS = ['-a', '--app', '-c', '--config', '-t', '--access-token'];
const WRANGLER_VALUE_OPTIONS = ['-c', '--config', '-e', '--env', '--cwd'];
const FIREBASE_VALUE_OPTIONS = ['-P', '--project', '--token', '--account'];
const GCLOUD_VALUE_OPTIONS = ['--project', '--account', '--configuration', '--verbosity', '--impersonate-service-account', '--billing-project',
  '--format', '--flags-file', '--region', '--zone'];
const AWS_VALUE_OPTIONS = ['--profile', '--region', '--output', '--endpoint-url', '--query', '--cli-read-timeout', '--cli-connect-timeout',
  '--ca-bundle', '--color', '--cli-binary-format'];
const SERVERLESS_VALUE_OPTIONS = ['-s', '--stage', '-r', '--region', '-c', '--config', '--org', '--app'];

/** One rule per tool: the options that take a value before its verb, and what asks (the verb phrase for the reason, or undefined). */
const rule = (valueOptions, ask) => ({ valueOptions: new Set(valueOptions), ask });
const RULES = new Map([
  ['docker', rule(DOCKER_VALUE_OPTIONS, containerAsk)],
  ['podman', rule([...DOCKER_VALUE_OPTIONS, '--connection', '--url', '--identity', '--root', '--runroot'], containerAsk)],
  ['kubectl', rule(KUBE_VALUE_OPTIONS, kubectlAsk)],
  ['helm', rule(HELM_VALUE_OPTIONS, firstWordIn(new Set(['install', 'upgrade', 'rollback', 'uninstall', 'delete', 'del', 'un', 'push'])))],
  ['terraform', rule([], terraformAsk)], // `-chdir=dir` is one word
  ['tofu', rule([], terraformAsk)],
  ['pulumi', rule(PULUMI_VALUE_OPTIONS, firstWordIn(new Set(['up', 'update', 'destroy', 'refresh'])))],
  ['vercel', rule(VERCEL_VALUE_OPTIONS, vercelAsk)],
  ['netlify', rule(NETLIFY_VALUE_OPTIONS, firstWordIn(new Set(['deploy'])))],
  ['ntl', rule(NETLIFY_VALUE_OPTIONS, firstWordIn(new Set(['deploy'])))],
  ['fly', rule(FLY_VALUE_OPTIONS, flyAsk)],
  ['flyctl', rule(FLY_VALUE_OPTIONS, flyAsk)],
  ['wrangler', rule(WRANGLER_VALUE_OPTIONS, wranglerAsk)],
  ['firebase', rule(FIREBASE_VALUE_OPTIONS, firebaseAsk)],
  ['gcloud', rule(GCLOUD_VALUE_OPTIONS, gcloudAsk)],
  ['aws', rule(AWS_VALUE_OPTIONS, awsAsk)],
  ['serverless', rule(SERVERLESS_VALUE_OPTIONS, firstWordIn(new Set(['deploy', 'remove'])))], // remove tears the service down
  ['sls', rule(SERVERLESS_VALUE_OPTIONS, firstWordIn(new Set(['deploy', 'remove'])))],
  ['eas', rule([], easAsk)],
]);

/** The command names deployAsk has a rule for (lib/dangerous-scan.mjs tries them behind an unknown wrapper or a package runner). */
export const DEPLOY_TOOLS = Object.freeze([...RULES.keys()]);

const READINGS = [false, true]; // an unknown option without a value, then with one

/** True when one of RUN_TIME_PHRASES in place of every run-time word of `words` makes the rule ask. */
function runTimeAsks(toolRule, words, args) {
  if (!words.some((word) => RUN_TIME_WORD.test(word))) return false;
  return RUN_TIME_PHRASES.some((phrase) =>
    toolRule.ask(words.flatMap((word) => (RUN_TIME_WORD.test(word) ? phrase : [word])), args) !== undefined);
}

/**
 * Reason to ask the owner before a deploy or cloud change, or undefined.
 * @param {string} cmd command name as lib/command-of.mjs commandName gives it (`vercel.cmd` is `vercel`)
 * @param {string[]} args words after the command
 * @returns {string | undefined} `<tool> <verb> deploys or changes live infrastructure; confirm with the owner` (for a run-time word,
 *   `<tool> with a word filled in at run time possibly ...`); undefined for another tool, another verb or a dry run
 */
export function deployAsk(cmd, args) {
  const toolRule = RULES.get(cmd);
  if (toolRule === undefined || isDryRun(args)) return undefined;
  const readings = READINGS.map((unknownTakesValue) => commandWords(args, toolRule.valueOptions, unknownTakesValue));
  const verb = readings.map((words) => toolRule.ask(words, args)).find((asked) => asked !== undefined);
  if (verb !== undefined) return `${cmd} ${verb} ${DEPLOY_REASON_TAIL}`;
  const hidden = readings.some((words) => runTimeAsks(toolRule, words, args));
  return hidden ? `${cmd} with a word filled in at run time possibly ${DEPLOY_REASON_TAIL}` : undefined;
}
