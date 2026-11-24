// Tests for the Bash guard's Claude-start deny (plan M2b, case 6): max prepares only, so a Claude Code session or a long-run started
// from max's work (max itself, or any subagent while a max runs, or while the record cannot be read) is denied every time, with no
// dialog; the main session's own calls and every other line are never denied here (lib/claude-starts.mjs, lib/claude-start-deny.mjs).
// Only command strings are read; nothing starts Claude. The hook runs with a fake dialog tool and a temp HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_START_OUTCOME, CLAUDE_START_REASON, claudeStartDeny } from '../home/hooks/lib/claude-start-deny.mjs';
import { lineStartsClaude } from '../home/hooks/lib/claude-starts.mjs';
import { fakeDialog, hookAnswer, isolatedEnv, MAX_AGENT, runGuard, runningMax, SESSION, stoppedMax, writeRecord } from './outward-deploy-helpers.mjs';

const LONG_RUN = 'node ~/.claude/tools/long-run/long-run.mjs';
const MAX = { agent_type: 'max', agent_id: MAX_AGENT, session_id: SESSION };
const HELPER = { agent_type: 'lex-web', agent_id: 'agenthelper01', session_id: SESSION }; // a helper of max names its own type
const MAIN = { session_id: SESSION }; // the main session: no agent_id
const OTHER_SESSION = 'session-87654321';
const DENY_LINE = `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: CLAUDE_START_REASON } })}\n`;

const STARTS = [
  'claude', 'claude -p "do x"', 'claude --resume abc', 'claude update', 'claude mcp list', 'claude.exe -p x', '/usr/local/bin/claude -p x',
  'npx @anthropic-ai/claude-code -p x', 'npx -y @anthropic-ai/claude-code@2 -p x', 'bunx @anthropic-ai/claude-code', 'pnpx @anthropic-ai/claude-code -p x',
  ...['start r1', 'resume r1', 'rerun r1', 'schedule r1', 'tell r1 hi', 'takeover r1'].map((verb) => `${LONG_RUN} ${verb}`),
  '~/.claude/tools/long-run/long-run.mjs start r1', 'node --env-file=.env ~/.claude/tools/long-run/long-run.mjs start r1',
  'bash -c "claude -p x"', "sh -c 'claude -p x'", 'eval claude -p x', 'echo $(claude -p x)', 'cd x && claude -p y', 'nohup claude -p x &',
  'timeout 60 claude -p x', 'env A=1 claude -p x', 'sudo claude', 'xargs claude -p',
];
const NOT_STARTS = [
  'claude --version', 'claude -v', 'claude -h', 'claude --help', 'echo claude', 'ls ~/.claude', 'git commit -m "claude -p x"',
  `${LONG_RUN} status r1`, `${LONG_RUN} list`, 'node tests/e2e/run.mjs', 'cat claude.md', 'grep -r claude docs', 'npx prettier --write x',
];

test('lineStartsClaude: claude, its npx/bunx/pnpx package and a long-run start, also behind wrappers, shells, eval and $(...)', () => {
  for (const command of STARTS) assert.equal(lineStartsClaude(command), true, command);
});

test('lineStartsClaude: a help or version flag, a mention of claude and a long-run read are no start', () => {
  for (const command of NOT_STARTS) assert.equal(lineStartsClaude(command), false, command);
});

test('lineStartsClaude: an upper-case CLAUDE starts claude on macOS and Windows only (their file systems find it)', () => {
  assert.equal(lineStartsClaude('CLAUDE -p x'), process.platform !== 'linux');
});

test('claudeStartDeny: max itself is denied every start, with no store read needed', () => {
  const env = isolatedEnv(); // no store folder at all
  for (const command of STARTS) assert.equal(claudeStartDeny(command, MAX, env), DENY_LINE, command);
});

test('claudeStartDeny: a subagent is denied while a max runs in any session, and when the record cannot be read', () => {
  const running = isolatedEnv();
  writeRecord(running.HOME, OTHER_SESSION, runningMax(Date.now()));
  assert.equal(claudeStartDeny('claude -p x', HELPER, running), DENY_LINE);
  const unreadable = isolatedEnv();
  mkdirSync(join(unreadable.HOME, '.claude', 'state', 'main-agents'), { recursive: true, mode: 0o700 });
  writeFileSync(join(unreadable.HOME, '.claude', 'state', 'main-agents', `${OTHER_SESSION}.json`), 'not json', { mode: 0o600 });
  assert.equal(claudeStartDeny('claude -p x', HELPER, unreadable), DENY_LINE);
});

test('claudeStartDeny: a subagent with no max running (none, or stopped) and the main session are not denied', () => {
  const none = isolatedEnv();
  assert.equal(claudeStartDeny('claude -p x', HELPER, none), '');
  const stopped = isolatedEnv();
  writeRecord(stopped.HOME, OTHER_SESSION, stoppedMax());
  assert.equal(claudeStartDeny('claude -p x', HELPER, stopped), '');
  const running = isolatedEnv();
  writeRecord(running.HOME, OTHER_SESSION, runningMax(Date.now()));
  assert.equal(claudeStartDeny('claude -p x', MAIN, running), '');
});

test('claudeStartDeny: a line that starts no session is never denied, not even for max', () => {
  for (const command of NOT_STARTS) assert.equal(claudeStartDeny(command, MAX, isolatedEnv()), '', command);
});

test('claudeStartDeny logs one guard-log line with the claude-start outcome and the fixed reason', () => {
  const env = isolatedEnv();
  claudeStartDeny('claude -p x', { ...MAX, cwd: '/work/proj' }, env);
  const lines = readFileSync(env.CLAUDE_GUARD_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].decision, 'deny');
  assert.equal(lines[0].outcome, CLAUDE_START_OUTCOME);
  assert.equal(lines[0].reason, CLAUDE_START_REASON);
  assert.equal(CLAUDE_START_OUTCOME, 'claude-start');
});

test('hook: max starting claude or a long-run is denied with the fixed reason and no dialog, also under CLAUDE_GUARD_ASK=allow', () => {
  for (const command of ['claude -p "ship it"', `${LONG_RUN} start r1`, 'npx @anthropic-ai/claude-code -p x']) {
    const dialog = fakeDialog('allow', { CLAUDE_GUARD_ASK: 'allow' });
    assert.deepEqual(hookAnswer(runGuard(command, dialog.env, MAX)), { decision: 'deny', reason: CLAUDE_START_REASON }, command);
    assert.equal(dialog.opened(), false, command);
    assert.equal(dialog.log().find((line) => line.hook === 'pre-bash-guard').outcome, CLAUDE_START_OUTCOME, command);
  }
});

test('hook: a helper of max is denied a claude start while the max runs; the main session is not', () => {
  const helper = fakeDialog('allow');
  writeRecord(helper.env.HOME, OTHER_SESSION, runningMax(Date.now()));
  assert.deepEqual(hookAnswer(runGuard('claude -p x', helper.env, HELPER)), { decision: 'deny', reason: CLAUDE_START_REASON });
  const main = fakeDialog('deny');
  writeRecord(main.env.HOME, OTHER_SESSION, runningMax(Date.now()));
  assert.deepEqual(hookAnswer(runGuard('claude -p x', main.env, MAIN)), { decision: 'allow', reason: '' });
  assert.equal(main.opened(), false);
});

test('hook: max may still ask claude for its version or help', () => {
  for (const command of ['claude --version', 'claude --help']) {
    assert.deepEqual(hookAnswer(runGuard(command, isolatedEnv(), MAX)), { decision: 'allow', reason: '' }, command);
  }
});
