// Tests for the output trim of the Bash guard (lib/output-trim.mjs, audit item I10): a plain foreground test or build runner call is
// rewritten through PreToolUse `updatedInput` so it prints the full log's path first, then only the last TRIM_LINES lines, and exits with the
// runner's own code. The end-to-end case runs the rewritten command with bash against a fake `pytest` on PATH in a temp folder.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isTrimmedRunner, TRIM_ENV, TRIM_LINES, trimmedCommand } from '../home/hooks/lib/output-trim.mjs';
import { hookEnv } from './hook-env.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';

const GUARD = fileURLToPath(new URL('../home/hooks/pre-bash-guard.mjs', import.meta.url));
const PROJECT = resolve('/work/proj');
const FAKE_LINES = 400;
const FAKE_EXIT = 3;
const LOG_LINE = /^\[guard: full log: (.+); its last 150 lines follow when the run ends\]$/;

const TRIM_ON = { [TRIM_ENV]: '1' };

/** The guard hook's stdout for one Bash call, with the trim switched on unless extraEnv says otherwise. */
function hookAnswer(toolInput, extraEnv = TRIM_ON, toolName = 'Bash') {
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

test('through the hook: the rewrite keeps every other field; background, Monitor, PowerShell and the switch off get none', () => {
  const toolInput = { command: 'pytest -q', description: 'run the tests', timeout: 60000 };
  const { hookSpecificOutput } = JSON.parse(hookAnswer(toolInput));
  assert.equal(hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(hookSpecificOutput.permissionDecision, undefined, 'no decision: the normal permission flow still applies');
  assert.deepEqual(hookSpecificOutput.updatedInput, { ...toolInput, command: trimmedCommand('pytest -q') });
  assert.equal(hookAnswer({ ...toolInput, run_in_background: true }), '');
  assert.equal(hookAnswer(toolInput, TRIM_ON, 'Monitor'), '');
  assert.equal(hookAnswer(toolInput, TRIM_ON, 'PowerShell'), '');
  assert.equal(hookAnswer(toolInput, { [TRIM_ENV]: '0' }), '', 'off unless switched on');
  assert.equal(hookAnswer({ command: 'git status --short' }), '', 'not a runner: no output, as before');
});

test('a fake runner that prints 400 lines and exits 3: the rewritten command prints the log path, then the last 150 lines, and exits 3', { skip: process.platform === 'win32' && 'needs a POSIX bash with mktemp and tail' }, () => {
  const bin = makeTempDir('trim-bin-');
  const runner = join(bin, 'pytest');
  writeFileSync(runner, `#!/bin/sh\ni=1\nwhile [ $i -le ${FAKE_LINES} ]; do echo "line $i"; i=$((i + 1)); done\nexit ${FAKE_EXIT}\n`);
  chmodSync(runner, 0o755);
  const { hookSpecificOutput } = JSON.parse(hookAnswer({ command: 'pytest -q' }));
  const env = cleanEnv({ PATH: `${bin}${delimiter}${process.env.PATH}` });
  const run = spawnSync('bash', ['-c', hookSpecificOutput.updatedInput.command], { cwd: makeTempDir('trim-run-'), encoding: 'utf8', env });
  assert.equal(run.status, FAKE_EXIT, run.stderr);
  const lines = run.stdout.trimEnd().split('\n');
  assert.equal(lines.length, TRIM_LINES + 1, 'the log line, then the last lines');
  const logPath = LOG_LINE.exec(lines[0])?.[1];
  assert.ok(logPath !== undefined && existsSync(logPath), lines[0]);
  assert.equal(lines[1], `line ${FAKE_LINES - TRIM_LINES + 1}`);
  assert.equal(lines[TRIM_LINES], `line ${FAKE_LINES}`);
  assert.equal(readFileSync(logPath, 'utf8').trimEnd().split('\n').length, FAKE_LINES, 'the log holds the whole output');
});
