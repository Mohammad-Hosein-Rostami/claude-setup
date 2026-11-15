// Tests for the advice bounce (lib/bounce-once.mjs adviceOnce, the advice classes in lib/reason-classes.mjs): a quality rule (a hand-edited
// lockfile) is not a safety rule, so its command is denied once with the fix and the identical retry runs without the owner. Next to a reason
// that asks or bounces, today's path decides exactly as before and the advice text is only appended. The hook tests follow the decision table
// in home/hooks/lib/bounce-once.mjs row by row. Spawned hooks get a private HOME (the bounce store) and no GUI, so today's ask shows up as the
// CLI's own "ask". Command strings are only passed to decide() or the hook; nothing is executed.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { remember } from '../home/hooks/lib/allowed-literals.mjs';
import { adviceOnce, bouncedDir } from '../home/hooks/lib/bounce-once.mjs';
import { decide } from '../home/hooks/pre-bash-guard.mjs';
import { hookEnv } from './hook-env.mjs';

const GUARD = fileURLToPath(new URL('../home/hooks/pre-bash-guard.mjs', import.meta.url));
const PROJECT = resolve('/work/proj');
const ctx = { cwd: PROJECT, project: PROJECT };
const SECRET_VALUE = ['i6IW', 'fakefilekey', '0123'].join('');
const LOCKFILE_EDIT = 'sed -i s/a/b/ pnpm-lock.yaml';
const PUSH = 'git push origin main';

/** The lockfile advice as the spec words it. */
const lockfileAdvice = (file) => `${file} is generated: let the package manager write it (pnpm install, npm install, yarn, bun install). `
  + 'To delete or move it on purpose, send the same command again and it runs.';

// Lockfile writes that asked before this change: [command, the lockfile it writes].
const LOCKFILE_EDITS = [
  [LOCKFILE_EDIT, 'pnpm-lock.yaml'], ['echo x > yarn.lock', 'yarn.lock'], ['cp a package-lock.json', 'package-lock.json'],
  ['mv x pnpm-lock.yaml', 'pnpm-lock.yaml'], ['mv pnpm-lock.yaml old.yaml', 'pnpm-lock.yaml'], ['echo x &> bun.lockb', 'bun.lockb'],
  ['truncate -s 0 pnpm-lock.yaml', 'pnpm-lock.yaml'], ["perl -pi -e 's/a/b/' package-lock.json", 'package-lock.json'],
  ['bash -c "sed -i s/a/b/ yarn.lock"', 'yarn.lock'], ['eval sed -i s/a/b/ yarn.lock', 'yarn.lock'],
];

/** @returns {{decision: string, reason?: string}} what the hook decided ('allow' for empty stdout); fails the test on a crash */
function outcome({ status, stdout, stderr }) {
  assert.equal(status, 0, stderr);
  assert.equal(stderr, '');
  if (stdout === '') return { decision: 'allow' };
  const { permissionDecision, permissionDecisionReason } = JSON.parse(stdout).hookSpecificOutput;
  return { decision: permissionDecision, reason: permissionDecisionReason };
}

const hookInput = (command, options = {}) => JSON.stringify({ cwd: options.cwd ?? PROJECT, session_id: options.session ?? 'sess-1', tool_input: { command } });

/** A private HOME and decision log; run() sends one Bash call to the guard hook and returns what it decided. */
function guardSession() {
  const home = mkdtempSync(join(tmpdir(), 'advice-home-'));
  const env = hookEnv({ HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: PROJECT });
  return {
    home,
    store: bouncedDir({ HOME: home }),
    log: () => (existsSync(env.CLAUDE_GUARD_LOG) ? readFileSync(env.CLAUDE_GUARD_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []),
    run: (command, options) => outcome(spawnSync(process.execPath, [GUARD], { input: hookInput(command, options), encoding: 'utf8', env })),
  };
}

/** The log lines without their time: [decision, outcome, class, command, reason]. */
const logRows = (session) => session.log().map((line) => [line.decision, line.outcome, line.class, line.command, line.reason]);

test('a lockfile hand edit that asked before is advice now: the safety rules allow it and decide() carries the advice text', () => {
  for (const [command, file] of LOCKFILE_EDITS) assert.deepEqual(decide(command, ctx), { allow: true, advice: [lockfileAdvice(file)] }, command);
  assert.deepEqual(decide(`${LOCKFILE_EDIT} && echo x > yarn.lock`, ctx).advice, [lockfileAdvice('pnpm-lock.yaml'), lockfileAdvice('yarn.lock')]);
  assert.deepEqual(decide(`${LOCKFILE_EDIT}; ${LOCKFILE_EDIT}`, ctx).advice, [lockfileAdvice('pnpm-lock.yaml')], 'one line per text');
  for (const command of ['rm pnpm-lock.yaml', 'cat pnpm-lock.yaml', 'cp package-lock.json backup.json', 'pnpm install']) {
    assert.deepEqual(decide(command, ctx), { allow: true }, `${command}: no advice, as before`);
  }
});

test('advice never weakens another reason: next to an ask, a bounce or a hidden risky word, decide() keeps those reasons and carries the advice apart', () => {
  const withPush = decide(`${LOCKFILE_EDIT} && ${PUSH}`, ctx);
  assert.deepEqual(withPush, { ...decide(PUSH, ctx), advice: [lockfileAdvice('pnpm-lock.yaml')] }, 'the push alone, plus the advice');
  const secret = decide(`KEY='${SECRET_VALUE}' ${LOCKFILE_EDIT}`, ctx);
  assert.deepEqual(secret, { ...decide(`KEY='${SECRET_VALUE}' sed -i s/a/b/ notes.txt`, ctx), advice: [lockfileAdvice('pnpm-lock.yaml')] }, 'the secret alone');
  // the lockfile ask used to make the fail-to-ask backstop redundant; advice does not, so the hidden rm still reaches the owner
  const hidden = decide(`${LOCKFILE_EDIT}; node -e "require('child_process').execSync('rm -rf /x')"`, ctx);
  assert.deepEqual([hidden.ask, hidden.reasons, hidden.advice], [true, ['DESTRUCTIVE: risky word inside shell expansion'], [lockfileAdvice('pnpm-lock.yaml')]]);
  const alias = decide(`alias up='${LOCKFILE_EDIT} && ${PUSH}'`, ctx);
  assert.equal(alias.reason, `alias defines a command that asks: ${decide(PUSH, ctx).reason}`, 'an alias asks for the first reason that asks');
  assert.deepEqual(decide(`alias up='${LOCKFILE_EDIT}'`, ctx), { allow: true, advice: [lockfileAdvice('pnpm-lock.yaml')] }, 'an alias of advice only');
});

test('only the exact advice texts count as advice: another rule whose reason carries the advice wording from the command still asks', () => {
  // the command word lands in "DESTRUCTIVE: <word> can wipe a disk or device", which then starts like the advice ("<word> is generated: ...")
  const crafted = `'${lockfileAdvice('pnpm-lock.yaml').replace('pnpm-lock.yaml ', '')}' > /dev/disk2`;
  const r = decide(crafted, ctx);
  assert.equal(r.ask, true);
  assert.match(r.reason, /^DESTRUCTIVE: .* can wipe a disk or device/);
  assert.equal(r.advice, undefined);
});

test('table row "advice only": the first send is denied with the advice, the identical retry runs; never the owner, logged advice then advice-retry', () => {
  const s = guardSession();
  const first = s.run(LOCKFILE_EDIT);
  assert.equal(first.decision, 'deny');
  const lines = first.reason.split('\n');
  assert.match(lines[0], /^Not run: .*advice.*\(the owner was not asked\)\.$/);
  assert.deepEqual(lines.slice(1), [`- ${lockfileAdvice('pnpm-lock.yaml')}`]);
  assert.deepEqual(s.run(LOCKFILE_EDIT), { decision: 'allow' }, 'the identical retry runs');
  assert.deepEqual(s.run(LOCKFILE_EDIT), { decision: 'allow' }, 'and every later identical send');
  const lockfile = 'hand-edited lockfile';
  assert.deepEqual(logRows(s), [['deny', 'advice', lockfile, '', ''], ['allow', 'advice-retry', lockfile, '', ''], ['allow', 'advice-retry', lockfile, '', '']]);
});

test('after advice, a different command, a trailing blank, another directory or another session is a first time (the bounce-once match)', () => {
  const s = guardSession();
  const command = 'echo x > yarn.lock';
  assert.equal(s.run(command).decision, 'deny');
  assert.equal(s.run('echo y > yarn.lock').decision, 'deny', 'a different command gets its own advice');
  assert.equal(s.run(`${command} `).decision, 'deny', 'a trailing blank makes a new command');
  assert.equal(s.run(command, { cwd: resolve('/work/other') }).decision, 'deny', 'another directory');
  assert.equal(s.run(command, { session: 'sess-2' }).decision, 'deny', 'another session');
  assert.equal(s.run(command).decision, 'allow', 'the identical retry in sess-1 runs');
  assert.equal(s.run(command, { session: 'sess-2' }).decision, 'allow', 'and in sess-2');
});

test('table row "bounce class + advice": a lockfile edit with a literal secret is bounced, then asked, exactly like the secret alone, the advice appended', () => {
  const alone = guardSession();
  const mixed = guardSession();
  const aloneCommand = `KEY='${SECRET_VALUE}' sed -i s/a/b/ notes.txt`;
  const mixedCommand = `KEY='${SECRET_VALUE}' ${LOCKFILE_EDIT}`;
  const advice = lockfileAdvice('pnpm-lock.yaml');
  for (const send of ['first', 'retry']) {
    const [expected, got] = [alone.run(aloneCommand), mixed.run(mixedCommand)];
    assert.equal(got.decision, send === 'first' ? 'deny' : 'ask', send);
    assert.deepEqual(got, { ...expected, reason: `${expected.reason}\n${advice}` }, send);
  }
  assert.deepEqual(mixed.log().map((line) => [line.outcome, line.class]), [['bounce', 'secret'], ['no-gui', undefined]]);
});

test('table row "ask + advice": a lockfile edit with git push asks on every send like the push alone, the advice appended; nothing is stored', () => {
  const s = guardSession();
  const expected = { decision: 'ask', reason: `${decide(PUSH, ctx).reason}\n${lockfileAdvice('pnpm-lock.yaml')}` };
  assert.deepEqual(s.run(`${LOCKFILE_EDIT} && ${PUSH}`), expected);
  assert.deepEqual(s.run(`${LOCKFILE_EDIT} && ${PUSH}`), expected);
  assert.deepEqual(s.log().map((line) => line.outcome), ['no-gui', 'no-gui']);
  assert.equal(existsSync(s.store), false);
});

test('table row "ask + advice" with a secret the owner allowed: the same value again runs silently, exactly like the secret alone', () => {
  const s = guardSession();
  remember('sess-1', [SECRET_VALUE], { HOME: s.home, USERPROFILE: s.home });
  assert.deepEqual(s.run(`KEY='${SECRET_VALUE}' sed -i s/a/b/ notes.txt`), { decision: 'allow' }, 'the secret alone');
  assert.deepEqual(s.run(`KEY='${SECRET_VALUE}' ${LOCKFILE_EDIT}`), { decision: 'allow' }, 'with a lockfile edit');
  assert.deepEqual(s.log().map((line) => line.outcome), ['remembered', 'remembered']);
});

test('table row "nothing": a command with no reason runs on every send and logs nothing', () => {
  const s = guardSession();
  for (const send of [1, 2]) assert.deepEqual(s.run('pnpm install'), { decision: 'allow' }, `send ${send}`);
  assert.deepEqual(s.log(), []);
});

test('table row "store unusable": advice only runs on every send (no deny that repeats, no owner); a command that also asks still asks', () => {
  const s = guardSession();
  mkdirSync(dirname(s.store), { recursive: true });
  writeFileSync(s.store, 'not a folder');
  for (const send of [1, 2]) assert.deepEqual(s.run(LOCKFILE_EDIT), { decision: 'allow' }, `send ${send}`);
  for (const send of [1, 2]) assert.equal(s.run(`${LOCKFILE_EDIT} && ${PUSH}`).decision, 'ask', `with a push, send ${send}`);
  for (const session of ['', '../escape', 'x'.repeat(101)]) assert.deepEqual(s.run(LOCKFILE_EDIT, { session }), { decision: 'allow' }, `session ${session}`);
  assert.equal(readFileSync(s.store, 'utf8'), 'not a folder');
  const call = { command: LOCKFILE_EDIT, cwd: PROJECT, input: { session_id: 'sess-1' } };
  const exploding = new Proxy({}, { get: () => { throw new Error('env exploded'); } });
  assert.equal(adviceOnce([lockfileAdvice('pnpm-lock.yaml')], call, exploding), '', 'an exception runs the command, never a deny');
});

test('a stored digest only lets advice-only commands through: planted for a command that also asks, it still asks', () => {
  const s = guardSession();
  const digest = (command) => createHash('sha256').update(JSON.stringify([PROJECT, command])).digest('hex');
  const commands = [LOCKFILE_EDIT, `${LOCKFILE_EDIT} && ${PUSH}`, `KEY='${SECRET_VALUE}' ${LOCKFILE_EDIT}`];
  mkdirSync(s.store, { recursive: true, mode: 0o700 });
  writeFileSync(join(s.store, 'sess-1.json'), JSON.stringify({ digests: commands.map(digest) }), { mode: 0o600 });
  assert.deepEqual(commands.map((command) => s.run(command).decision), ['allow', 'ask', 'ask']);
});
