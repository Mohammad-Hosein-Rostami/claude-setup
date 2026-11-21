// Tests for home/hooks/bash-writes.mjs: a Bash command's code files reach the edit log only after the command ran, and only
// those whose content changed, under their real path (spec-p1-edit-log.md section 4 and K1). Each test sends the real hook a
// PreToolUse input, makes with fs calls the change the command would make (no command is ever executed), then sends the
// PostToolUse or PostToolUseFailure input of the same call. A hook that waits is killed and fails by its missing answer; no test
// measures time. Every hook runs with a private HOME, TMPDIR and guard log.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MAX_CANDIDATES } from '../home/hooks/bash-writes.mjs';
import { hookEnv } from './hook-env.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/bash-writes.mjs', import.meta.url));
const KILL_AFTER_MS = 30000; // only so a hook that waits ends the run; the assertions read the answer, never the time
const POSIX_ONLY = process.platform === 'win32' ? 'Windows has no FIFO, no mode bits and no file links without rights' : false;
const UNREADABLE_FOLDERS = POSIX_ONLY || (process.getuid?.() === 0 ? 'root reads a mode 000 folder' : false);
const ROOT = 'claude-post-edit';

/** A private temp folder for the hook, a project with `src/` in it (real paths: macOS's /var is a link), and a guard log. */
function fixture() {
  const tmp = makeTempDir('bash-writes-');
  const project = realpathSync(makeTempDir('bash-writes-proj-'));
  mkdirSync(join(project, 'src'));
  const guardLog = join(makeTempDir('bash-writes-log-'), 'guard.jsonl');
  const env = hookEnv({ TMPDIR: tmp, TEMP: tmp, TMP: tmp, CLAUDE_PROJECT_DIR: project, CLAUDE_GUARD_LOG: guardLog });
  return { tmp, project, guardLog, env, src: (name) => join(project, 'src', name), ids: 0 };
}

/** Sends one hook input; the hook must answer with exit 0 and print nothing. */
function send(fx, input) {
  const text = typeof input === 'string' ? input : JSON.stringify({ session_id: 's1', tool_name: 'Bash', cwd: fx.project, ...input });
  const run = spawnSync(process.execPath, [HOOK], { input: text, encoding: 'utf8', timeout: KILL_AFTER_MS, env: fx.env });
  assert.deepEqual([run.status, run.signal, run.stdout], [0, null, ''], run.stderr);
}

/**
 * One Bash call: the before-step, `change()`, the after-step.
 * @param {object} fx fixture
 * @param {string} command the command text the hook parses
 * @param {() => void} [change] what the command would have done
 * @param {{after?: string | null, id?: string, input?: object, response?: object}} [how] after-step event (null: none), ids, extras
 */
function call(fx, command, change = () => {}, { after = 'PostToolUse', id = `t${(fx.ids += 1)}`, input = {}, response = {} } = {}) {
  const base = { tool_use_id: id, tool_input: { command }, ...input };
  send(fx, { ...base, hook_event_name: 'PreToolUse' });
  change();
  if (after) send(fx, { ...base, hook_event_name: after, tool_response: response, ...(after === 'PostToolUseFailure' ? { error: 'Exit code 1' } : {}) });
}

const logged = (fx, agent = 'main') => {
  const log = join(fx.tmp, ROOT, 'edits', `s1--${agent}`);
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
};
const guardLines = (fx) => (existsSync(fx.guardLog) ? readFileSync(fx.guardLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
const outcomes = (fx) => guardLines(fx).map((line) => line.outcome);
const records = (fx) => (existsSync(join(fx.tmp, ROOT, 'bash-writes')) ? readdirSync(join(fx.tmp, ROOT, 'bash-writes')) : []);

test('a code file the command only read is not logged, and no guard-log line is written', () => {
  const fx = fixture();
  writeFileSync(fx.src('a.ts'), 'export const a = 1;\n');
  call(fx, `python3 -c "print(open('src/a.ts').read())"`);
  assert.deepEqual([logged(fx), outcomes(fx), records(fx)], [[], [], []]);
});

test('a call that never ran logs nothing; its before-record stays for disk-clean', () => {
  const fx = fixture();
  call(fx, 'sed -i s/a/b/ src/a.ts', () => writeFileSync(fx.src('a.ts'), 'x'), { after: null });
  assert.deepEqual([logged(fx), records(fx), outcomes(fx)], [[], ['s1--main--t1'], []]);
});

test('only the file that changed is logged', () => {
  const fx = fixture();
  writeFileSync(fx.src('a.ts'), 'a');
  writeFileSync(fx.src('b.ts'), 'b');
  call(fx, `python3 -c "open('src/b.ts','w').write(open('src/a.ts').read())"`, () => writeFileSync(fx.src('b.ts'), 'a'));
  assert.deepEqual(logged(fx), [fx.src('b.ts')]);
});

test('writes through sed -i, a redirect, tee, mv, cp and git checkout or restore are logged, each as its target', () => {
  const fx = fixture();
  for (const name of ['a.ts', 'f.ts', 'h.ts']) writeFileSync(fx.src(name), 'old');
  writeFileSync(join(fx.project, 'old.ts'), 'moved');
  const cases = [
    ['sed -i s/a/b/ src/a.ts', () => writeFileSync(fx.src('a.ts'), 'new'), 'a.ts'],
    ['echo x > src/d.mjs', () => writeFileSync(fx.src('d.mjs'), 'x'), 'd.mjs'],
    ['cat a | tee src/e.tsx', () => writeFileSync(fx.src('e.tsx'), 'x'), 'e.tsx'],
    ['mv old.ts src/g.ts', () => renameSync(join(fx.project, 'old.ts'), fx.src('g.ts')), 'g.ts'],
    ['cp tpl.ts src/f.ts', () => writeFileSync(fx.src('f.ts'), 'tpl'), 'f.ts'],
    ['git checkout -- src/h.ts', () => writeFileSync(fx.src('h.ts'), 'head'), 'h.ts'],
  ];
  for (const [command, change] of cases) call(fx, command, change);
  assert.deepEqual(logged(fx), cases.map(([, , name]) => fx.src(name)));
  assert.deepEqual([outcomes(fx), records(fx)], [[], []], 'no doubt, and every before-record is gone');
});

test("a failed command's writes are logged (PostToolUseFailure)", () => {
  const fx = fixture();
  call(fx, 'sed -i s/a/b/ src/a.ts && false', () => writeFileSync(fx.src('a.ts'), 'x'), { after: 'PostToolUseFailure' });
  assert.deepEqual(logged(fx), [fx.src('a.ts')]);
});

test('a background call: a file changed by then is logged; one not changed yet is not, and one line says so', () => {
  const fx = fixture();
  const bg = (command, change) => call(fx, command, change, { input: { tool_input: { command, run_in_background: true } }, response: { backgroundTaskId: 'b1' } });
  bg('echo x > src/a.ts', () => writeFileSync(fx.src('a.ts'), 'x'));
  assert.deepEqual([logged(fx), outcomes(fx)], [[fx.src('a.ts')], []]);
  bg('echo x > src/b.ts', () => {});
  assert.deepEqual([logged(fx), outcomes(fx)], [[fx.src('a.ts')], ['bash-writes-background']]);
});

test('a write outside the project folder is logged (lanes work in worktrees)', () => {
  const fx = fixture();
  const wt = realpathSync(makeTempDir('bash-writes-wt-'));
  mkdirSync(join(wt, 'src'));
  call(fx, `cd ${wt} && sed -i s/a/b/ src/a.ts`, () => writeFileSync(join(wt, 'src', 'a.ts'), 'x'));
  assert.deepEqual(logged(fx), [join(wt, 'src', 'a.ts')]);
});

test('a path with a space is logged as one line', () => {
  const fx = fixture();
  call(fx, 'echo x > "src/a b.ts"', () => writeFileSync(fx.src('a b.ts'), 'x'));
  assert.deepEqual(logged(fx), [fx.src('a b.ts')]);
});

test('links: a write through a link logs the real file; an untouched link, a link to a non-code file log nothing', { skip: POSIX_ONLY }, () => {
  const fx = fixture();
  writeFileSync(fx.src('real.ts'), 'r');
  symlinkSync(fx.src('real.ts'), fx.src('l.ts'));
  call(fx, 'echo x >> src/l.ts', () => appendFileSync(fx.src('real.ts'), 'x'));
  assert.deepEqual(logged(fx), [fx.src('real.ts')], '(a) the real path, not the named link');
  call(fx, 'cat src/l.ts > /dev/null; echo y >> src/l.ts');
  assert.equal(logged(fx).length, 1, '(b) the link left alone');
  const outside = join(realpathSync(makeTempDir('bash-writes-out-')), 'x.log');
  writeFileSync(outside, 'log\n');
  symlinkSync(outside, fx.src('x.ts'));
  call(fx, `python3 -c "print(open('src/x.ts').read())"`, () => appendFileSync(outside, 'more\n'));
  assert.equal(logged(fx).length, 1, '(d) a link to a file that changes by itself, not a code file: not logged');
});

test('links: sed -i that replaces a link with a file logs it; a folder link logs the real path', { skip: POSIX_ONLY }, () => {
  const fx = fixture();
  writeFileSync(fx.src('real.ts'), 'r');
  symlinkSync(fx.src('real.ts'), fx.src('l.ts'));
  call(fx, 'sed -i s/r/s/ src/l.ts', () => { rmSync(fx.src('l.ts')); writeFileSync(fx.src('l.ts'), 's'); });
  assert.deepEqual(logged(fx), [fx.src('l.ts')], '(c)');
  const elsewhere = realpathSync(makeTempDir('bash-writes-dir-'));
  writeFileSync(join(elsewhere, 'a.ts'), 'a');
  symlinkSync(elsewhere, join(fx.project, 'lib'));
  call(fx, 'echo x >> lib/a.ts', () => appendFileSync(join(elsewhere, 'a.ts'), 'x'));
  assert.deepEqual(logged(fx), [fx.src('l.ts'), join(elsewhere, 'a.ts')], '(e) the real path under the linked folder');
});

test('a deleted file is not logged', () => {
  const fx = fixture();
  writeFileSync(fx.src('a.ts'), 'a');
  call(fx, 'sed -i s/a/b/ src/a.ts', () => rmSync(fx.src('a.ts')));
  assert.deepEqual([logged(fx), outcomes(fx)], [[], []]);
});

test('a before-record with one line that is not a [path, state] pair is refused whole: nothing logged, one line', () => {
  const fx = fixture();
  writeFileSync(fx.src('a.ts'), 'a');
  call(fx, 'sed -i s/a/b/ src/a.ts', () => {
    appendFileSync(join(fx.tmp, ROOT, 'bash-writes', 's1--main--t1'), '[1,2]\n');
    writeFileSync(fx.src('a.ts'), 'b');
  });
  assert.deepEqual([logged(fx), outcomes(fx)], [[], ['bash-writes-unchecked']]);
});

test('two calls at once keep their own records', () => {
  const fx = fixture();
  const pre = (id, name) => send(fx, { hook_event_name: 'PreToolUse', tool_use_id: id, tool_input: { command: `echo x > src/${name}` } });
  const post = (id, name) => send(fx, { hook_event_name: 'PostToolUse', tool_use_id: id, tool_input: { command: `echo x > src/${name}` }, tool_response: {} });
  pre('t1', 'a.ts');
  pre('t2', 'b.ts');
  writeFileSync(fx.src('a.ts'), 'x');
  post('t1', 'a.ts');
  writeFileSync(fx.src('b.ts'), 'x');
  post('t2', 'b.ts');
  assert.deepEqual([logged(fx), outcomes(fx), records(fx)], [[fx.src('a.ts'), fx.src('b.ts')], [], []]);
});

test("a subagent's write goes to its own log", () => {
  const fx = fixture();
  call(fx, 'echo x > src/a.ts', () => writeFileSync(fx.src('a.ts'), 'x'), { input: { agent_id: 'a1' } });
  assert.deepEqual([logged(fx, 'a1'), existsSync(join(fx.tmp, ROOT, 'edits', 's1--main'))], [[fx.src('a.ts')], false]);
});

test('doubt is written as one line and nothing is logged: no record, no tool_use_id, an over-long command, a bad agent id', () => {
  const fx = fixture();
  const after = (command, input = {}) => send(fx, { hook_event_name: 'PostToolUse', tool_use_id: 'lone', tool_input: { command }, tool_response: {}, ...input });
  writeFileSync(fx.src('a.ts'), 'x');
  after('echo y > src/a.ts');
  assert.deepEqual(outcomes(fx), ['bash-writes-unchecked'], '(a) no before-record while the command names candidates');
  after('ls -la');
  assert.equal(outcomes(fx).length, 1, '(b) no candidates, no record: no line');
  call(fx, 'echo y > src/a.ts', () => writeFileSync(fx.src('a.ts'), 'y'), { input: { tool_use_id: null } });
  call(fx, `echo y > src/a.ts # ${'x'.repeat(33 * 1024)}`, () => writeFileSync(fx.src('a.ts'), 'z'));
  call(fx, 'echo y > src/a.ts', () => writeFileSync(fx.src('a.ts'), 'w'), { input: { agent_id: '../x' } });
  assert.deepEqual([logged(fx), records(fx)], [[], []], '(e, f) no record either');
  assert.deepEqual(outcomes(fx), Array(4).fill('bash-writes-unchecked'), 'one line each');
  assert.ok(guardLines(fx).every((line) => !line.reason.includes('src/') && line.command === ''), 'no path or command text in a reason');
});

test('a candidate unreadable at the before-step is not logged, and counted in one line', { skip: UNREADABLE_FOLDERS }, () => {
  const fx = fixture();
  mkdirSync(fx.src('locked'));
  chmodSync(fx.src('locked'), 0o000);
  call(fx, 'echo x > src/locked/a.ts; echo x > src/b.ts', () => {
    chmodSync(fx.src('locked'), 0o755);
    writeFileSync(fx.src('locked/a.ts'), 'x');
    writeFileSync(fx.src('b.ts'), 'x');
  });
  assert.deepEqual(logged(fx), [fx.src('b.ts')]);
  assert.deepEqual(guardLines(fx).map((line) => [line.outcome, /\b1\b/.test(line.reason)]), [['bash-writes-unchecked', true]]);
});

test(`more than ${MAX_CANDIDATES} candidates: the first ${MAX_CANDIDATES} are recorded, one line counts the rest`, () => {
  const fx = fixture();
  const names = Array.from({ length: MAX_CANDIDATES + 1 }, (_, i) => `src/f${i}.ts`);
  call(fx, `sed -i s/a/b/ ${names.join(' ')}`, () => {
    assert.equal(readFileSync(join(fx.tmp, ROOT, 'bash-writes', 's1--main--t1'), 'utf8').trim().split('\n').length, MAX_CANDIDATES);
    writeFileSync(fx.src('f0.ts'), 'x');
  });
  assert.deepEqual(logged(fx), [fx.src('f0.ts')]);
  assert.deepEqual(guardLines(fx).map((line) => [line.outcome, /\b1\b/.test(line.reason)]), [['bash-writes-unchecked', true]]);
});

test('content, not time: new content with the old size and mtime is logged; the same content written again is not', () => {
  const fx = fixture();
  writeFileSync(fx.src('a.ts'), 'aaaa');
  const { atime, mtime } = statSync(fx.src('a.ts'));
  call(fx, 'sed -i s/a/b/ src/a.ts', () => { writeFileSync(fx.src('a.ts'), 'bbbb'); utimesSync(fx.src('a.ts'), atime, mtime); });
  writeFileSync(fx.src('b.ts'), 'same');
  call(fx, 'cp tpl.ts src/b.ts', () => writeFileSync(fx.src('b.ts'), 'same'));
  assert.deepEqual(logged(fx), [fx.src('a.ts')]);
});

test('a FIFO named as a candidate is never opened: the hook answers, logs nothing and writes no line', { skip: POSIX_ONLY }, () => {
  const fx = fixture();
  execFileSync('mkfifo', [fx.src('p.ts')]);
  call(fx, 'echo x > src/p.ts');
  assert.deepEqual([logged(fx), outcomes(fx)], [[], []]);
});

test('hostile names run nothing and never reach a guard-log reason', () => {
  const fx = fixture();
  call(fx, 'echo x > "src/-a.ts"; echo x > src/$(touch PWNED).ts; echo x > "src/`touch PWNED2`.ts"', () => writeFileSync(fx.src('-a.ts'), 'x'));
  assert.deepEqual(logged(fx), [fx.src('-a.ts')]);
  assert.deepEqual([existsSync(join(fx.project, 'PWNED')), existsSync(join(fx.project, 'PWNED2')), existsSync(join(fx.project, 'src', 'PWNED'))], [false, false, false]);
});

test('the contract: input that is not JSON, another event or tool, a Monitor command: exit 0, nothing printed, nothing kept', () => {
  const fx = fixture();
  send(fx, 'not json');
  send(fx, { hook_event_name: 'Stop' });
  send(fx, { hook_event_name: 'PreToolUse', tool_name: 'Monitor', tool_use_id: 'm1', tool_input: { command: 'echo x > src/a.ts' } });
  send(fx, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: fx.src('a.ts') } });
  send(fx, { hook_event_name: 'PreToolUse', tool_use_id: 'n1', tool_input: { command: 42 } });
  assert.deepEqual([logged(fx), outcomes(fx), records(fx)], [[], [], []]);
});

test('an exception inside the hook writes one bash-writes-error line with its class, and still exits 0 silently', () => {
  const fx = fixture();
  mkdirSync(join(fx.tmp, ROOT), { recursive: true });
  writeFileSync(join(fx.tmp, ROOT, 'bash-writes'), 'not a folder');
  call(fx, 'echo x > src/a.ts', () => {}, { after: null });
  assert.deepEqual(guardLines(fx).map((line) => [line.hook, line.outcome, /^\w*Error\b/.test(line.reason)]), [['bash-writes', 'bash-writes-error', true]]);
});
