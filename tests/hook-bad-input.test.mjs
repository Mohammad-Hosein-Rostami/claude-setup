// Fail-safe table for hook input that is not hook JSON (not JSON, empty, cut, a JSON value of another kind, 1.5 MiB, invalid UTF-8):
// home/hooks/disk-clean-start.mjs and home/hooks/git-tidy-gate.mjs exit 0 with empty stdout and stderr, and disk-clean-start starts no
// clean-up (no stamp, no log, its stub tool never runs; a real startup input is the control that it does). post-edit.mjs, which is no
// gate, exits 0 and prints nothing too. Every hook runs with a cs-test temp HOME and temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';

const hookPath = (name) => fileURLToPath(new URL(`../home/hooks/${name}`, import.meta.url));
const MIB = 1024 * 1024;
const START_WAIT_MS = 10_000; // the detached clean-up of a loaded machine
const POLL_MS = 20;
const BAD_INPUTS = [
  ['not json', 'not json'],
  ['empty', ''],
  ['cut object', '{'],
  ['null', 'null'],
  ['array', '[]'],
  ['string', '"str"'],
  ['event of the wrong type', '{"hook_event_name":5}'],
  ['1.5 MiB of a', 'a'.repeat(1.5 * MIB)],
  ['invalid UTF-8', Buffer.from([0xff, 0xfe, 0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d])],
];
// Our variables the runner's own session may hold; a hook run must not see them.
const OUR_VARIABLES = ['CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'DISK_CLEAN_TOOL', 'CLAUDE_CONFIG_DIR'];

/** A temp home and temp folder, and the env of a hook run in them; `extra` is added on top. */
function sandbox(extra = {}) {
  const home = makeTempDir('hook-bad-input-');
  const tmp = join(home, 'tmp');
  mkdirSync(tmp);
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_') && !OUR_VARIABLES.includes(name)));
  const env = { ...base, HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp, DISK_FREE_CLAUDE_TMP: join(tmp, 'claude-tmp'), CLAUDE_GUARD_LOG: join(home, 'guard.jsonl'), ...extra };
  return { home, tmp, env };
}

/** Runs hook `name` once with `input` on stdin, in the sandbox folder. */
const runHook = (name, input, box) => spawnSync(process.execPath, [hookPath(name)], { input, env: box.env, cwd: box.tmp, encoding: 'utf8' });

/** A stub clean-up tool that only records that it started (in `started` under the home folder). */
function stubTool(home) {
  const tool = join(home, 'stub-clean.mjs');
  writeFileSync(tool, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(home, 'started'))}, JSON.stringify(process.argv.slice(2)));\n`);
  return tool;
}

/** True once `path` exists, false when it does not within START_WAIT_MS. */
async function appears(path) {
  const deadline = Date.now() + START_WAIT_MS;
  while (!existsSync(path) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  return existsSync(path);
}

const stampOf = (home) => join(home, '.claude', 'state', 'disk-clean.stamp');
const logOf = (home) => join(home, '.claude', 'logs', 'disk-clean.log');

test('disk-clean-start: input that is not hook JSON exits 0 silently and starts no clean-up (no stamp, no log, the tool never runs)', async () => {
  const boxes = [];
  for (const [what, input] of BAD_INPUTS) {
    const box = sandbox();
    box.env.DISK_CLEAN_TOOL = stubTool(box.home);
    const run = runHook('disk-clean-start.mjs', input, box);
    assert.deepEqual([run.status, run.stdout, run.stderr], [0, '', ''], what);
    assert.deepEqual([existsSync(stampOf(box.home)), existsSync(logOf(box.home))], [false, false], `${what}: a clean-up was started`);
    boxes.push([what, box]);
  }
  // A clean-up the hook had started would write its marker shortly after the hook exits: look once all runs are done.
  const control = sandbox();
  control.env.DISK_CLEAN_TOOL = stubTool(control.home);
  runHook('disk-clean-start.mjs', JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'bad-input-control' }), control);
  assert.equal(await appears(join(control.home, 'started')), true, 'control: a real startup input starts the stub clean-up');
  for (const [what, box] of boxes) assert.equal(existsSync(join(box.home, 'started')), false, `${what}: the stub clean-up ran`);
});

test('git-tidy-gate: input that is not hook JSON exits 0 with empty stdout and stderr', () => {
  const box = sandbox();
  for (const [what, input] of BAD_INPUTS) {
    const run = runHook('git-tidy-gate.mjs', input, box);
    assert.deepEqual([run.status, run.stdout, run.stderr], [0, '', ''], what);
  }
});

test('post-edit: input that is not hook JSON exits 0 and prints nothing', () => {
  const box = sandbox();
  for (const [what, input] of BAD_INPUTS) {
    const run = runHook('post-edit.mjs', input, box);
    assert.deepEqual([run.status, run.stdout, run.stderr], [0, '', ''], what);
  }
});
