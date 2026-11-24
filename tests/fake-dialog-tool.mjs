// Purpose: a fake native dialog tool for tests of the async popup (lib/timed-ask-async.mjs and the question loop): an executable named like
// the platform's dialog tool (osascript / powershell / zenity) sits first on PATH, writes its pid to a file, and either answers
// right away or stays open ("hang") until it is killed, as a real popup does. No test ever opens a real dialog.
// Exports: fakePopup(result, extra) -> {env, pid(), alive()}; result is allow | deny | timeout | hang.
import { readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { dialogExecutable } from '../home/hooks/lib/timed-ask.mjs';
import { tempLogPath } from './hook-env.mjs';
import { sharedToolDir } from './shared-tools.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';

const HANG_MS = 60_000; // a hanging popup outlives every test; the test kills it
const SCRIPT = `
const { writeFileSync } = require('node:fs');
if (process.env.FAKE_WARM) process.exit(0);
writeFileSync(process.env.FAKE_POPUP_PID, String(process.pid));
const result = process.env.FAKE_POPUP_RESULT;
if (result === 'hang') setTimeout(() => {}, ${HANG_MS});
const out = {
  darwin: { allow: 'button returned:Use recommended, gave up:false', deny: 'button returned:Answer in terminal, gave up:false', timeout: 'button returned:, gave up:true' },
  win32: { allow: '6', deny: '7', timeout: '-1' },
  linux: { allow: '', deny: '', timeout: '' },
}[process.platform];
if (result !== 'hang') {
  process.stdout.write(out[result]);
  process.exit(process.platform === 'linux' ? { allow: 0, deny: 1, timeout: 5 }[result] : 0);
}
`;

/** @returns {boolean} true while a process with this pid runs */
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * @param {'allow' | 'deny' | 'timeout' | 'hang'} result what the fake popup does
 * @param {Record<string, string>} extra more environment variables
 * @returns {{env: Record<string, string | undefined>, pid: () => number | undefined, alive: () => boolean}} env that makes a hook use the fake;
 *   pid() is the popup's process id once it started (the popup writes it); alive() tells whether it still runs
 */
export function fakePopup(result, extra = {}) {
  const dir = makeTempDir('fake-popup-');
  let tools = dir;
  if (process.platform === 'win32') {
    const script = join(dir, 'fake.cjs');
    writeFileSync(script, SCRIPT);
    writeFileSync(join(dir, `${dialogExecutable(process.platform)}.cmd`), `@node "${script}" %*\r\n`);
  } else {
    // one shared folder for every popup (a new executable is slow to start): the tool reads its result and pid file from env
    tools = sharedToolDir({ 'fake.cjs': SCRIPT, [dialogExecutable(process.platform)]: '#!/bin/sh\nexec node "$(dirname "$0")/fake.cjs" "$@"\n' });
  }
  const pidFile = join(dir, 'popup.pid');
  const home = join(dir, 'home');
  const env = cleanEnv({ HOME: home, USERPROFILE: home, PATH: `${tools}${delimiter}${process.env.PATH}`, DISPLAY: ':0', FAKE_POPUP_RESULT: result, FAKE_POPUP_PID: pidFile, CLAUDE_GUARD_LOG: tempLogPath(), ...extra });
  for (const name of ['NODE_TEST_CONTEXT', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'CI']) delete env[name];
  const pid = () => {
    try {
      return Number(readFileSync(pidFile, 'utf8'));
    } catch {
      return undefined;
    }
  };
  return { env, pid, alive: () => { const id = pid(); return id !== undefined && isAlive(id); } };
}
