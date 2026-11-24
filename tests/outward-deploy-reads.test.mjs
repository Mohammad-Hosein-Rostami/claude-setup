// Tests for the read-only forms of the deploy and cloud tools (plan M2, case 2; owner: read-only verbs must NOT ask): reads, lists,
// local builds and dry runs pass the guard's decide(), and the guard hook opens no dialog for them, not even while a max runs.
// Only command strings are passed to decide(); the hook runs with a fake dialog tool and a temp HOME.
import './pin-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { decide } from '../home/hooks/pre-bash-guard.mjs';
import { fakeDialog, hookAnswer, MAX_AGENT, runGuard, runningMax, SESSION, writeRecord } from './outward-deploy-helpers.mjs';

const PROJECT = resolve('/work/proj');
const ctx = { cwd: PROJECT, project: PROJECT };

const READS = {
  docker: ['docker build -t a .', 'docker build --push=false -t a .', 'docker buildx build --push=false .', 'docker images', 'docker pull a',
    'docker image ls', 'podman images'],
  kubectl: ['kubectl get pods', 'kubectl describe pod a', 'kubectl logs a', 'kubectl diff -f x', 'kubectl rollout status deploy/a',
    'kubectl rollout history deploy/a', 'kubectl explain pods', 'kubectl config get-contexts', 'kubectl version', 'kubectl -n prod get pods'],
  'kubectl --local': ['kubectl label --local -f x k=v -o yaml', 'kubectl set image --local=true -f x a=b -o yaml', 'kubectl annotate --local -f x k=v -o yaml'],
  helm: ['helm list', 'helm template a chart', 'helm status a', 'helm history a', 'helm repo list'],
  'terraform and tofu': ['terraform plan', 'terraform state list', 'terraform state show a.b', 'terraform state pull', 'terraform init',
    'terraform validate', 'terraform output', 'tofu plan'],
  pulumi: ['pulumi preview', 'pulumi stack ls'],
  vercel: ['vercel ls', 'vercel list', 'vercel dev', 'vercel env ls', 'vercel env pull', 'vercel alias ls', 'vercel alias list', 'vercel whoami',
    'vercel logs https://a.vercel.app', 'vercel build', 'vercel link', 'npx vercel ls'],
  netlify: ['netlify status', 'netlify dev', 'ntl status'],
  fly: ['fly status', 'fly logs', 'fly secrets list', 'fly apps list', 'flyctl status'],
  wrangler: ['wrangler dev', 'wrangler whoami', 'wrangler pages dev dist', 'wrangler secret list', 'wrangler tail', 'npx wrangler dev'],
  firebase: ['firebase serve', 'firebase emulators:start', 'firebase projects:list'],
  gcloud: ['gcloud run services list', 'gcloud config list', 'gcloud functions describe fn'],
  aws: ['aws s3 ls s3://b', 'aws s3 cp s3://b/a ./a', 'aws s3 sync s3://b ./d', 'aws s3api get-object --bucket b --key k out', 'aws s3api list-buckets',
    'aws s3api head-object --bucket b --key k', 'aws cloudformation describe-stacks', 'aws cloudformation list-stacks',
    'aws cloudformation validate-template --template-body x', 'aws ecs describe-services --services s', 'aws sts get-caller-identity'],
  serverless: ['serverless info', 'sls print'],
  eas: ['eas build', 'eas build --profile preview', 'eas whoami'],
};

const DRY_RUNS = ['kubectl apply -f x --dry-run=client', 'kubectl apply -f x --dry-run=server', 'kubectl delete pod a --dry-run', 'helm upgrade a b --dry-run',
  'helm install a b --dry-run=client', 'aws s3 sync dist s3://b --dryrun', 'aws s3 rm s3://b/a --dryrun'];

for (const [tool, commands] of Object.entries(READS)) {
  test(`decide passes the read-only forms of ${tool}`, () => {
    for (const command of commands) assert.equal(decide(command, ctx).allow, true, `${command}: ${JSON.stringify(decide(command, ctx).reasons)}`);
  });
}

test('decide passes a dry run (--dry-run, --dry-run=client|server, aws --dryrun) of a deploy verb', () => {
  for (const command of DRY_RUNS) assert.equal(decide(command, ctx).allow, true, command);
});

test('decide passes a deploy word that is only an argument of another command or a quoted text', () => {
  for (const command of ['echo kubectl apply -f x', 'grep -r "terraform destroy" docs', 'git commit -m "vercel --prod later"', 'cat deploy.sh',
    'printf "%s\\n" "helm upgrade"']) assert.equal(decide(command, ctx).allow, true, command);
});

test('hook: read-only forms open no dialog and give no decision, also while a max runs (max needs them to follow its work)', () => {
  for (const command of ['kubectl get pods', 'kubectl rollout status deploy/a', 'terraform plan', 'vercel ls', 'aws s3 ls s3://b',
    'kubectl apply -f x --dry-run=client']) {
    const dialog = fakeDialog('deny');
    writeRecord(dialog.env.HOME, SESSION, runningMax(Date.now()));
    const result = runGuard(command, dialog.env, { agent_type: 'max', agent_id: MAX_AGENT });
    assert.deepEqual(hookAnswer(result), { decision: 'allow', reason: '' }, command);
    assert.equal(dialog.opened(), false, command);
  }
});
