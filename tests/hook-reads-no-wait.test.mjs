// Tests that no hook read waits on a FIFO planted at a path that comes from hook input, a transcript or a state folder (row
// fu.hook-blocking-reads). Each case runs the read in a child process with a 2 s limit: a blocking open of a FIFO nobody writes
// never returns, so the child is killed and the case fails; a read through lib/plain-file.mjs returns at once.
// A stat-then-open site checked the path with stat first, so a plain FIFO was refused; the race it lost is a FIFO swapped in
// after that stat. The child replays the race by making statSync of the FIFO report a regular file (patched before the module
// loads; module.syncBuiltinESMExports carries the patch to named imports).
// POSIX only: Windows has no mkfifo and no FIFO file to block on.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { effectiveChannel } from '../home/hooks/lib/notify-note.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const ANSWER_WITHIN_MS = 2000;
const SKIP = process.platform === 'win32' ? 'no FIFO or mkfifo on Windows' : false;
const hookUrl = (name) => pathToFileURL(join(import.meta.dirname, '..', 'home', 'hooks', name)).href;
const hookPath = (name) => join(import.meta.dirname, '..', 'home', 'hooks', name);

// Runs before the module under test loads: statSync of $STAT_AS_FILE reports $STAT_REGULAR (the stat a swap came after).
const STAT_RACE = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const realStat = fs.statSync;
fs.statSync = (path, ...rest) => realStat(path === process.env.STAT_AS_FILE ? process.env.STAT_REGULAR : path, ...rest);
syncBuiltinESMExports();
`;

/** Runs `code` as an ES module in a child; fails the case when it has not ended within ANSWER_WITHIN_MS. Returns its stdout. */
function runChild(code, { env = {}, args = [], input = '' } = {}) {
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, ...args], {
    encoding: 'utf8', env: { ...process.env, ...env }, input, timeout: ANSWER_WITHIN_MS, killSignal: 'SIGKILL',
  });
  assert.equal(result.error?.code, undefined, `the read waited on the FIFO (${Date.now() - started} ms)`);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** A FIFO at `path` (its folder made first); nobody ever opens its other end. */
function makeFifo(path) {
  mkdirSync(join(path, '..'), { recursive: true });
  assert.equal(spawnSync('mkfifo', [path]).status, 0, 'mkfifo made the FIFO');
  return path;
}

/** A folder with a FIFO named `name` and a regular file `regular.txt` beside it. */
function fifoBox(label, name = 'pipe.jsonl') {
  const dir = makeTempDir(label);
  writeFileSync(join(dir, 'regular.txt'), 'regular\n');
  return { dir, fifo: makeFifo(join(dir, name)), regular: join(dir, 'regular.txt') };
}

const raceEnv = (box) => ({ STAT_AS_FILE: box.fifo, STAT_REGULAR: box.regular });

test('ask-gate readTranscriptTail refuses a FIFO transcript at once', { skip: SKIP }, () => {
  const { fifo } = fifoBox('ask-gate-');
  const code = `const { readTranscriptTail } = await import(${JSON.stringify(hookUrl('ask-gate.mjs'))});
try { readTranscriptTail(${JSON.stringify(fifo)}); console.log('read'); } catch (error) { console.log(error.code); }`;
  assert.equal(runChild(code), 'ENOTPLAIN');
});

test('agent-budget spawnCap refuses a FIFO agent transcript at once, and the stop check skips', { skip: SKIP }, () => {
  const { fifo } = fifoBox('agent-budget-');
  const code = `const { spawnCap, subagentStopReason } = await import(${JSON.stringify(hookUrl('agent-budget.mjs'))});
try { spawnCap(${JSON.stringify(fifo)}); console.log('read'); } catch (error) { console.log(error.code); }
console.log(subagentStopReason({ agent_id: 'a1', last_assistant_message: 'done', agent_transcript_path: ${JSON.stringify(fifo)} }));`;
  assert.equal(runChild(code), 'ENOTPLAIN\nnull');
});

test('gated-folder readHead and startFolder answer null for a FIFO swapped in after the stat', { skip: SKIP }, () => {
  const box = fifoBox('gated-folder-');
  const code = `${STAT_RACE}const { readHead, startFolder } = await import(${JSON.stringify(hookUrl('lib/gated-folder.mjs'))});
console.log(readHead(process.env.STAT_AS_FILE, 64), startFolder(process.env.STAT_AS_FILE));`;
  assert.equal(runChild(code, { env: raceEnv(box) }), 'null null');
});

test('writer-agents skips a project agent file that is a FIFO swapped in after the stat and reads the user one', { skip: SKIP }, () => {
  const project = makeTempDir('writer-agents-project-');
  const home = makeTempDir('writer-agents-home-');
  mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
  const regular = join(home, '.claude', 'agents', 'scout.md');
  writeFileSync(regular, '---\nname: scout\ntools: Read, Grep\n---\n');
  const fifo = makeFifo(join(project, '.claude', 'agents', 'scout.md'));
  const code = `${STAT_RACE}const { agentFileWrites } = await import(${JSON.stringify(hookUrl('lib/writer-agents.mjs'))});
console.log(agentFileWrites('scout', { HOME: ${JSON.stringify(home)}, CLAUDE_PROJECT_DIR: ${JSON.stringify(project)} }));`;
  assert.equal(runChild(code, { env: { STAT_AS_FILE: fifo, STAT_REGULAR: regular } }), 'false');
});

test('question-rejected watch reads nothing from a FIFO transcript and answers false at once', { skip: SKIP }, () => {
  const { fifo } = fifoBox('question-rejected-');
  const code = `const { watchTerminalRejection } = await import(${JSON.stringify(hookUrl('lib/question-rejected.mjs'))});
console.log(watchTerminalRejection(${JSON.stringify(fifo)})());`;
  assert.equal(runChild(code), 'false');
});

test('skill-router treats a FIFO at the session marker as unreadable and gives the full text at once', { skip: SKIP }, () => {
  const tmp = makeTempDir('skill-router-tmp-');
  makeFifo(join(tmp, 'claude-skill-router', 'prompt', 's1'));
  const result = spawnSync(process.execPath, [hookPath('skill-router.mjs')], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'build the signup form', session_id: 's1' }),
    encoding: 'utf8', env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp, CLAUDE_SKILL_ROUTER: '' },
    timeout: ANSWER_WITHIN_MS, killSignal: 'SIGKILL',
  });
  assert.equal(result.error?.code, undefined, 'the hook waited on the FIFO');
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /this request involves UI/);
});

test('skill-router skips a project ui-implementer file that is a FIFO swapped in after the stat', { skip: SKIP }, () => {
  const tmp = makeTempDir('skill-router-tmp-');
  const project = makeTempDir('skill-router-project-');
  const regular = join(project, 'regular.md');
  writeFileSync(regular, 'regular\n');
  const fifo = makeFifo(join(project, '.claude', 'agents', 'ui-implementer.md'));
  const event = { hook_event_name: 'PostToolUse', session_id: 's1', agent_id: 'a1', agent_type: 'ui-implementer', cwd: project,
    tool_input: { file_path: join(project, 'src', 'Page.tsx') } };
  const env = { STAT_AS_FILE: fifo, STAT_REGULAR: regular, TMPDIR: tmp, TEMP: tmp, TMP: tmp, CLAUDE_PROJECT_DIR: project, CLAUDE_SKILL_ROUTER: '' };
  const code = `${STAT_RACE}await import(${JSON.stringify(hookUrl('skill-router.mjs'))});`;
  assert.equal(runChild(code, { env, args: [hookPath('skill-router.mjs')], input: JSON.stringify(event) }), '');
});

test('post-edit reports a FIFO package.json as unreadable at once', { skip: SKIP }, () => {
  const dir = makeTempDir('post-edit-');
  makeFifo(join(dir, 'package.json'));
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  const code = `const { checkFile } = await import(${JSON.stringify(hookUrl('post-edit.mjs'))});
const [line] = await checkFile(${JSON.stringify(join(dir, 'a.ts'))});
console.log(line.startsWith('a.ts:1 HOOK unreadable package.json'));`;
  assert.equal(runChild(code), 'true');
});

for (const fifoName of ['results.json', 'ledger.json', 'matrix.json']) {
  test(`ui-proof-gate refuses a FIFO ${fifoName} at once and writes no record`, { skip: SKIP }, () => {
    const dir = makeTempDir('ui-proof-gate-');
    for (const name of ['results.json', 'ledger.json', 'matrix.json']) {
      if (name === fifoName) makeFifo(join(dir, name));
      else writeFileSync(join(dir, name), '{}');
    }
    const input = { cwd: dir, tool_input: { command: 'node ui-check/cli.mjs run --matrix matrix.json' },
      tool_response: { stdout: 'result: PASS run - 3 states - results results.json', stderr: '' } };
    const code = `const { recordRun } = await import(${JSON.stringify(hookUrl('ui-proof-gate.mjs'))});
try { await recordRun(${JSON.stringify(input)}); console.log('recorded'); } catch (error) { console.log(error.code); }`;
    assert.equal(runChild(code, { env: { HOME: dir, USERPROFILE: dir } }), 'ENOTPLAIN');
  });
}

test('notify-note reads no channel from a FIFO config swapped in after the stat and keeps the default', { skip: SKIP }, () => {
  const box = fifoBox('notify-note-', '.claude.json');
  const env = { HOME: box.dir, TERM_PROGRAM: 'iTerm.app' };
  const expected = effectiveChannel({ HOME: makeTempDir('notify-note-empty-'), TERM_PROGRAM: 'iTerm.app' });
  const code = `${STAT_RACE}const { effectiveChannel } = await import(${JSON.stringify(hookUrl('lib/notify-note.mjs'))});
console.log(effectiveChannel(${JSON.stringify(env)}));`;
  assert.equal(runChild(code, { env: raceEnv(box) }), expected);
});
