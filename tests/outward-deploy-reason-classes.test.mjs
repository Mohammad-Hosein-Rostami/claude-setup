// Tests for the deploy class of home/hooks/lib/reason-classes.mjs (plan M2, case 7): every deploy reason has the outward class
// "deploy or cloud change", so keepsDialog keeps its dialog under CLAUDE_GUARD_ASK=allow, while a local ask (git --no-verify, rm -r
// outside the project) does not; and the guard hook shows that: a deploy opens its dialog with the switch on, a local ask does not.
// Only command strings are passed to decide(); the hook runs with a fake dialog tool and a temp HOME.
import './pin-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decide } from '../home/hooks/pre-bash-guard.mjs';
import { DEPLOY_REASON_TAIL, DEPLOY_TOOLS } from '../home/hooks/lib/deploy.mjs';
import { ASK_CLASSES, keepsDialog, reasonClass } from '../home/hooks/lib/reason-classes.mjs';
import { fakeDialog, hookAnswer, runGuard } from './outward-deploy-helpers.mjs';

const PROJECT = resolve('/work/proj');
const ctx = { cwd: PROJECT, project: PROJECT };
const DEPLOY_CLASS = 'deploy or cloud change';
const reasonsOf = (command) => decide(command, ctx).reasons;
const DEPLOYS = ['docker push a', 'podman push a', 'kubectl apply -f x', 'kubectl rollout restart deploy/a', 'helm upgrade a b', 'terraform state rm a',
  'tofu destroy', 'pulumi up', 'vercel', 'vercel ./site', 'vercel --prod', 'vercel env add K production', 'netlify deploy', 'ntl deploy', 'fly apps destroy a',
  'flyctl deploy', 'wrangler pages deploy d', 'firebase deploy', 'gcloud run deploy s', 'aws s3 cp a s3://b/a', 'aws cloudformation deploy',
  'serverless deploy', 'sls remove', 'eas build --auto-submit'];
const LOCAL_ASKS = ['git commit --no-verify -m x', 'rm -rf /etc/zq-guard-test'];

test('"deploy or cloud change" is one of the ask classes', () => {
  assert.ok(ASK_CLASSES.includes(DEPLOY_CLASS));
});

test('every deploy reason the guard gives has the deploy class, for every tool with a rule', () => {
  const tools = new Set();
  for (const command of DEPLOYS) {
    const reasons = reasonsOf(command);
    const deploy = reasons.filter((reason) => reason.endsWith(DEPLOY_REASON_TAIL));
    assert.equal(deploy.length, 1, `${command}: ${JSON.stringify(reasons)}`);
    assert.equal(reasonClass(deploy[0]), DEPLOY_CLASS, deploy[0]);
    tools.add(deploy[0].split(' ')[0]);
  }
  assert.deepEqual([...tools].sort(), [...DEPLOY_TOOLS].sort());
});

test('the class matches only a known deploy tool with the fixed tail: another tool name or another tail is not the deploy class', () => {
  assert.notEqual(reasonClass(`ansible apply ${DEPLOY_REASON_TAIL}`), DEPLOY_CLASS);
  assert.notEqual(reasonClass('kubectl apply changes the cluster'), DEPLOY_CLASS);
  assert.notEqual(reasonClass(`kubectl ${DEPLOY_REASON_TAIL}`), DEPLOY_CLASS); // a tool with no verb phrase is no reason deployAsk writes
});

test('keepsDialog: a deploy reason keeps the dialog, alone or next to a local ask', () => {
  assert.equal(keepsDialog(reasonsOf('kubectl apply -f x')), true);
  assert.equal(keepsDialog(reasonsOf('kubectl apply -f x && rm -rf /etc/zq-guard-test')), true);
  assert.equal(keepsDialog(reasonsOf('git push origin main')), true);
});

test('keepsDialog: git --no-verify and rm -r outside the project do not keep it (CLAUDE_GUARD_ASK=allow may skip them)', () => {
  for (const command of LOCAL_ASKS) {
    const reasons = reasonsOf(command);
    assert.equal(reasons.length, 1, `${command}: ${JSON.stringify(reasons)}`);
    assert.equal(keepsDialog(reasons), false, command);
  }
  assert.equal(reasonClass(reasonsOf(LOCAL_ASKS[0])[0]), 'git --no-verify');
  assert.equal(reasonClass(reasonsOf(LOCAL_ASKS[1])[0]), 'rm -r outside the project');
});

test('keepsDialog: a reason no class knows keeps the dialog (unknown counts as outward)', () => {
  assert.equal(keepsDialog(['some new reason no rule wrote']), true);
});

/** CLAUDE_GUARD_ASK=allow only in the temp HOME's user settings file. */
function switchInSettings(home) {
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_GUARD_ASK: 'allow' } }));
}

test('hook, main session, CLAUDE_GUARD_ASK=allow in the settings file: a deploy still opens its dialog and a Deny click denies', () => {
  const dialog = fakeDialog('deny');
  switchInSettings(dialog.env.HOME);
  assert.equal(hookAnswer(runGuard('vercel --prod', dialog.env)).decision, 'deny');
  assert.equal(dialog.opened(), true);
});

test('hook, main session, CLAUDE_GUARD_ASK=allow in the settings file: a local ask is allowed at once with no dialog', () => {
  for (const command of LOCAL_ASKS) {
    const dialog = fakeDialog('deny');
    switchInSettings(dialog.env.HOME);
    assert.deepEqual(hookAnswer(runGuard(command, dialog.env)), { decision: 'allow', reason: '' }, command);
    assert.equal(dialog.opened(), false, command);
    assert.equal(dialog.log().find((line) => line.hook === 'pre-bash-guard').outcome, 'switch-allow', command);
  }
});
