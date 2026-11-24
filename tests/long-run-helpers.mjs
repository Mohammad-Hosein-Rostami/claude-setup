// Helpers for the long-run tests (not a test file): a sandbox with the fake claude on PATH, stored test accounts in the file store,
// a temp state folder and HOME; runs made in process (with a fake clock) or through the CLI.
// Exports: CLI, TOKEN_A, TOKEN_B, makeSandbox, fakeClock, createRun, driveRun, cli, startCli, waitFor, readCalls, journalOf, stdinsOf.
// Invariants: no real token, account, Keychain item, state folder, launchd or Task Scheduler entry is touched (CLAUDE_ACCOUNT_STORE=file,
// LONG_RUN_STATE_DIR, HOME, CLAUDE_CONFIG_DIR and ACCOUNT_STATE_DIR all point into the sandbox); tokens are built from parts.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { addAccount, setCreditsOff } from '../home/tools/account/lib/accounts.mjs';
import { freezeJob, loadJob } from '../home/tools/long-run/lib/job.mjs';
import { ensureRunDirs, newRunId, readJournal, readJsonLines, runPaths, writeJson } from '../home/tools/long-run/lib/run-store.mjs';
import { drive } from '../home/tools/long-run/lib/driver.mjs';
import { installFakeClaude } from './long-run-fake-claude.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

export const CLI = resolve(import.meta.dirname, '..', 'home', 'tools', 'long-run', 'long-run.mjs');
const TOKEN_PREFIX = ['sk', 'ant', 'test', ''].join('-');
/** Made-up tokens of the real shape (`sk-ant-test-...`). */
export const TOKEN_A = `${TOKEN_PREFIX}${'AccountA'.repeat(10)}`;
export const TOKEN_B = `${TOKEN_PREFIX}${'AccountB'.repeat(10)}`;
const SESSION_VARIABLES = /^(?:CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_ACCOUNT.*|CLAUDE_CONFIG_DIR|LONG_RUN_.*|ANTHROPIC_.*|FAKE_LR_.*)$/;
const WAIT_SLICE_MS = 50;

/**
 * A sandbox: accounts `a` and `b` (tokens TOKEN_A, TOKEN_B), usage credits off unless `creditsOff` says otherwise.
 * @param {{creditsOff?: Record<string, boolean>, account?: string | null}} options `account`: CLAUDE_ACCOUNT of `env`.
 */
export function makeSandbox({ creditsOff = { a: true, b: true }, account = 'a' } = {}) {
  const dir = makeTempDir('long-run-');
  const folders = Object.fromEntries(['bin', 'home', 'state', 'accounts', 'account-state', 'config', 'fake', 'work'].map((name) => [name, join(dir, name)]));
  for (const folder of Object.values(folders)) mkdirSync(folder, { recursive: true, mode: 0o700 });
  installFakeClaude(folders.bin);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !SESSION_VARIABLES.test(name)));
  Object.assign(env, {
    PATH: `${folders.bin}${delimiter}${process.env.PATH}`, HOME: folders.home, USERPROFILE: folders.home, LONG_RUN_STATE_DIR: folders.state,
    CLAUDE_ACCOUNT_DIR: folders.accounts, CLAUDE_ACCOUNT_STORE: 'file', ACCOUNT_STATE_DIR: folders['account-state'],
    CLAUDE_CONFIG_DIR: folders.config, FAKE_LR_DIR: folders.fake,
  });
  for (const [name, token] of [['a', TOKEN_A], ['b', TOKEN_B]]) {
    addAccount(name, token, { env });
    if (creditsOff[name]) setCreditsOff(name, { env });
  }
  if (account !== null) env.CLAUDE_ACCOUNT = account;
  const work = (name) => {
    const folder = join(folders.work, name);
    mkdirSync(folder, { recursive: true });
    return folder;
  };
  return {
    dir, env, root: folders.state, fakeDir: folders.fake, folders, work,
    script: (modes) => writeFileSync(join(folders.fake, 'script.json'), JSON.stringify(modes)),
    writeJob: (job, name = 'job.json') => {
      const path = join(dir, name);
      writeFileSync(path, JSON.stringify(job));
      return path;
    },
  };
}

/** The fake's call records, `start` lines only, each with its `end` line merged in. */
export function readCalls(box) {
  const lines = readJsonLines(join(box.fakeDir, 'calls.jsonl'));
  const ends = new Map(lines.filter((line) => line.kind === 'end').map((line) => [line.pid, line]));
  return lines.filter((line) => line.kind === 'start').map((line) => ({ ...line, end: ends.get(line.pid)?.end ?? null, ended: ends.get(line.pid)?.ended ?? null }));
}

/** A clock that moves only when the run sleeps. */
export function fakeClock(startIso = '2026-11-24T10:00:00.000Z') {
  let at = Date.parse(startIso);
  const slept = [];
  return {
    slept,
    now: () => new Date(at),
    sleep: async (ms) => {
      slept.push(ms);
      at += ms;
      await new Promise((done) => { setImmediate(done); });
    },
    set: (iso) => { at = Date.parse(iso); },
  };
}

/** Makes a run of `job` (an object) as `start` does, without starting a driver. @returns {Record<string, string>} its paths. */
export function createRun(box, job, { account = 'a', now = new Date() } = {}) {
  const loaded = loadJob(box.writeJob(job));
  const paths = runPaths(box.root, newRunId(box.root, loaded.job.name, now));
  ensureRunDirs(paths);
  writeJson(paths.job, freezeJob(loaded));
  writeJson(paths.run, { account, startedBy: 'terminal', createdAt: now.toISOString() });
  return paths;
}

/** Runs the driver of `paths` in this process with a fake clock and no notes; a reply is applied as `resume` would. */
export async function driveRun(box, paths, { clock = fakeClock(), reply = null, notes = [], killAfter } = {}) {
  if (reply) writeJson(join(paths.dir, 'resume.json'), { action: 'continue', text: null, item: null, id: `${Date.now()}-${Math.random()}`, ...reply });
  return drive(paths, {
    env: box.env, platform: process.platform, now: clock.now, sleep: clock.sleep, random: () => 0.5, keepAwake: false,
    exit: (code) => { throw new Error(`driver exit ${code}`); }, notifier: async (texts) => { notes.push(texts); return []; },
    limitsDir: join(box.dir, 'limits'), ...(killAfter ? { killAfter } : {}),
  });
}

/** Runs the CLI to its end. */
export const cli = (box, args, { env = box.env, timeout = 120000 } = {}) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout });

/** Starts the CLI and returns the child (its output collected in `child.output`). */
export function startCli(box, args, { env = box.env } = {}) {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  child.stdout.on('data', (chunk) => { child.output += chunk; });
  child.stderr.on('data', (chunk) => { child.output += chunk; });
  return child;
}

/** Waits until `check()` is truthy (real time), at most `ms`. */
export async function waitFor(check, ms = 30000, what = 'condition') {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => { setTimeout(done, WAIT_SLICE_MS); });
  }
}

/** The journal of a step. */
export const journalOf = (paths, unitId) => readJournal(paths, unitId);

/** The stdin texts the fake got for one step, in order. */
export const stdinsOf = (box, step) => readCalls(box).filter((call) => call.step === step).map((call) => call.stdin);
