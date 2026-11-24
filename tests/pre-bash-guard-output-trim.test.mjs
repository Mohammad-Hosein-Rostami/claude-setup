// Tests for the output trim of the Bash guard (lib/output-trim.mjs, audit item I10): a plain foreground test or build runner call is
// rewritten through PreToolUse `updatedInput` so it prints only the last TRIM_LINES lines and the full log's path, and exits with the
// runner's own code. The end-to-end case runs the rewritten command with bash against a fake `pytest` on PATH in a temp folder.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isTrimmedRunner, NO_TRIM_ENV, TRIM_LINES, trimmedCommand } from '../home/hooks/lib/output-trim.mjs';
import { hookEnv } from './hook-env.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const GUARD = fileURLToPath(new URL('../home/hooks/pre-bash-guard.mjs', import.meta.url));
const PROJECT = resolve('/work/proj');
const FAKE_LINES = 400;
const FAKE_EXIT = 3;
const LOG_LINE = /^\[guard: the last 150 lines are shown; full log: (.+)\]$/;

/** The guard hook's stdout for one Bash call. */
function hookAnswer(toolInput, extraEnv = {}, toolName = 'Bash') {
  const input = JSON.stringify({ cwd: PROJECT, session_id: 'sess-1', tool_name: toolName, tool_input: toolInput });
  const { status, stdout, stderr } = spawnSync(process.execPath, [GUARD], { input, encoding: 'utf8', env: hookEnv({ CLAUDE_PROJECT_DIR: PROJECT, ...extraEnv }) });
  assert.equal(status, 0, stderr);
  return stdout;
}

test('runner calls are rewritten; anything with shell syntax, other commands and lookalikes are not', () => {
  const runners = ['node --test tests/x.test.mjs', 'npm test', 'pnpm test -- --watch=false', 'yarn run build', 'CI=1 pnpm run build', 'vitest run',
    'jest', 'pytest -q tests', 'go test ./...', 'cargo test'];
  const others = ['node --test tests/x.test.mjs | tail', 'pnpm test > out.log', 'npm test && git status', 'pytest; echo done', 'go test $(go list ./...)',
    'cargo test &', 'node script.js', 'npm install', 'pnpm run lint', 'npm testing', 'go vet ./...', 'echo pytest', 'CI=1', 'jest\npytest'];
  for (const command of runners) assert.equal(isTrimmedRunner(command), true, command);
  for (const command of others) assert.equal(isTrimmedRunner(command), false, command);
});

test('through the hook: the rewrite keeps every other field; background, Monitor, PowerShell and CLAUDE_GUARD_NO_TRIM=1 get none', () => {
  const toolInput = { command: 'pytest -q', description: 'run the tests', timeout: 60000 };
  const { hookSpecificOutput } = JSON.parse(hookAnswer(toolInput));
  assert.equal(hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(hookSpecificOutput.permissionDecision, undefined, 'no decision: the normal permission flow still applies');
  assert.deepEqual(hookSpecificOutput.updatedInput, { ...toolInput, command: trimmedCommand('pytest -q') });
  assert.equal(hookAnswer({ ...toolInput, run_in_background: true }), '');
  assert.equal(hookAnswer(toolInput, {}, 'Monitor'), '');
  assert.equal(hookAnswer(toolInput, {}, 'PowerShell'), '');
  assert.equal(hookAnswer(toolInput, { [NO_TRIM_ENV]: '1' }), '');
  assert.equal(hookAnswer({ command: 'git status --short' }), '', 'not a runner: no output, as before');
});

test('a fake runner that prints 400 lines and exits 3: the rewritten command prints the last 150 lines and the log path, and exits 3', { skip: process.platform === 'win32' && 'needs a POSIX bash with mktemp and tail' }, () => {
  const bin = makeTempDir('trim-bin-');
  const runner = join(bin, 'pytest');
  writeFileSync(runner, `#!/bin/sh\ni=1\nwhile [ $i -le ${FAKE_LINES} ]; do echo "line $i"; i=$((i + 1)); done\nexit ${FAKE_EXIT}\n`);
  chmodSync(runner, 0o755);
  const { hookSpecificOutput } = JSON.parse(hookAnswer({ command: 'pytest -q' }));
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` };
  const run = spawnSync('bash', ['-c', hookSpecificOutput.updatedInput.command], { cwd: makeTempDir('trim-run-'), encoding: 'utf8', env });
  assert.equal(run.status, FAKE_EXIT, run.stderr);
  const lines = run.stdout.trimEnd().split('\n');
  assert.equal(lines.length, TRIM_LINES + 1, 'the last lines, then the log line');
  assert.equal(lines[0], `line ${FAKE_LINES - TRIM_LINES + 1}`);
  assert.equal(lines[TRIM_LINES - 1], `line ${FAKE_LINES}`);
  const logPath = LOG_LINE.exec(lines[TRIM_LINES])?.[1];
  assert.ok(logPath !== undefined && existsSync(logPath), lines[TRIM_LINES]);
  assert.equal(readFileSync(logPath, 'utf8').trimEnd().split('\n').length, FAKE_LINES, 'the log holds the whole output');
});
