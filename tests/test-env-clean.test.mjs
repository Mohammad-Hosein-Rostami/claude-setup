// Drift guard for the test environment: the suite must give the same result whatever the session that runs it holds.
// A Claude Code session exports the owner's switches (CLAUDE_GUARD_ASK=allow turns a guard ask into an allow) and a TMPDIR deep in
// its own scratchpad (180+ chars, inside claude-<uid>, which the guard frees and the 160-char shown paths cut). These cases prove
// cleanEnv/hookEnv drop the switches, that no test spawns with the raw session env, that makeTempDir leaves a long session TMPDIR,
// and that a long-run child's desktop note reaches the quiet stand-in, never the real osascript / notify-send.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { desktopCommand, readNotifyConfig } from '../home/tools/long-run/lib/notify.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanEnv } from './clean-env.mjs';
import { hookEnv } from './hook-env.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const TESTS = resolve('tests');
const GUARD = resolve('home/hooks/pre-bash-guard.mjs');
const LONG_RUN = resolve('home/tools/long-run/long-run.mjs');
const QUIET_TOOLS_LOG_ENV = 'CS_TEST_QUIET_TOOLS_LOG'; // tests/clean-env.mjs; written out so this file loads where that export is missing
const PROJECT = resolve('/work/proj');
const OWNER_SWITCHES = { CLAUDE_GUARD_ASK: 'allow', CLAUDE_GUARD_TRIM: '0', CLAUDE_POST_EDIT_TRUST_FORMAT: '1', CLAUDE_SOME_NEW_SWITCH: 'on', CLAUDECODE: '1' };
const ASKED_COMMAND = 'rm -rf ~/x'; // destructive, not outward: CLAUDE_GUARD_ASK=allow would turn its ask into a silent allow
const SHOWN_PATH_CUT = 160; // doctor's shownFolder and the writer gate's quotedLine cut a path at 160 chars
const CLAUDE_TREE_FOLDER = /^claude-\d+$/; // Claude Code's per-user temp tree, which holds every session's scratchpad
const SESSION_FOLDERS = ['claude-501', '-Users-someone-Desktop-a-project-folder-with-a-rather-long-name', '195936cb-dd2f-42b3-b605-1ab5fad96518',
  'scratchpad', 'tw-hermetic', 'tmp-a']; // the shape of a real session's TMPDIR below its temp root

/** Runs `run` with `values` in process.env (as a session exports them), then puts the old values back. */
function withSessionEnv(values, run) {
  const old = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  try {
    return run();
  } finally {
    for (const [name, value] of Object.entries(old)) if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test('cleanEnv and hookEnv drop every CLAUDE_* switch and CLAUDECODE, keep PATH, and let extra win', () => {
  withSessionEnv(OWNER_SWITCHES, () => {
    for (const env of [cleanEnv(), hookEnv()]) {
      for (const name of Object.keys(OWNER_SWITCHES)) assert.equal(name in env, false, name);
      assert.equal(env.PATH, process.env.PATH);
    }
    const extra = cleanEnv({ PATH: 'extra-path', CLAUDE_GUARD_ASK: 'extra-ask' });
    assert.equal(extra.PATH, 'extra-path');
    assert.equal(extra.CLAUDE_GUARD_ASK, 'extra-ask');
  });
});

test('a guard spawned with hookEnv still asks natively while the session exports CLAUDE_GUARD_ASK=allow', () => {
  const run = withSessionEnv({ CLAUDE_GUARD_ASK: 'allow' }, () => spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ cwd: PROJECT, session_id: 's1', tool_input: { command: ASKED_COMMAND } }),
    encoding: 'utf8',
    env: hookEnv({ CLAUDE_PROJECT_DIR: PROJECT }),
  }));
  assert.equal(run.status, 0, run.stderr);
  assert.notEqual(run.stdout, '', 'the switch reached the guard: it allowed without asking');
  const output = JSON.parse(run.stdout).hookSpecificOutput;
  assert.equal(output.permissionDecision, 'ask');
  assert.match(output.permissionDecisionReason, /^DESTRUCTIVE: /);
});

// Each pattern copies the whole session env into a child's env. This file is not scanned: it holds the allowed lines as data.
const THIS_FILE = basename(fileURLToPath(import.meta.url));
const RAW_ENV_COPIES = [/\.\.\.process\.env(?![\w.[])/, /Object\.entries\(process\.env\)/, /\benv: process\.env\s*(?:[,})]|$)/];
const RAW_ENV_ALLOWED = [
  { file: 'clean-env.mjs', line: 'Object.entries(process.env).filter', reason: 'the helper itself: it copies the env and drops CLAUDE_*' },
  { file: 'disk-clean-start.test.mjs', line: 'JSON.stringify({ pid: process.pid, env: process.env,', reason: 'a fake child writes out the env it got; it spawns nothing' },
];

test('no test file or helper spawns with the raw session env; each allowed line is still there', () => {
  const found = [];
  for (const file of readdirSync(TESTS).filter((name) => name.endsWith('.mjs') && name !== THIS_FILE)) {
    readFileSync(join(TESTS, file), 'utf8').split('\n').forEach((line, index) => {
      if (RAW_ENV_COPIES.some((pattern) => pattern.test(line))) found.push({ file, line, at: `${file}:${index + 1}` });
    });
  }
  const isAllowed = (hit) => RAW_ENV_ALLOWED.some((allowed) => allowed.file === hit.file && hit.line.includes(allowed.line));
  assert.deepEqual(found.filter((hit) => !isAllowed(hit)).map((hit) => hit.at), [], 'use cleanEnv(extra) from tests/clean-env.mjs');
  for (const allowed of RAW_ENV_ALLOWED) {
    assert.ok(found.some((hit) => hit.file === allowed.file && hit.line.includes(allowed.line)), `stale allowlist entry: ${allowed.file}`);
  }
});

test('makeTempDir under a long TMPDIR inside a claude-<uid> tree makes a short folder outside that tree', () => {
  const longTemp = join(makeTempDir('long-tmpdir-'), ...SESSION_FOLDERS);
  mkdirSync(longTemp, { recursive: true });
  assert.ok(longTemp.length > SHOWN_PATH_CUT, `the fixture is as long as a session TMPDIR: ${longTemp.length}`);
  // A child process: tmpdir() and the helper's root are read when the helper loads, so the parent's own TMPDIR stays out of it.
  const helper = pathToFileURL(join(TESTS, 'temp-dir-helpers.mjs')).href;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const { makeTempDir } = await import(${JSON.stringify(helper)}); process.stdout.write(makeTempDir('long-tmp-probe-'));`], {
    encoding: 'utf8',
    env: cleanEnv({ TMPDIR: longTemp, TEMP: longTemp, TMP: longTemp }),
  });
  assert.equal(run.status, 0, run.stderr);
  const folder = run.stdout;
  assert.match(basename(folder), /^cs-test-long-tmp-probe-/);
  assert.equal(folder.startsWith(longTemp), false, folder);
  assert.deepEqual(folder.split(sep).filter((part) => CLAUDE_TREE_FOLDER.test(part)), [], folder);
  assert.ok(folder.length < SHOWN_PATH_CUT, `${folder.length} chars: ${folder}`);
});

// Windows has no quiet stand-ins (a script cannot shadow powershell.exe), so there is nothing to prove there.
test('a long-run child under cleanEnv sends its desktop note to the quiet stand-in, with the argv of the real command', { skip: process.platform === 'win32' }, () => {
  const home = makeTempDir('quiet-notify-home-');
  const log = join(home, 'quiet-tools.log');
  const env = cleanEnv({ HOME: home, USERPROFILE: home, [QUIET_TOOLS_LOG_ENV]: log });
  assert.equal(readNotifyConfig(env), null, 'no ntfy topic in this HOME, so no phone push');
  const run = spawnSync(process.execPath, [LONG_RUN, 'notify', 'test'], { encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /sent a test note/);
  const real = desktopCommand(process.platform, 'long-run', 'test note');
  assert.equal(existsSync(log), true, `the note went past the quiet ${real.command}: a real note was shown`);
  assert.deepEqual(readFileSync(log, 'utf8').split('\n').filter(Boolean), [[real.command, ...real.args].join(' ')]);
});
