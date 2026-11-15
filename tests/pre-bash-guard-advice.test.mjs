// Tests for the advice bounce (lib/bounce-once.mjs adviceOnce, lib/merge-commit.mjs, lib/reason-classes.mjs): a quality rule (a hand-edited
// lockfile, a merge that can create a merge commit) is not a safety rule, so its command is denied once with the fix and the identical retry runs without the owner. Next to a reason
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
import { fastestMs } from './timing.mjs';

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

// options.session: undefined sends no session id at all
const hookInput = (command, options = {}) => JSON.stringify({ cwd: options.cwd ?? PROJECT, session_id: 'session' in options ? options.session : 'sess-1', tool_input: { command } });

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
  const [lockfile, advice] = ['hand-edited lockfile', lockfileAdvice('pnpm-lock.yaml')];
  assert.deepEqual(logRows(s), [
    ['deny', 'advice', lockfile, LOCKFILE_EDIT, advice], ['allow', 'advice-retry', lockfile, LOCKFILE_EDIT, advice],
    ['allow', 'advice-retry', lockfile, LOCKFILE_EDIT, advice],
  ]);
});

test('every advice decision is logged like an ask, the command masked and cut; advice that cannot be stored runs, logged advice-unrecorded', () => {
  const s = guardSession();
  const long = `sed -i ${'-e s/x/y/ '.repeat(30)}pnpm-lock.yaml`;
  assert.equal(s.run(long).decision, 'deny');
  assert.deepEqual(s.run(LOCKFILE_EDIT, { session: undefined }), { decision: 'allow' }, 'no session id: nothing can be stored, so it runs');
  assert.deepEqual(s.run(LOCKFILE_EDIT, { session: undefined }), { decision: 'allow' }, 'and runs again: no deny that repeats');
  const [lockfile, advice] = ['hand-edited lockfile', lockfileAdvice('pnpm-lock.yaml')];
  assert.deepEqual(logRows(s), [
    ['deny', 'advice', lockfile, long.slice(0, 200), advice], ['allow', 'advice-unrecorded', lockfile, LOCKFILE_EDIT, advice],
    ['allow', 'advice-unrecorded', lockfile, LOCKFILE_EDIT, advice],
  ]);
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

test('table row "bounce class + advice": a lockfile edit with a literal secret is bounced, then asked, exactly like the secret alone, the advice class named', () => {
  const alone = guardSession();
  const mixed = guardSession();
  const aloneCommand = `KEY='${SECRET_VALUE}' sed -i s/a/b/ notes.txt`;
  const mixedCommand = `KEY='${SECRET_VALUE}' ${LOCKFILE_EDIT}`;
  for (const send of ['first', 'retry']) {
    const [expected, got] = [alone.run(aloneCommand), mixed.run(mixedCommand)];
    assert.equal(got.decision, send === 'first' ? 'deny' : 'ask', send);
    assert.deepEqual(got, { ...expected, reason: `${expected.reason}\nalso: hand-edited lockfile` }, send);
  }
  assert.deepEqual(mixed.log().map((line) => [line.outcome, line.class]), [['bounce', 'secret'], ['no-gui', undefined]]);
});

test('table row "ask + advice": a lockfile edit with git push asks on every send like the push alone, the advice class named; nothing is stored', () => {
  const s = guardSession();
  const expected = { decision: 'ask', reason: `${decide(PUSH, ctx).reason}\nalso: hand-edited lockfile` };
  assert.deepEqual(s.run(`${LOCKFILE_EDIT} && ${PUSH}`), expected);
  assert.deepEqual(s.run(`${LOCKFILE_EDIT} && ${PUSH}`), expected);
  assert.deepEqual(s.log().map((line) => line.outcome), ['no-gui', 'no-gui']);
  assert.equal(existsSync(s.store), false);
});

test('a safety verdict names its advice by class only: the advice\'s "send the same command again and it runs" never reaches the owner or a bounce', () => {
  const retrySentence = 'send the same command again and it runs';
  const s = guardSession();
  const ask = s.run(`git pull && ${PUSH}`);
  assert.deepEqual(ask, { decision: 'ask', reason: `${decide(PUSH, ctx).reason}\nalso: merge commit` });
  const [bounce, retry] = [s.run(`KEY='${SECRET_VALUE}' git merge x`), s.run(`KEY='${SECRET_VALUE}' git merge x`)];
  assert.deepEqual([bounce.decision, retry.decision], ['deny', 'ask']);
  for (const { reason } of [ask, bounce, retry]) {
    assert.equal(reason.includes(retrySentence), false, reason);
    assert.match(reason, /\nalso: merge commit$/);
  }
  assert.match(s.run(`echo x > yarn.lock && git merge y && ${PUSH}`).reason, /\nalso: hand-edited lockfile; merge commit$/);
  assert.equal(s.log().some((line) => line.reason.includes(retrySentence)), false, 'nor the log');
});

test('table row "ask + advice" with a secret the owner allowed: the secret stays silent, and the advice is still given once, then the retry runs', () => {
  const s = guardSession();
  remember('sess-1', [SECRET_VALUE], { HOME: s.home, USERPROFILE: s.home });
  assert.deepEqual(s.run(`KEY='${SECRET_VALUE}' sed -i s/a/b/ notes.txt`), { decision: 'allow' }, 'the secret alone');
  const command = `KEY='${SECRET_VALUE}' ${LOCKFILE_EDIT}`;
  const first = s.run(command);
  assert.equal(first.decision, 'deny', 'the advice the remembered secret would have hidden');
  assert.deepEqual(first.reason.split('\n').slice(1), [`- ${lockfileAdvice('pnpm-lock.yaml')}`]);
  assert.deepEqual(s.run(command), { decision: 'allow' }, 'the identical retry runs');
  assert.deepEqual(s.log().map((line) => line.outcome), ['remembered', 'remembered', 'advice', 'remembered', 'advice-retry']);
  assert.equal(JSON.stringify(s.log()).includes(SECRET_VALUE), false, 'the advice lines mask the secret like every other line');
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
  const adviceLines = s.log().filter((line) => line.outcome.startsWith('advice'));
  assert.deepEqual(adviceLines.map((line) => [line.outcome, line.command]), Array(5).fill(['advice-unrecorded', LOCKFILE_EDIT]));
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

// C37: a merge that can create a merge commit.
const MERGE_ADVICE = 'Linear history (C37): rebase the branch onto the base, then git merge --ff-only (for pull: git pull --rebase). '
  + "If this repository's own rules need a merge commit, send the same command again and it runs.";
const MERGE_FIRES = [
  'git merge feature', 'git merge --no-ff feature', 'git merge', 'git merge -m "msg" feature', 'git pull', 'git pull origin main', 'git pull --no-rebase',
  'git pull --rebase=false', 'git pull --rebase=FALSE', 'git -C ../repo merge lane/x', 'git -c pull.ff=true pull', 'git --git-dir=.git merge x',
  'git --no-pager merge x', 'git --work-tree . pull', 'cd ../repo && git merge lane/x', 'git fetch && git merge origin/main',
  'git pull --rebase && git merge lane/x', 'git merge -- --ff-only', 'git merge --FF-ONLY x', 'sudo git merge x', 'env X=1 git merge x',
  'command git merge x', 'git "merge" x', 'git\tmerge\tx', 'git  merge x', 'if true; then git merge x; fi', '(git pull)', 'git merge x 2>&1 | tee log',
  'git merge -m --ff-only x', 'git merge feature --no-ff', 'git pull --rebase=', 'git "mer"ge x', "cat <<'EOF' > a.md\nnotes\nEOF\ngit merge x",
  "# don't\ngit merge x", 'echo $((1+2)) && git merge x', 'x=$(git merge-base a b); git merge "$x"',
];
const MERGE_SILENT = [
  'git merge --ff-only feature', 'git merge --abort', 'git merge --continue', 'git merge --quit', 'git merge --squash feature', 'git pull --rebase',
  'git pull -r', 'git pull --rebase=merges', 'git pull --rebase=true', 'git pull --ff-only', 'git pull --rebase origin main', 'git merge-base a b',
  'git merge-tree a b', 'git merge-file a b c', 'git mergetool', 'git rebase main', 'git fetch origin', 'x=$(git merge y)', 'echo "$(git merge x)"',
  'echo `git pull`', "cat <<'EOF'\ngit merge x\nEOF", 'cat <<EOF > notes.md\ngit pull\nEOF', 'echo git merge x', 'echo "git merge x"',
  'git commit -m "merge x"', 'git commit -m "git merge x"', 'grep -r "git merge" .', 'git log --grep=merge', 'git branch --merged',
  'ssh build-box "git pull"', 'git config pull.rebase true', 'git merge feature --ff-only', 'git pull origin main --rebase', 'git merge --ff-only -- x',
  "# it's done\nx=$(git merge y)", 'git status # git merge x', "echo '$(git merge x)'", 'x=$(git pull) && echo "$x"',
];

test('C37: a git merge or pull that can create a merge commit gets the advice (behind global options, wrappers, quoting); ff-only, '
  + 'abort/continue/quit/squash, a rebasing pull, other subcommands and a merge inside $(...), backticks, a heredoc or text do not', () => {
  for (const command of MERGE_FIRES) assert.deepEqual(decide(command, ctx), { allow: true, advice: [MERGE_ADVICE] }, JSON.stringify(command));
  for (const command of MERGE_SILENT) assert.deepEqual(decide(command, ctx), { allow: true }, JSON.stringify(command));
});

test('C37: next to git push the merge asks like the push alone; 32 KB of merges decide fast; over 32 KB asks "too long" with no advice', () => {
  assert.deepEqual(decide(`git merge lane/x && ${PUSH}`, ctx), { ...decide(PUSH, ctx), advice: [MERGE_ADVICE] });
  const many = 'git merge x; '.repeat(2400);
  assert.deepEqual(decide(many, ctx), { allow: true, advice: [MERGE_ADVICE] });
  const fastest = fastestMs(() => decide(many, ctx));
  assert.ok(fastest < 500, `32 KB of merges took too long (fastest of 3: ${fastest.toFixed(1)} ms)`);
  const huge = decide('git merge x; '.repeat(8000), ctx);
  assert.deepEqual([huge.ask, huge.advice], [true, undefined]);
  assert.match(huge.reason, /command too long/);
});

test('C37 through the hook: git merge alone is denied once with the advice, then runs; with git push it asks every time, the advice appended', () => {
  const s = guardSession();
  assert.deepEqual(s.run('git merge lane/x').reason.split('\n').slice(1), [`- ${MERGE_ADVICE}`]);
  assert.deepEqual(s.run('git merge lane/x'), { decision: 'allow' });
  const mixed = { decision: 'ask', reason: `${decide(PUSH, ctx).reason}\nalso: merge commit` };
  assert.deepEqual([s.run(`git merge lane/x && ${PUSH}`), s.run(`git merge lane/x && ${PUSH}`)], [mixed, mixed]);
  const merge = 'merge commit';
  assert.deepEqual(logRows(s).map((row) => row.slice(0, 3)), [['deny', 'advice', merge], ['allow', 'advice-retry', merge], ['ask', 'no-gui', undefined], ['ask', 'no-gui', undefined]]);
});
