// Failing repros for plans M2 and M2b (tess-write, outward-deploy): each test states the owner's rule in its name and FAILS on the tip
// because the guard misses the form. Owner rules: outward actions (deploy) always ask; max never acts outward by itself, so a Claude
// session or long-run started from its work is denied; read-only verbs must not ask. Only command strings are read; nothing runs.
import './pin-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { decide } from '../home/hooks/pre-bash-guard.mjs';
import { CLAUDE_START_REASON, claudeStartDeny } from '../home/hooks/lib/claude-start-deny.mjs';
import { lineStartsClaude } from '../home/hooks/lib/claude-starts.mjs';
import { isolatedEnv, MAX_AGENT } from './outward-deploy-helpers.mjs';

const PROJECT = resolve('/work/proj');
const ctx = { cwd: PROJECT, project: PROJECT };
const TAIL = 'deploys or changes live infrastructure; confirm with the owner';
const MAX = { agent_type: 'max', agent_id: MAX_AGENT, session_id: 'session-12345678' };
const LONG_RUN = 'node ~/.claude/tools/long-run/long-run.mjs';

const assertAsksWith = (command, phrase) => {
  const result = decide(command, ctx);
  assert.equal(result.allow, false, `${command} was allowed with no ask`);
  assert.ok(result.reasons.includes(`${phrase} ${TAIL}`), `${command}: ${JSON.stringify(result.reasons)}`);
};

// `pnpm <bin>` and `yarn <bin>` run a package's bin by its name (Cloudflare's own docs write `pnpm wrangler deploy` and
// `yarn wrangler deploy`), the same as `pnpm exec` and `yarn exec`, which already ask.
test('outward always asks: pnpm <deploy bin> (pnpm wrangler deploy, pnpm vercel --prod) asks like pnpm exec', () => {
  assertAsksWith('pnpm wrangler deploy', 'wrangler deploy');
  assertAsksWith('pnpm vercel --prod', 'vercel --prod');
});

test('outward always asks: yarn <deploy bin> (yarn wrangler deploy, yarn vercel --prod) asks like yarn exec', () => {
  assertAsksWith('yarn wrangler deploy', 'wrangler deploy');
  assertAsksWith('yarn vercel --prod', 'vercel --prod');
});

// `long-run.mjs drive <run>` runs the driver of a run in the foreground: it starts the run's `claude -p` step sessions, as `resume` does.
test('max never starts a session: long-run.mjs drive <run> is a Claude start and is denied for max', () => {
  const command = `${LONG_RUN} drive r1`;
  assert.equal(lineStartsClaude(command), true, command);
  assert.match(claudeStartDeny(command, MAX, isolatedEnv()), new RegExp(CLAUDE_START_REASON.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

// npx, bunx and pnpx of @anthropic-ai/claude-code already count; pnpm dlx, yarn dlx and npm exec run the same package the same way.
test('max never starts a session: pnpm dlx, yarn dlx and npm exec of @anthropic-ai/claude-code are Claude starts', () => {
  for (const command of ['pnpm dlx @anthropic-ai/claude-code -p x', 'yarn dlx @anthropic-ai/claude-code -p x', 'npm exec @anthropic-ai/claude-code -- -p x']) {
    assert.equal(lineStartsClaude(command), true, command);
  }
});

// `pnpm exec <cmd>` runs any command with node_modules/.bin first on PATH, so it runs the installed claude.
test('max never starts a session: pnpm exec claude -p x is a Claude start', () => {
  assert.equal(lineStartsClaude('pnpm exec claude -p x'), true);
});

// `deploy` as the third command word is a resource name after a read verb here (a Cloud Function named "deploy").
test('read-only verbs must not ask: gcloud functions describe deploy is a read, not a deploy', () => {
  const result = decide('gcloud functions describe deploy', ctx);
  assert.equal(result.allow, true, JSON.stringify(result.reasons));
});
