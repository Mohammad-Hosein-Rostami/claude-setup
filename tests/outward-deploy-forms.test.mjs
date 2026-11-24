// Tests for the forms a deploy command can take (plan M2, case 1): behind options, wrappers, shells, $(...), package runners, paths,
// Windows suffixes, quotes and compound lines, the guard's decide() still asks with the deploy tool's exact reason; and the guard
// hook itself, with no GUI and no max, hands the deploy reason to Claude Code's own prompt. Nothing here runs a deploy tool.
import './pin-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { decide } from '../home/hooks/pre-bash-guard.mjs';
import { hookAnswer, isolatedEnv, runGuard } from './outward-deploy-helpers.mjs';

const PROJECT = resolve('/work/proj');
const ctx = { cwd: PROJECT, project: PROJECT };
const TAIL = 'deploys or changes live infrastructure; confirm with the owner';
const reasonFor = (phrase) => `${phrase} ${TAIL}`;
const NO_GUI = { SSH_CONNECTION: '10.0.0.1 50000 10.0.0.2 22' }; // guiAvailable is false over ssh: the hook answers "ask", no dialog

const assertAsksWith = (command, phrase) => {
  const result = decide(command, ctx);
  assert.equal(result.ask, true, command);
  assert.ok(result.reasons.includes(reasonFor(phrase)), `${command}: ${JSON.stringify(result.reasons)}`);
};

const OPTIONS = [
  ['kubectl -n prod apply -f x', 'kubectl apply'],
  ['kubectl --context prod --namespace ns delete pod a', 'kubectl delete'],
  ['helm --kube-context p upgrade x y', 'helm upgrade'],
  ['docker --context remote push img', 'docker push'],
  ['docker -H tcp://h:2375 image push img', 'docker image push'],
  ['pulumi --cwd infra --stack prod up', 'pulumi up'],
  ['vercel --scope team deploy', 'vercel deploy'],
  ['fly --app web deploy', 'fly deploy'],
  ['wrangler --env production deploy', 'wrangler deploy'],
  ['firebase --project p deploy', 'firebase deploy'],
  ['gcloud --project p run deploy svc', 'gcloud ... deploy'],
  ['aws --profile p --region eu-west-1 s3 sync dist s3://b', 'aws s3 sync to s3://'],
  ['serverless --stage prod deploy', 'serverless deploy'],
  ['terraform -chdir=infra apply', 'terraform apply'],
];

test('a deploy verb after the tool\'s own options asks with that tool and verb', () => {
  for (const [command, phrase] of OPTIONS) assertAsksWith(command, phrase);
});

const WRAPPERS = [
  'env X=1 kubectl apply -f x', 'env -i kubectl apply -f x', 'sudo kubectl apply -f x', 'sudo -u root kubectl apply -f x', 'nohup kubectl apply -f x',
  'time kubectl apply -f x', 'command kubectl apply -f x', 'exec kubectl apply -f x', 'timeout 60 kubectl apply -f x', 'nice -n 5 kubectl apply -f x',
  'xargs kubectl apply -f', 'X=1 kubectl apply -f x', 'eval kubectl apply -f x', 'eval "kubectl apply -f x"',
];

test('a deploy behind a wrapper (env, sudo, nohup, time, command, exec, timeout, nice, xargs, eval, an assignment) asks', () => {
  for (const command of WRAPPERS) assertAsksWith(command, 'kubectl apply');
});

const SHELLS = [
  "sh -c 'kubectl apply -f x'", 'bash -c "kubectl apply -f x"', "bash -lc 'kubectl apply -f x'", "zsh -c 'kubectl apply -f x'",
  'echo $(kubectl apply -f x)', 'out="$(kubectl apply -f x)"', "bash -c 'cd infra && kubectl apply -f x'", '(kubectl apply -f x)',
  '{ kubectl apply -f x; }', 'if true; then kubectl apply -f x; fi',
];

test('a deploy inside a shell string, a $(...) substitution, a subshell or a block asks', () => {
  for (const command of SHELLS) assertAsksWith(command, 'kubectl apply');
});

test('a deploy in backticks asks with the deploy reason among its reasons', () => {
  assertAsksWith('echo `kubectl apply -f x`', 'kubectl apply');
});

const RUNNERS = [
  ['npx vercel --prod', 'vercel --prod'],
  ['npx -y vercel deploy --prod', 'vercel --prod'],
  ['bunx vercel --prod', 'vercel --prod'],
  ['pnpm dlx wrangler deploy', 'wrangler deploy'],
  ['pnpm exec wrangler deploy', 'wrangler deploy'],
  ['yarn dlx vercel --prod', 'vercel --prod'],
  ['npm exec vercel --prod', 'vercel --prod'],
  ['npx netlify deploy', 'netlify deploy'],
  ['npx firebase deploy', 'firebase deploy'],
  ['npx serverless deploy', 'serverless deploy'],
  ['npx eas submit', 'eas submit'],
];

test('a deploy started through npx, bunx, pnpm dlx|exec, yarn dlx or npm exec asks with the tool\'s reason', () => {
  for (const [command, phrase] of RUNNERS) assertAsksWith(command, phrase);
});

test('a path-qualified or suffixed tool name asks as the plain name', () => {
  for (const [command, phrase] of [['/usr/local/bin/kubectl apply -f x', 'kubectl apply'], ['kubectl.exe apply -f x', 'kubectl apply'],
    ['vercel.cmd --prod', 'vercel --prod'], ['kubectl.bat apply -f x', 'kubectl apply'], ['x/y/kubectl.bat apply -f x', 'kubectl apply'],
    ['C:/tools/terraform.exe destroy', 'terraform destroy']]) assertAsksWith(command, phrase);
});

test('quoted words ask as the bare words', () => {
  for (const command of ["'kubectl' \"apply\" -f x", '"kubectl" apply -f x', "kubectl 'apply' -f x", 'k\\ubectl apply -f x']) assertAsksWith(command, 'kubectl apply');
});

test('each deploy in a compound line asks, after && || ; | and &', () => {
  for (const command of ['cd x && kubectl apply -f y', 'make build || kubectl apply -f y', 'echo a; kubectl apply -f y', 'cat y | kubectl apply -f -',
    'kubectl apply -f y &', 'pnpm build && npx vercel --prod && echo done']) {
    const phrase = command.includes('vercel') ? 'vercel --prod' : 'kubectl apply';
    assertAsksWith(command, phrase);
  }
  const both = decide('terraform apply && helm upgrade a b', ctx).reasons;
  assert.ok(both.includes(reasonFor('terraform apply')) && both.includes(reasonFor('helm upgrade')), JSON.stringify(both));
});

test('hook: with no GUI and no max running, a deploy gets Claude Code\'s own prompt with the exact deploy reason', () => {
  for (const [command, phrase] of [['kubectl apply -f x', 'kubectl apply'], ['sudo helm upgrade a b && echo ok', 'helm upgrade'],
    ['bash -lc "npx vercel --prod"', 'vercel --prod'], ['/usr/local/bin/terraform destroy', 'terraform destroy']]) {
    assert.deepEqual(hookAnswer(runGuard(command, isolatedEnv(NO_GUI))), { decision: 'ask', reason: reasonFor(phrase) }, command);
  }
});

test('hook: a read-only form of the same tools passes with no output', () => {
  for (const command of ['kubectl get pods', 'terraform plan', 'helm list']) {
    assert.deepEqual(hookAnswer(runGuard(command, isolatedEnv(NO_GUI))), { decision: 'allow', reason: '' }, command);
  }
});
