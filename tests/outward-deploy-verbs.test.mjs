// Tests for the deploy verbs of home/hooks/lib/deploy.mjs through the guard's decide() (plan M2, case 1): every verb of every deploy
// and cloud tool asks with the exact fixed reason `<tool> <verb> deploys or changes live infrastructure; confirm with the owner`, and
// commandName (lib/command-of.mjs) turns a path, a Windows suffix or another case into the tool name the rules know (case 8).
// Only command strings are passed to decide(); nothing is executed.
import './pin-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { decide } from '../home/hooks/pre-bash-guard.mjs';
import { commandName } from '../home/hooks/lib/command-of.mjs';
import { DEPLOY_REASON_TAIL, DEPLOY_TOOLS, deployAsk } from '../home/hooks/lib/deploy.mjs';

const PROJECT = resolve('/work/proj');
const ctx = { cwd: PROJECT, project: PROJECT };
// The owner-facing wording, spelled out so a changed tail fails here and not only in the class pattern.
const TAIL = 'deploys or changes live infrastructure; confirm with the owner';
const reasonFor = (phrase) => `${phrase} ${TAIL}`;

// [command line, the "<tool> <verb>" phrase its reason must name]
const VERBS = [
  ['docker push registry.example/app:1', 'docker push'],
  ['docker image push registry.example/app:1', 'docker image push'],
  ['docker manifest push registry.example/app:1', 'docker manifest push'],
  ['docker compose push', 'docker compose push'],
  ['docker build --push -t app .', 'docker build --push'],
  ['docker buildx build --push -t app .', 'docker build --push'],
  ['docker buildx build --push=true -t app .', 'docker build --push'],
  ['podman push app', 'podman push'],
  ...['apply -f x.yaml', 'create ns a', 'delete pod a', 'replace -f x', 'patch deploy a -p {}', 'scale deploy a --replicas=2', 'set image deploy/a a=b',
    'edit deploy a', 'drain node1', 'cordon node1', 'uncordon node1', 'label pod a k=v', 'annotate pod a k=v', 'taint node n1 k=v:NoSchedule',
    'expose deploy a --port=80', 'run a --image=b'].map((rest) => [`kubectl ${rest}`, `kubectl ${rest.split(' ')[0]}`]),
  ['kubectl rollout restart deploy/a', 'kubectl rollout'],
  ['kubectl rollout undo deploy/a', 'kubectl rollout'],
  ...['install', 'upgrade', 'rollback', 'uninstall', 'delete', 'del', 'un', 'push'].map((verb) => [`helm ${verb} rel chart`, `helm ${verb}`]),
  ...['apply', 'destroy', 'import'].map((verb) => [`terraform ${verb}`, `terraform ${verb}`]),
  ...['rm', 'mv', 'push'].map((action) => [`terraform state ${action} a.b`, `terraform state ${action}`]),
  ['tofu apply -auto-approve', 'tofu apply'],
  ['tofu state rm a.b', 'tofu state rm'],
  ...['up', 'update', 'destroy', 'refresh'].map((verb) => [`pulumi ${verb} --yes`, `pulumi ${verb}`]),
  ['vercel', 'vercel (no sub-command)'],
  ['vercel --prod', 'vercel --prod'],
  ['vercel ls --prod', 'vercel --prod'],
  ['vercel ./site', 'vercel with a project path'],
  ...['deploy', 'redeploy', 'promote', 'rollback', 'remove', 'rm'].map((verb) => [`vercel ${verb} x`, `vercel ${verb}`]),
  ['vercel alias set a.vercel.app example.com', 'vercel alias'],
  ...['add', 'rm', 'remove', 'update'].map((action) => [`vercel env ${action} KEY production`, `vercel env ${action}`]),
  ['netlify deploy --prod', 'netlify deploy'],
  ['ntl deploy', 'ntl deploy'],
  ['fly deploy', 'fly deploy'],
  ['flyctl scale count 2', 'flyctl scale'],
  ['fly apps destroy app', 'fly apps destroy'],
  ['fly secrets set K=V', 'fly secrets set'],
  ['flyctl secrets unset K', 'flyctl secrets unset'],
  ['wrangler deploy', 'wrangler deploy'],
  ['wrangler publish', 'wrangler publish'],
  ['wrangler pages deploy dist', 'wrangler pages deploy'],
  ['wrangler pages publish dist', 'wrangler pages publish'],
  ['wrangler versions deploy', 'wrangler versions deploy'],
  ['wrangler secret put KEY', 'wrangler secret put'],
  ['wrangler secret delete KEY', 'wrangler secret delete'],
  ['firebase deploy', 'firebase deploy'],
  ['firebase hosting:channel:deploy preview', 'firebase deploy'],
  ['gcloud run deploy svc', 'gcloud ... deploy'],
  ['gcloud beta run deploy svc', 'gcloud ... deploy'],
  ['gcloud app deploy', 'gcloud ... deploy'],
  ['aws s3 cp a.txt s3://bucket/a.txt', 'aws s3 cp to s3://'],
  ['aws s3 sync dist s3://bucket', 'aws s3 sync to s3://'],
  ['aws s3 mv s3://bucket/a ./a', 'aws s3 mv'],
  ['aws s3 rm s3://bucket/a', 'aws s3 rm'],
  ['aws s3 rb s3://bucket', 'aws s3 rb'],
  ['aws s3api put-object --bucket b --key k', 'aws s3api write'],
  ['aws s3api delete-bucket --bucket b', 'aws s3api write'],
  ['aws s3api create-bucket --bucket b', 'aws s3api write'],
  ['aws cloudformation deploy --stack-name s', 'aws cloudformation stack change'],
  ['aws cloudformation delete-stack --stack-name s', 'aws cloudformation stack change'],
  ['aws cloudformation execute-change-set --change-set-name c', 'aws cloudformation stack change'],
  ['aws ecs update-service --service s', 'aws ecs update-service'],
  ['serverless deploy', 'serverless deploy'],
  ['sls remove', 'sls remove'],
  ['eas submit', 'eas submit'],
  ['eas update', 'eas update'],
  ['eas build --auto-submit', 'eas build --auto-submit'],
];

test('decide asks for every deploy verb with the exact fixed reason that names the tool and the verb', () => {
  for (const [command, phrase] of VERBS) {
    const result = decide(command, ctx);
    assert.equal(result.allow, false, command);
    assert.equal(result.ask, true, command);
    assert.ok(result.reasons.includes(reasonFor(phrase)), `${command}: ${JSON.stringify(result.reasons)}`);
  }
});

test('every tool with a rule has at least one verb in the table above (a new tool needs its row)', () => {
  const covered = new Set(VERBS.map(([command]) => command.split(' ')[0]));
  for (const tool of DEPLOY_TOOLS) assert.ok(covered.has(tool), tool);
});

test('DEPLOY_REASON_TAIL is the owner-facing wording and deployAsk joins tool, verb and tail with single spaces', () => {
  assert.equal(DEPLOY_REASON_TAIL, TAIL);
  assert.equal(deployAsk('kubectl', ['apply', '-f', 'x']), reasonFor('kubectl apply'));
  assert.equal(deployAsk('terraform', ['state', 'rm', 'a']), reasonFor('terraform state rm'));
});

test('a reason holds only fixed text: no word of the command (a resource name, a path, a value) reaches it', () => {
  const NAME = 'Zq7SecretishName';
  for (const command of [`kubectl delete pod ${NAME}`, `helm upgrade ${NAME} chart`, `vercel ./${NAME}`, `aws s3 rm s3://${NAME}/a`,
    `fly secrets set ${NAME}=1`, `wrangler secret put ${NAME}`]) {
    const { reasons } = decide(command, ctx);
    assert.ok(reasons.some((reason) => reason.endsWith(TAIL)), command);
    for (const reason of reasons) assert.ok(!reason.includes(NAME), `${command}: ${reason}`);
  }
});

test('deployAsk: dry runs are not asked, but a dry-run value that runs for real is, and so is a dry-run flag after --', () => {
  assert.equal(deployAsk('kubectl', ['apply', '-f', 'x', '--dry-run=client']), undefined);
  assert.equal(deployAsk('kubectl', ['apply', '-f', 'x', '--dry-run=server']), undefined);
  assert.equal(deployAsk('helm', ['upgrade', 'a', 'b', '--dry-run']), undefined);
  assert.equal(deployAsk('aws', ['s3', 'sync', 'd', 's3://b', '--dryrun']), undefined);
  for (const value of ['none', 'false', 'f', '0', '', 'NONE', 'False']) {
    assert.equal(deployAsk('kubectl', ['apply', '-f', 'x', `--dry-run=${value}`]), reasonFor('kubectl apply'), value);
  }
  assert.equal(deployAsk('kubectl', ['apply', '-f', 'x', '--', '--dry-run']), reasonFor('kubectl apply'));
});

test('deployAsk reads the verb after the options that take a value, and stops at --', () => {
  assert.equal(deployAsk('kubectl', ['-n', 'prod', '--context', 'c', 'apply', '-f', 'x']), reasonFor('kubectl apply'));
  assert.equal(deployAsk('helm', ['--kube-context', 'p', '-n', 'ns', 'upgrade', 'a', 'b']), reasonFor('helm upgrade'));
  assert.equal(deployAsk('docker', ['--context', 'remote', 'push', 'img']), reasonFor('docker push'));
  assert.equal(deployAsk('pulumi', ['-C', 'infra', '-s', 'prod', 'up']), reasonFor('pulumi up'));
  assert.equal(deployAsk('fly', ['-a', 'app', 'deploy']), reasonFor('fly deploy'));
  assert.equal(deployAsk('aws', ['--profile', 'p', '--region', 'r', 's3', 'rm', 's3://b/a']), reasonFor('aws s3 rm'));
  // `kubectl exec pod -- kubectl apply`: the words after -- belong to the program run in the pod, not to this kubectl
  assert.equal(deployAsk('kubectl', ['exec', 'pod', '--', 'apply']), undefined);
});

test('deployAsk: a tool with no rule and an unknown verb give undefined', () => {
  assert.equal(deployAsk('git', ['push']), undefined);
  assert.equal(deployAsk('kubectl', ['get', 'pods']), undefined);
  assert.equal(deployAsk('kubectl', []), undefined);
});

// Case 8: commandName gives the name the rules are keyed on.
test('commandName strips the folder and a .exe, .cmd or .bat suffix in any case', () => {
  for (const word of ['/usr/local/bin/kubectl', 'kubectl.exe', 'kubectl.EXE', 'kubectl.cmd', 'kubectl.Bat', 'x/y/kubectl.bat', 'C:\\tools\\kubectl.exe']) {
    assert.equal(commandName(word), 'kubectl', word);
  }
});

test('commandName folds case on macOS and Windows (their file systems find KUBECTL as kubectl) and keeps it on Linux', () => {
  const expected = process.platform === 'linux' ? 'KUBECTL' : 'kubectl';
  assert.equal(commandName('KUBECTL'), expected);
  assert.equal(commandName('/opt/bin/Vercel.CMD'), process.platform === 'linux' ? 'Vercel' : 'vercel');
});

test('commandName keeps a word with a variable as it is (the guard asks for a variable command word on its own)', () => {
  assert.equal(commandName('$TOOL'), '$TOOL');
});

test('decide asks for a path-qualified, suffixed or upper-case deploy tool with the reason of the plain name', () => {
  const rows = [['/usr/local/bin/kubectl apply -f x', 'kubectl apply'], ['kubectl.exe apply -f x', 'kubectl apply'], ['vercel.cmd --prod', 'vercel --prod'],
    ['x/y/helm.bat upgrade a b', 'helm upgrade'], ['./node_modules/.bin/wrangler deploy', 'wrangler deploy']];
  if (process.platform !== 'linux') rows.push(['KUBECTL apply -f x', 'kubectl apply'], ['Terraform.EXE apply', 'terraform apply']);
  for (const [command, phrase] of rows) assert.ok(decide(command, ctx).reasons?.includes(reasonFor(phrase)), command);
});
