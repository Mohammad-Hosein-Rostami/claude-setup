// Tests of the timeout knobs (home/tools/long-run/lib/env-ms.mjs msFromEnv and the three waits it sets: driver.mjs CONTROL_POLL_MS,
// process-tree.mjs SWEEP_GRACE_MS, scripts/doctor-accounts.mjs KEYCHAIN_PROBE_TIMEOUT_MS): only a positive whole number of
// milliseconds is taken, anything else keeps the production value. A knob is read when its module loads, so each case imports the
// module in a child node process whose environment it sets; the child runs in a temporary HOME, USERPROFILE and TMPDIR.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cleanEnv } from './clean-env.mjs';
import { POSIX_ONLY, groupExists, killGroupQuietly, waitUntil } from './process-group-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const urlOf = (relative) => new URL(relative, import.meta.url).href;
const ENV_MS_URL = urlOf('../home/tools/long-run/lib/env-ms.mjs');
const DRIVER_URL = urlOf('../home/tools/long-run/lib/driver.mjs');
const PROCESS_TREE_URL = urlOf('../home/tools/long-run/lib/process-tree.mjs');
const DOCTOR_URL = urlOf('../scripts/doctor-accounts.mjs');

const CONTROL_POLL_KNOB = 'CLAUDE_LONG_RUN_CONTROL_POLL_MS';
const SWEEP_GRACE_KNOB = 'CLAUDE_LONG_RUN_SWEEP_GRACE_MS';
const KEYCHAIN_PROBE_KNOB = 'CLAUDE_DOCTOR_KEYCHAIN_PROBE_TIMEOUT_MS';
const ALL_KNOBS = [CONTROL_POLL_KNOB, SWEEP_GRACE_KNOB, KEYCHAIN_PROBE_KNOB];

// The production waits.
const DEFAULT_CONTROL_POLL_MS = 2000;
const DEFAULT_KEYCHAIN_PROBE_MS = 3000;
const DEFAULT_TERM_GRACE_MS = 3000;

const SHORT_KNOB_MS = 250;
// The grace of the sweep case: short, so a run on the knob ends far before the default's 3 s.
const SWEEP_KNOB_MS = 50;
// A sweep on the knob ends within this; the default grace would take DEFAULT_TERM_GRACE_MS.
const SWEEP_BOUND_MS = 1500;
// How long a child node process may take to load a module and answer.
const CHILD_LIMIT_MS = 60000;
const START_WAIT_MS = 5000;
const GONE_WAIT_MS = 5000;

const FALLBACK = 77;
const KNOB_FOR_MSFROMENV = 'CS_TEST_ENV_MS_KNOB';

/**
 * Runs `script` (an ES module body) in a child node process and parses the JSON line it prints.
 * @param {string} script the module text; it prints one JSON value with console.log.
 * @param {Record<string, string>} knobs the knob variables the child gets; every other knob is deleted from its environment.
 * @returns {Promise<any>} the value the child printed; rejects with the child's stderr when it exits non-zero.
 */
async function runChild(script, knobs = {}) {
  const home = makeTempDir('knobs-');
  const env = cleanEnv({ HOME: home, USERPROFILE: home, TMPDIR: home, TEMP: home, TMP: home });
  delete env.NODE_TEST_CONTEXT; // else the child reports to this test run
  for (const name of ALL_KNOBS) delete env[name];
  Object.assign(env, knobs);
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const limit = setTimeout(() => child.kill('SIGKILL'), CHILD_LIMIT_MS);
  const code = await new Promise((resolve) => child.once('close', resolve));
  clearTimeout(limit);
  assert.equal(code, 0, `child exited ${code}: ${stderr.slice(-800)}`);
  return JSON.parse(stdout.trim().split('\n').at(-1));
}

/** The three waits as a child reads them with `knobs` in its environment. */
const readWaits = (knobs) => runChild(`
  const { CONTROL_POLL_MS } = await import(${JSON.stringify(DRIVER_URL)});
  const { TERM_GRACE_MS } = await import(${JSON.stringify(PROCESS_TREE_URL)});
  const { KEYCHAIN_PROBE_TIMEOUT_MS } = await import(${JSON.stringify(DOCTOR_URL)});
  console.log(JSON.stringify({ CONTROL_POLL_MS, TERM_GRACE_MS, KEYCHAIN_PROBE_TIMEOUT_MS }));
`, knobs);

test('msFromEnv returns the fallback for an unset, empty, non-numeric, zero, negative, fractional or unsafe value', async () => {
  const { msFromEnv } = await import(ENV_MS_URL);
  const hostile = ['', 'abc', '0', '-5', '1.5', 'NaN', 'Infinity', '9007199254740992'];
  try {
    delete process.env[KNOB_FOR_MSFROMENV];
    assert.equal(msFromEnv(KNOB_FOR_MSFROMENV, FALLBACK), FALLBACK, 'unset');
    for (const value of hostile) {
      process.env[KNOB_FOR_MSFROMENV] = value;
      assert.equal(msFromEnv(KNOB_FOR_MSFROMENV, FALLBACK), FALLBACK, `value ${JSON.stringify(value)}`);
    }
  } finally {
    delete process.env[KNOB_FOR_MSFROMENV];
  }
});

test('msFromEnv returns a positive whole number of milliseconds as it is', async () => {
  const { msFromEnv } = await import(ENV_MS_URL);
  try {
    process.env[KNOB_FOR_MSFROMENV] = String(SHORT_KNOB_MS);
    assert.equal(msFromEnv(KNOB_FOR_MSFROMENV, FALLBACK), SHORT_KNOB_MS);
  } finally {
    delete process.env[KNOB_FOR_MSFROMENV];
  }
});

test('with no knob set the waits keep their production values (regression)', async () => {
  const waits = await readWaits({});
  assert.deepEqual(waits, { CONTROL_POLL_MS: DEFAULT_CONTROL_POLL_MS, TERM_GRACE_MS: DEFAULT_TERM_GRACE_MS, KEYCHAIN_PROBE_TIMEOUT_MS: DEFAULT_KEYCHAIN_PROBE_MS });
});

test('the control poll knob sets CONTROL_POLL_MS', async () => {
  const { CONTROL_POLL_MS } = await readWaits({ [CONTROL_POLL_KNOB]: String(SHORT_KNOB_MS) });
  assert.equal(CONTROL_POLL_MS, SHORT_KNOB_MS);
});

test('the keychain probe knob sets KEYCHAIN_PROBE_TIMEOUT_MS', async () => {
  const { KEYCHAIN_PROBE_TIMEOUT_MS } = await readWaits({ [KEYCHAIN_PROBE_KNOB]: String(SHORT_KNOB_MS) });
  assert.equal(KEYCHAIN_PROBE_TIMEOUT_MS, SHORT_KNOB_MS);
});

test('the sweep grace knob leaves TERM_GRACE_MS at its production value', async () => {
  const { TERM_GRACE_MS } = await readWaits({ [SWEEP_GRACE_KNOB]: String(SHORT_KNOB_MS) });
  assert.equal(TERM_GRACE_MS, DEFAULT_TERM_GRACE_MS);
});

test('a hostile value for every knob keeps every production wait', async () => {
  for (const hostile of ['0', '-1', 'abc']) {
    const waits = await readWaits(Object.fromEntries(ALL_KNOBS.map((name) => [name, hostile])));
    assert.deepEqual(
      waits,
      { CONTROL_POLL_MS: DEFAULT_CONTROL_POLL_MS, TERM_GRACE_MS: DEFAULT_TERM_GRACE_MS, KEYCHAIN_PROBE_TIMEOUT_MS: DEFAULT_KEYCHAIN_PROBE_MS },
      `knobs set to ${JSON.stringify(hostile)}`,
    );
  }
});

test('keychainProbeRunner gives the spawn the keychain probe knob as its timeout', async () => {
  const { timeout, calls } = await runChild(`
    const { keychainProbeRunner } = await import(${JSON.stringify(DOCTOR_URL)});
    const optionsSeen = [];
    const fakeSpawn = (command, args, options) => { optionsSeen.push(options); return { status: 0, stdout: '', stderr: '' }; };
    keychainProbeRunner(fakeSpawn)('list-keychains');
    console.log(JSON.stringify({ timeout: optionsSeen[0]?.timeout, calls: optionsSeen.length }));
  `, { [KEYCHAIN_PROBE_KNOB]: String(SHORT_KNOB_MS) });
  assert.equal(calls, 1);
  assert.equal(timeout, SHORT_KNOB_MS);
});

test('sweepDescendants sends SIGKILL to a process that ignores SIGTERM after the sweep grace knob, not after 3 s', POSIX_ONLY, async () => {
  // A real process of our own that ignores SIGTERM, in a group of its own; nothing else is signalled.
  const stubborn = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready');"], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let printed = '';
  stubborn.stdout.setEncoding('utf8').on('data', (chunk) => { printed += chunk; });
  try {
    assert.ok(await waitUntil(() => printed.includes('ready'), START_WAIT_MS), 'the stubborn process started');
    // The fake `ps` lists the process for as long as it exists, as the real one does.
    const swept = await runChild(`
      const { sweepDescendants } = await import(${JSON.stringify(PROCESS_TREE_URL)});
      const pid = ${stubborn.pid};
      const seen = new Map([[pid, pid]]);
      const exists = () => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
      const fakePs = () => ({ status: 0, stdout: exists() ? pid + ' 1 ' + pid + '\\n' : '', stderr: '' });
      const startedAt = performance.now();
      const survivors = await sweepDescendants(seen, { runner: fakePs });
      console.log(JSON.stringify({ survivors, elapsedMs: performance.now() - startedAt }));
    `, { [SWEEP_GRACE_KNOB]: String(SWEEP_KNOB_MS) });
    assert.deepEqual(swept.survivors, [stubborn.pid], 'the sweep found the process');
    assert.ok(swept.elapsedMs >= SWEEP_KNOB_MS, `it waited the knob's grace (${swept.elapsedMs} ms)`);
    assert.ok(swept.elapsedMs < SWEEP_BOUND_MS, `it did not wait the default ${DEFAULT_TERM_GRACE_MS} ms (${swept.elapsedMs} ms)`);
    assert.ok(await waitUntil(() => stubborn.signalCode !== null, GONE_WAIT_MS), 'it was ended');
    assert.equal(stubborn.signalCode, 'SIGKILL');
  } finally {
    killGroupQuietly(stubborn.pid);
    assert.ok(await waitUntil(() => !groupExists(stubborn.pid), GONE_WAIT_MS), 'the stubborn process group is gone');
  }
});

test('a knob of 2^31 ms or more keeps the default (timer overflow)', async () => {
  // Node clamps a timer of 2^31 ms or more to 1 ms (TimeoutOverflowWarning): the driver would poll its control files every ms.
  for (const overflowing of ['2147483648', '9007199254740991']) {
    const { fromEnv, controlPoll } = await runChild(`
      const { msFromEnv } = await import(${JSON.stringify(ENV_MS_URL)});
      const { CONTROL_POLL_MS } = await import(${JSON.stringify(DRIVER_URL)});
      console.log(JSON.stringify({ fromEnv: msFromEnv(${JSON.stringify(CONTROL_POLL_KNOB)}, ${DEFAULT_CONTROL_POLL_MS}), controlPoll: CONTROL_POLL_MS }));
    `, { [CONTROL_POLL_KNOB]: overflowing });
    assert.equal(fromEnv, DEFAULT_CONTROL_POLL_MS, `msFromEnv with ${overflowing}`);
    assert.equal(controlPoll, DEFAULT_CONTROL_POLL_MS, `CONTROL_POLL_MS with ${overflowing}`);
  }
});

const MAX_TIMER_MS = 2 ** 31 - 1;

/** Reads msFromEnv with `value` in the test-only variable, so a failing case names the value. */
async function msFromEnvWith(value) {
  const { msFromEnv } = await import(ENV_MS_URL);
  try {
    process.env[KNOB_FOR_MSFROMENV] = value;
    return msFromEnv(KNOB_FOR_MSFROMENV, FALLBACK);
  } finally {
    delete process.env[KNOB_FOR_MSFROMENV];
  }
}

test('msFromEnv returns the fallback for an exponent such as 1e3, which Number() would read as 1000', async () => {
  assert.equal(await msFromEnvWith('1e3'), FALLBACK, 'value "1e3"');
});

test('msFromEnv returns the fallback for a hex number such as 0x10, which Number() would read as 16', async () => {
  assert.equal(await msFromEnvWith('0x10'), FALLBACK, 'value "0x10"');
});

test('msFromEnv returns the fallback for a plus sign such as +5, which Number() would read as 5', async () => {
  assert.equal(await msFromEnvWith('+5'), FALLBACK, 'value "+5"');
});

test('msFromEnv returns the fallback for a number with a space around it, which Number() would read as 250', async () => {
  for (const spaced of [' 250 ', '250 ', ' 250']) {
    assert.equal(await msFromEnvWith(spaced), FALLBACK, `value ${JSON.stringify(spaced)}`);
  }
});

test('msFromEnv returns the fallback for 0 (regression)', async () => {
  assert.equal(await msFromEnvWith('0'), FALLBACK, 'value "0"');
});

test('msFromEnv returns the fallback for 2^31 ms, one over the longest timer', async () => {
  assert.equal(await msFromEnvWith(String(MAX_TIMER_MS + 1)), FALLBACK, `value "${MAX_TIMER_MS + 1}"`);
});

test('msFromEnv returns the fallback for a value too large for a finite number', async () => {
  // '9' x 400 is digits only but Number() gives Infinity; 1e300 is finite but is not digits only.
  for (const huge of ['9'.repeat(400), '1e300']) {
    assert.equal(await msFromEnvWith(huge), FALLBACK, `value of ${huge.length} characters starting ${JSON.stringify(huge.slice(0, 5))}`);
  }
});

test('msFromEnv returns 2^31-1 ms, the longest timer, as it is', async () => {
  assert.equal(await msFromEnvWith(String(MAX_TIMER_MS)), MAX_TIMER_MS);
});

test('a control poll knob of 1e3 keeps CONTROL_POLL_MS at its production value', async () => {
  const { CONTROL_POLL_MS } = await readWaits({ [CONTROL_POLL_KNOB]: '1e3' });
  assert.equal(CONTROL_POLL_MS, DEFAULT_CONTROL_POLL_MS);
});
