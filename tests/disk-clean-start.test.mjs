// Tests for home/hooks/disk-clean-start.mjs: the clean-up starts at most once per 24 h, only for a startup of the main session,
// the stamp is written before the start, two starts at once run one clean-up, a stamp or log that is a link or a FIFO is not followed or waited
// on, the child gets no secrets, and the hook exits at once while the clean-up is still running. Two tests start the real tool through the
// hook: a running session of another config dir keeps its scratchpad. Every hook run gets fixture folders only (runHook).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnv, openLogFile, startIfDue } from '../home/hooks/disk-clean-start.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/disk-clean-start.mjs', import.meta.url));
const HOUR_MS = 60 * 60 * 1000;
const posix = { skip: process.platform === 'win32' && 'needs FIFOs and symlinks' };
const STARTUP_RACERS = 16; // enough that some of them read the stamp before the first one has written it: the check under the lock is what stops them
const RACE_ROUNDS = Number(process.env.DISK_CLEAN_RACE_ROUNDS ?? 10);
const SESSION = '11111111-2222-4333-8444-555555555555';
const OTHER_CONFIG_SESSION = '22222222-3333-4444-8555-666666666666';
const DAY_MS = 24 * HOUR_MS;
const SUMMARY_LINE = /^disk-clean: \d+ items/m; // the first line of the report, printed when the run has ended

function setup() {
  const home = makeTempDir('dcs-home-');
  const started = [];
  const deps = { stampPath: join(home, 'state', 'disk-clean.stamp'), logPath: join(home, 'logs', 'disk-clean.log'), tool: '/the/tool.mjs', nowMs: Date.now(), start: (args) => started.push(args) };
  return { home, started, deps };
}
const startup = { hook_event_name: 'SessionStart', source: 'startup', session_id: SESSION };

test('with no stamp it starts disk-clean --apply for this session and writes the stamp first', () => {
  const { started, deps } = setup();
  assert.equal(startIfDue(startup, { ...deps, start: (args) => { assert.ok(existsSync(deps.stampPath), 'the stamp exists before the start'); started.push(args); } }), 'started');
  assert.deepEqual(started, [['/the/tool.mjs', '--apply', '--session', SESSION]]);
});

test('a stamp younger than 24 h means not due; one older than 24 h starts it again', () => {
  const { started, deps } = setup();
  startIfDue(startup, deps);
  assert.equal(startIfDue(startup, deps), 'not-due');
  const old = new Date(deps.nowMs - 25 * HOUR_MS);
  utimesSync(deps.stampPath, old, old);
  assert.equal(startIfDue(startup, deps), 'started');
  assert.equal(started.length, 2);
});

test('a stamp 23 hours old is not due', () => {
  const { started, deps } = setup();
  startIfDue(startup, deps);
  const recent = new Date(deps.nowMs - 23 * HOUR_MS);
  utimesSync(deps.stampPath, recent, recent);
  assert.equal(startIfDue(startup, deps), 'not-due');
  assert.equal(started.length, 1);
});

test('resume, compact, a subagent and garbage input start nothing', () => {
  const { started, deps } = setup();
  for (const input of [{ ...startup, source: 'resume' }, { ...startup, source: 'compact' }, { ...startup, agent_id: 'a1' }, null, 'text', {}]) assert.equal(startIfDue(input, deps), 'skipped');
  assert.deepEqual(started, []);
  assert.equal(existsSync(deps.stampPath), false, 'a skipped call does not use up the 24 h');
});

test('an unsafe session id is not passed on', () => {
  const { started, deps } = setup();
  startIfDue({ ...startup, session_id: '../../etc; rm' }, deps);
  assert.deepEqual(started, [['/the/tool.mjs', '--apply']]);
});

/** A fake clean-up tool: records its own start, waits for a `release` file, then records that it finished and what it was given. */
function fakeTool(home, extra = '') {
  const tool = join(home, 'fake-tool.mjs');
  writeFileSync(tool, `import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
writeFileSync(${JSON.stringify(join(home, 'started'))}, JSON.stringify({ pid: process.pid, env: process.env, args: process.argv.slice(2), pgid: process.platform === 'win32' ? '' : spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim() }));
while (!existsSync(${JSON.stringify(join(home, 'release'))})) await new Promise((resolve) => setTimeout(resolve, 20));
${extra}
writeFileSync(${JSON.stringify(join(home, 'cleaned'))}, 'done');
`);
  return tool;
}

/**
 * The folders a hook run gets in place of the real ones, all inside the fixture home: the temp folder and, inside it (a scratchpad root
 * must lie under the temp folder), the scratchpad root. Without them the child would get the runner's TMPDIR and the real
 * /private/tmp/claude-<uid>, and a test that starts the real tool would clean real folders.
 */
const fixtureFolders = (home) => ({ tmp: join(home, 'tmp'), claudeTmp: join(home, 'tmp', 'claude-tmp') });

/** Runs the hook as Claude Code does, with every folder the clean-up reads or cleans set to a fixture (`env` can replace any of them). */
const runHook = (home, env) => {
  const { tmp, claudeTmp } = fixtureFolders(home);
  mkdirSync(claudeTmp, { recursive: true });
  const fixtures = { HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp, DISK_FREE_CLAUDE_TMP: claudeTmp, CLAUDE_CONFIG_DIR: '' };
  const hook = spawn(process.execPath, [HOOK], { env: { ...process.env, ...fixtures, ...env }, stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  hook.stderr.on('data', (chunk) => { stderr += chunk; });
  hook.stdin.end(JSON.stringify(startup));
  return new Promise((resolve) => hook.on('close', (code) => resolve({ code, stderr })));
};
const waitFor = async (path) => {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  return existsSync(path);
};

test('the hook exits while the clean-up it started is still running (it waits for a release file); the clean-up gets the session and finishes later', async () => {
  const home = makeTempDir('dcs-run-');
  const { code } = await runHook(home, { DISK_CLEAN_TOOL: fakeTool(home) });
  assert.equal(code, 0);
  assert.equal(await waitFor(join(home, 'started')), true);
  assert.equal(existsSync(join(home, 'cleaned')), false, 'the clean-up is still waiting when the hook has exited');
  writeFileSync(join(home, 'release'), '');
  assert.equal(await waitFor(join(home, 'cleaned')), true);
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'started'), 'utf8')).args, ['--apply', '--session', SESSION]);
});

test('the clean-up runs in its own process group (detached) and gets no tokens or keys, only what it needs to find its folders', posix, async () => {
  const home = makeTempDir('dcs-env-');
  writeFileSync(join(home, 'release'), '');
  const secrets = { CLAUDE_CODE_OAUTH_TOKEN: 'a', ANTHROPIC_API_KEY: 'b', GITHUB_TOKEN: 'c', AWS_SECRET_ACCESS_KEY: 'd', MY_PASSWORD: 'e' };
  await runHook(home, { DISK_CLEAN_TOOL: fakeTool(home), ...secrets });
  assert.equal(await waitFor(join(home, 'cleaned')), true);
  const { pid, pgid, env } = JSON.parse(readFileSync(join(home, 'started'), 'utf8'));
  assert.equal(String(pid), pgid, 'a detached child leads its own process group');
  for (const name of Object.keys(secrets)) assert.equal(env[name], undefined, name);
  assert.equal(env.HOME, home);
  const { tmp, claudeTmp } = fixtureFolders(home);
  assert.deepEqual([env.TMPDIR, env.TMP, env.TEMP, env.DISK_FREE_CLAUDE_TMP], [tmp, tmp, tmp, claudeTmp], 'a hook test never hands the child a real folder');
});

test('cleanEnv keeps only the allowed names; CLAUDE_CONFIG_DIR is one of them', () => {
  assert.deepEqual(cleanEnv({ HOME: '/h', TMPDIR: '/t', ANTHROPIC_API_KEY: 'x', PATH: '/bin' }), { HOME: '/h', TMPDIR: '/t' });
  assert.deepEqual(cleanEnv({ HOME: '/h', CLAUDE_CONFIG_DIR: '/h/.claude-plain', CLAUDE_CODE_OAUTH_TOKEN: 'x' }), { HOME: '/h', CLAUDE_CONFIG_DIR: '/h/.claude-plain' });
});

/**
 * A fixture home where a session of a second config dir (~/.claude-plain) is running: registered with a live pid and writing its transcript
 * only there, its scratchpad in the shared root idle for 4 days. The default config dir (~/.claude) has its folders and knows nothing of it.
 */
function otherConfigDirWorld() {
  const home = makeTempDir('dcs-other-');
  const configDir = join(home, '.claude-plain');
  const scratchpad = join(fixtureFolders(home).claudeTmp, '-proj', OTHER_CONFIG_SESSION);
  for (const dir of [join(home, '.claude', 'projects'), join(home, '.claude', 'sessions'), join(configDir, 'projects', '-proj'), join(configDir, 'sessions'), scratchpad]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(configDir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: OTHER_CONFIG_SESSION }));
  writeFileSync(join(configDir, 'projects', '-proj', `${OTHER_CONFIG_SESSION}.jsonl`), '{}\n');
  writeFileSync(join(scratchpad, 'work.txt'), 'not saved anywhere else');
  const idle = new Date(Date.now() - 4 * DAY_MS);
  for (const path of [join(scratchpad, 'work.txt'), scratchpad]) utimesSync(path, idle, idle); // deepest first: writing a file updates its folder's time
  return { home, configDir, work: join(scratchpad, 'work.txt') };
}

/** The text of the clean-up log once it holds the report's first line (the run has ended); '' when that never happens. */
async function finishedLog(home) {
  const log = join(home, '.claude', 'logs', 'disk-clean.log');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const text = existsSync(log) ? readFileSync(log, 'utf8') : ''; // the log exists, empty, before the child writes to it
    if (SUMMARY_LINE.test(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return '';
}

test('the real clean-up, started by the hook in a session of another config dir, gets CLAUDE_CONFIG_DIR and skips the session rules: the scratchpad stays', async () => {
  const { home, configDir, work } = otherConfigDirWorld();
  assert.equal((await runHook(home, { CLAUDE_CONFIG_DIR: configDir })).code, 0);
  const log = await finishedLog(home);
  assert.equal(log.match(/^ {2}SKIPPED: /gm)?.length, 2, log);
  assert.match(log, /found, 0 removed/);
  assert.equal(existsSync(work), true);
});

test('the real clean-up, started by the hook in a default session, keeps the scratchpad of a running session of another config dir and says so', async () => {
  const { home, work } = otherConfigDirWorld();
  assert.equal((await runHook(home)).code, 0);
  const log = await finishedLog(home);
  assert.match(log, /found, 0 removed/);
  assert.match(log, /1 session folder\(s\) kept: no transcript in /);
  assert.equal(existsSync(work), true);
});

test('a state folder that cannot be made does not fail the hook: exit 0 and a line on stderr', async () => {
  const home = makeTempDir('dcs-bad-');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'state'), 'a file where the folder should be');
  const { code, stderr } = await runHook(home, { DISK_CLEAN_TOOL: fakeTool(home) });
  assert.equal(code, 0);
  assert.match(stderr, /disk-clean-start:/);
  assert.equal(existsSync(join(home, 'started')), false, 'no real clean-up and no fake one was started');
});

test('an empty or relative HOME skips the run: exit 0, a line on stderr, no state folder in the working directory, nothing started', posix, async () => {
  for (const emptyHome of ['', 'relative-home']) {
    const home = makeTempDir('dcs-nohome-');
    const { code, stderr } = await runHook(home, { HOME: emptyHome, USERPROFILE: emptyHome, DISK_CLEAN_TOOL: fakeTool(home) });
    assert.equal(code, 0);
    assert.match(stderr, /skipped: the home folder/);
    assert.equal(existsSync(join(home, 'started')), false);
    assert.equal(existsSync(join(process.cwd(), '.claude', 'state')) || existsSync(join(process.cwd(), 'relative-home')), false, 'nothing was created relative to the working directory');
  }
});

test('a stamp that is a symlink is replaced, never written through; one that is a FIFO does not block the hook', posix, () => {
  const { started, deps } = setup();
  mkdirSync(join(deps.stampPath, '..'), { recursive: true });
  const victim = join(deps.stampPath, '..', 'victim.txt');
  writeFileSync(victim, 'precious');
  symlinkSync(victim, deps.stampPath);
  assert.equal(startIfDue(startup, deps), 'started');
  assert.equal(readFileSync(victim, 'utf8'), 'precious');
  assert.ok(statSync(deps.stampPath).isFile());
  const fifo = `${deps.stampPath}-fifo`;
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  assert.equal(startIfDue(startup, { ...deps, stampPath: fifo }), 'started');
  assert.ok(statSync(fifo).isFile(), 'the FIFO was replaced by a plain stamp');
  assert.equal(started.length, 2);
});

test('a lock file that is a FIFO or left by a crashed hook: a young one means not due, one older than a minute is replaced', posix, () => {
  const { started, deps } = setup();
  mkdirSync(join(deps.stampPath, '..'), { recursive: true });
  const lock = `${deps.stampPath}.lock`;
  assert.equal(spawnSync('mkfifo', [lock]).status, 0);
  assert.equal(startIfDue(startup, deps), 'not-due');
  const stale = new Date(deps.nowMs - 2 * 60 * 1000);
  utimesSync(lock, stale, stale);
  assert.equal(startIfDue(startup, deps), 'started');
  assert.equal(started.length, 1);
  assert.equal(existsSync(lock), false, 'the lock is released');
});

test('the log: a symlink or a FIFO is not opened (nothing written through, no waiting); a plain file is cut to empty', posix, () => {
  const home = makeTempDir('dcs-log-');
  const victim = join(home, 'victim.txt');
  writeFileSync(victim, 'precious');
  symlinkSync(victim, join(home, 'link.log'));
  assert.equal(openLogFile(join(home, 'link.log')), null);
  assert.equal(readFileSync(victim, 'utf8'), 'precious');
  assert.equal(spawnSync('mkfifo', [join(home, 'fifo.log')]).status, 0);
  assert.equal(openLogFile(join(home, 'fifo.log')), null);
  writeFileSync(join(home, 'plain.log'), 'old output');
  const fd = openLogFile(join(home, 'plain.log'));
  assert.equal(typeof fd, 'number');
  assert.equal(statSync(join(home, 'plain.log')).size, 0);
  const reader = openSync(join(home, 'fifo.log'), constants.O_RDONLY | constants.O_NONBLOCK); // a FIFO with a reader opens for writing: only the file type check refuses it
  try {
    assert.equal(openLogFile(join(home, 'fifo.log')), null);
  } finally {
    closeSync(reader);
  }
});

/** Starts STARTUP_RACERS processes that all call startIfDue at the same instant on one stamp; returns how many started a clean-up. */
async function racedStarts(home, stampPath) {
  const barrier = Date.now() + 600;
  const script = `import { appendFileSync } from 'node:fs';
import { startIfDue } from ${JSON.stringify(new URL('../home/hooks/disk-clean-start.mjs', import.meta.url).href)};
while (Date.now() < ${barrier}) {}
startIfDue({ source: 'startup', session_id: 'x' }, { stampPath: ${JSON.stringify(stampPath)}, logPath: ${JSON.stringify(join(home, 'log'))}, tool: 't', nowMs: Date.now(), start: () => appendFileSync(${JSON.stringify(join(home, 'starts'))}, 'x') });`;
  const racers = Array.from({ length: STARTUP_RACERS }, () => new Promise((resolve) => spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' }).on('close', resolve)));
  await Promise.all(racers);
  return existsSync(join(home, 'starts')) ? readFileSync(join(home, 'starts'), 'utf8').length : 0;
}

test(`${STARTUP_RACERS} sessions starting at the same instant run one clean-up (${RACE_ROUNDS} rounds, half of them with a stale stamp)`, async () => {
  for (let round = 0; round < RACE_ROUNDS; round += 1) {
    const home = makeTempDir('dcs-race-');
    const stampPath = join(home, 'state', 'disk-clean.stamp');
    if (round % 2 === 1) {
      mkdirSync(join(home, 'state'));
      writeFileSync(stampPath, 'old');
      const stale = new Date(Date.now() - 25 * HOUR_MS);
      utimesSync(stampPath, stale, stale);
    }
    assert.equal(await racedStarts(home, stampPath), 1, `round ${round}`);
  }
});
