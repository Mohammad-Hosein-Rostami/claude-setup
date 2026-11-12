// Tests for home/hooks/mode.mjs: pure helpers and the per-session guarantee (node:test, no dependencies).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findOwnerPid, isMode, isStale, leadNote, parseModeArg } from '../home/hooks/mode.mjs';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

test('parseModeArg takes the first word, lowercased', () => {
  assert.equal(parseModeArg('  HIGH now'), 'high');
  assert.equal(parseModeArg(''), '');
  assert.equal(parseModeArg(undefined), '');
});

test('parseModeArg joins words into extra-high / ultra-high and ignores case', () => {
  assert.equal(parseModeArg('extra high'), 'extra-high');
  assert.equal(parseModeArg('  Extra   HIGH '), 'extra-high');
  assert.equal(parseModeArg('ULTRA-HIGH'), 'ultra-high');
  assert.equal(parseModeArg('high extra'), 'high');
});

test('isMode accepts only the five modes', () => {
  assert.ok(['normal', 'medium', 'high', 'extra-high', 'ultra-high'].every(isMode));
  assert.ok(!isMode('bogus') && !isMode(undefined) && !isMode(''));
});

test('isStale flips after 14 days', () => {
  const now = Date.now();
  assert.equal(isStale(now - 13 * MS_PER_DAY, now), false);
  assert.equal(isStale(now - 15 * MS_PER_DAY, now), true);
});

test('leadNote: model mismatch at session start asks for the ccm launch line', () => {
  assert.match(leadNote({ mode: 'extra-high', model: 'claude-sonnet-5-5' }), /`ccm extra-high -c`.*Opus 5\.5 at max effort.*avoid `\/model`/);
  assert.match(leadNote({ mode: 'ultra-high', model: 'claude-opus-5-5' }), /`ccm ultra-high -c`.*Fable 5\.2 at max effort/);
});

test('leadNote: a matching or unknown model at session start says nothing', () => {
  assert.equal(leadNote({ mode: 'extra-high', model: 'claude-opus-5-5' }), '');
  assert.equal(leadNote({ mode: 'ultra-high', model: 'claude-fable-5-2' }), '');
  assert.equal(leadNote({ mode: 'ultra-high' }), '');
  assert.equal(leadNote({ mode: 'extra-high', model: 'claude-opus-5-5', launchedAs: 'extra-high' }), '');
});

test('leadNote: a /mode switch into a lead mode always notes, even without a model', () => {
  assert.match(leadNote({ mode: 'extra-high', previousMode: 'high' }), /`ccm extra-high -c`/);
  assert.match(leadNote({ mode: 'ultra-high', previousMode: 'extra-high' }), /`ccm ultra-high -c`/);
  assert.equal(leadNote({ mode: 'extra-high', previousMode: 'extra-high' }), '');
});

test('leadNote: switching down from a lead mode says the lead is still at max', () => {
  assert.match(leadNote({ mode: 'high', previousMode: 'extra-high' }), /still Opus 5\.5 at max.*`ccm high -c`.*Opus 5\.5 at high/);
  assert.match(leadNote({ mode: 'medium', previousMode: 'ultra-high' }), /still Fable 5\.2 at max.*`ccm medium -c`/);
});

test('leadNote: normal, medium and high never produce a note', () => {
  assert.equal(leadNote({ mode: 'high', model: 'claude-sonnet-5-5' }), '');
  assert.equal(leadNote({ mode: 'normal', previousMode: 'medium' }), '');
  assert.equal(leadNote({ mode: 'medium', previousMode: 'high' }), '');
});

const HOOK = fileURLToPath(new URL('../home/hooks/mode.mjs', import.meta.url));

function runHook(home, env, input) {
  return spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), env: { ...process.env, HOME: home, USERPROFILE: home, ...env }, encoding: 'utf8' });
}

test('SessionStart and /mode leave settings.json untouched and record only the session state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mode-home-'));
  await mkdir(join(home, '.claude'), { recursive: true });
  const settings = join(home, '.claude', 'settings.json');
  const original = '{"a":1,\n"b":[2]}\n';
  await writeFile(settings, original);
  const start = runHook(home, { CLAUDE_MODE: 'high' }, { hook_event_name: 'SessionStart', session_id: 's1', source: 'startup' });
  const switched = runHook(home, { CLAUDE_MODE: 'high' }, { hook_event_name: 'UserPromptExpansion', session_id: 's1', command_name: 'mode', command_args: 'normal' });
  assert.equal(await readFile(settings, 'utf8'), original);
  assert.equal((await readFile(join(home, '.claude', 'state', 'modes', 's1'), 'utf8')).trim(), 'normal');
  assert.match(switched.stdout, /Mode switched to normal \(this session only\)\./);
  assert.doesNotMatch(start.stdout + switched.stdout, /fast/i);
});

test('findOwnerPid walks up to the claude process', () => {
  const tree = { 30: { ppid: 20, command: '/bin/sh' }, 20: { ppid: 10, command: '/Users/x/.local/bin/claude' } };
  assert.equal(findOwnerPid(30, (pid) => tree[pid]), 20);
});

test('findOwnerPid gives up without a claude ancestor or on lookup failure', () => {
  const tree = { 30: { ppid: 20, command: 'sh' }, 20: { ppid: 1, command: 'login' } };
  assert.equal(findOwnerPid(30, (pid) => tree[pid]), undefined);
  assert.equal(findOwnerPid(30, () => undefined), undefined);
});

// The process-keyed state needs a `claude` ancestor (true when the suite runs inside Claude Code).
function hasClaudeAncestor() {
  if (process.platform === 'win32') return false;
  const lookup = (pid) => {
    const out = spawnSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
    const match = /^(\d+)\s+(.+)$/.exec(out);
    return match ? { ppid: Number(match[1]), command: match[2] } : undefined;
  };
  return findOwnerPid(process.pid, lookup) !== undefined;
}

test('a mode set with /mode survives /clear (new session id, same process) but not a new process', { skip: !hasClaudeAncestor() && 'no claude ancestor process' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'mode-home-'));
  const env = { CLAUDE_MODE: 'medium' };
  runHook(home, env, { hook_event_name: 'UserPromptExpansion', session_id: 'a1', command_name: 'mode', command_args: 'high' });
  const afterClear = runHook(home, env, { hook_event_name: 'SessionStart', session_id: 'a2', source: 'clear' });
  const freshProcess = runHook(home, env, { hook_event_name: 'SessionStart', session_id: 'b1', source: 'startup' });
  const resumed = runHook(home, env, { hook_event_name: 'UserPromptSubmit', session_id: 'a1' });
  assert.match(afterClear.stdout, /^Mode: high/);
  assert.match(freshProcess.stdout, /^Mode: medium/);
  assert.match(resumed.stdout, /Mode: high/);
});


test('a resumed session keeps its saved mode unless launched with an explicit mode', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mode-home-'));
  const start = (env, id, source) => runHook(home, env, { hook_event_name: 'SessionStart', session_id: id, source }).stdout;
  start({ CLAUDE_MODE: 'high' }, 'r1', 'startup');
  assert.match(start({ CLAUDE_MODE: '' }, 'r1', 'resume'), /^Mode: high/);
  assert.match(start({ CLAUDE_MODE: 'normal' }, 'r1', 'resume'), /^Mode: normal/);
  assert.match(start({ CLAUDE_MODE: '' }, 'r1', 'resume'), /^Mode: normal/);
  assert.match(start({ CLAUDE_MODE: '' }, 'unknown', 'resume'), /^Mode: medium/);
});

test('compact keeps the session mode over the launch env', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mode-home-'));
  runHook(home, { CLAUDE_MODE: 'high' }, { hook_event_name: 'UserPromptExpansion', session_id: 'c1', command_name: 'mode', command_args: 'normal' });
  const compacted = runHook(home, { CLAUDE_MODE: 'high' }, { hook_event_name: 'SessionStart', session_id: 'c1', source: 'compact' });
  assert.match(compacted.stdout, /^Mode: normal/);
});

test('/mode reports a failed save instead of claiming the switch', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mode-home-'));
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude', 'state'), 'not a directory');
  const out = runHook(home, {}, { hook_event_name: 'UserPromptExpansion', session_id: 'f1', command_name: 'mode', command_args: 'high' });
  assert.match(out.stdout, /Mode NOT switched/);
  assert.equal(out.status, 0);
});

test('an unsafe session_id is never used as a file name', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mode-home-'));
  const out = runHook(home, {}, { hook_event_name: 'UserPromptExpansion', session_id: '../evil', command_name: 'mode', command_args: 'high' });
  assert.match(out.stdout, /Mode NOT switched/);
  await assert.rejects(readFile(join(home, '.claude', 'state', 'evil'), 'utf8'));
  await assert.rejects(readFile(join(home, '.claude', 'state', 'modes', '..', 'evil'), 'utf8'));
});

test('/mode ultra-high writes the state and prints the playbook and the lead note', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mode-home-'));
  const out = runHook(home, { CLAUDE_MODE: 'medium' }, { hook_event_name: 'UserPromptExpansion', session_id: 'u1', command_name: 'mode', command_args: 'ultra high' });
  assert.equal((await readFile(join(home, '.claude', 'state', 'modes', 'u1'), 'utf8')).trim(), 'ultra-high');
  assert.match(out.stdout, /Mode switched to ultra-high \(this session only\)\./);
  assert.match(out.stdout, /`ccm ultra-high -c`/);
});

test('SessionStart adds the lead note only when the session model mismatches', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mode-home-'));
  const start = (model) => runHook(home, { CLAUDE_MODE: 'extra-high' }, { hook_event_name: 'SessionStart', session_id: 'm1', source: 'startup', model }).stdout;
  assert.match(start('claude-sonnet-5-5'), /^Mode: extra-high[\s\S]*`ccm extra-high -c`/);
  assert.doesNotMatch(start('claude-opus-5-5'), /ccm extra-high -c/);
});

test('leadNote: a lead mode resumed without `ccm <mode>` asks for the launch line (effort is not visible)', () => {
  assert.match(leadNote({ mode: 'extra-high', model: 'claude-opus-5-5', launchedAs: '' }), /`ccm extra-high -c`/);
  assert.match(leadNote({ mode: 'ultra-high', model: 'claude-fable-5-2', launchedAs: 'high' }), /`ccm ultra-high -c`/);
});

test('leadNote: switching back into the mode this window was launched in needs no note', () => {
  assert.equal(leadNote({ mode: 'extra-high', previousMode: 'high', launchedAs: 'extra-high' }), '');
  assert.match(leadNote({ mode: 'extra-high', previousMode: 'high', launchedAs: 'high' }), /`ccm extra-high -c`/);
});

test('UserPromptSubmit does not spawn `ps` when the session file answers', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mode-lazy-'));
  const emptyBin = await mkdtemp(join(tmpdir(), 'mode-nobin-'));
  await mkdir(join(home, '.claude', 'state', 'modes'), { recursive: true });
  await writeFile(join(home, '.claude', 'state', 'modes', 's2'), 'high\n');
  const result = runHook(home, { PATH: emptyBin }, { hook_event_name: 'UserPromptSubmit', session_id: 's2' });
  assert.match(result.stdout, /Mode: high/);
  assert.doesNotMatch(result.stderr, /ps failed/); // without lazy lookup, a missing `ps` would be reported here
});

async function homeWithModes(files) {
  const home = await mkdtemp(join(tmpdir(), 'mode-lead-'));
  await mkdir(join(home, '.claude', 'modes'), { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(home, '.claude', 'modes', name), text);
  return home;
}

test('SessionStart prints _lead.md before the playbook, in every mode including medium', async () => {
  const home = await homeWithModes({ '_lead.md': '# Lead rules\nLEAD-MARK\n', 'medium.md': 'MEDIUM-PLAYBOOK\n', 'high.md': 'HIGH-PLAYBOOK\n' });
  for (const [mode, playbook] of [['medium', 'MEDIUM-PLAYBOOK'], ['high', 'HIGH-PLAYBOOK']]) {
    const out = runHook(home, { CLAUDE_MODE: mode }, { hook_event_name: 'SessionStart', session_id: `l-${mode}`, source: 'startup' }).stdout;
    assert.match(out, new RegExp(`^Mode: ${mode}`));
    assert.ok(out.indexOf('LEAD-MARK') > -1 && out.indexOf('LEAD-MARK') < out.indexOf(playbook), `${mode}: lead rules must precede the playbook`);
  }
});

test('SessionStart without _lead.md prints only the playbook and does not fail', async () => {
  const home = await homeWithModes({ 'medium.md': 'MEDIUM-PLAYBOOK\n' });
  const result = runHook(home, { CLAUDE_MODE: '' }, { hook_event_name: 'SessionStart', session_id: 'l-none', source: 'startup' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Mode: medium \(launched as default\)\n\nMEDIUM-PLAYBOOK/);
  assert.doesNotMatch(result.stderr, /_lead\.md/);
});

test('a /mode switch does not re-print _lead.md', async () => {
  const home = await homeWithModes({ '_lead.md': 'LEAD-MARK\n', 'high.md': 'HIGH-PLAYBOOK\n' });
  const out = runHook(home, {}, { hook_event_name: 'UserPromptExpansion', session_id: 'l-sw', command_name: 'mode', command_args: 'high' }).stdout;
  assert.match(out, /HIGH-PLAYBOOK/);
  assert.doesNotMatch(out, /LEAD-MARK/);
});

test('mode.mjs stays within the 300-line file limit', async () => {
  assert.ok((await readFile(HOOK, 'utf8')).split('\n').length <= 300);
});

test('SessionStart prints _lead.md for resume, clear and compact too (it re-fires on each)', async () => {
  const home = await homeWithModes({ '_lead.md': 'LEAD-MARK\n', 'medium.md': 'MEDIUM-PLAYBOOK\n' });
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    const out = runHook(home, { CLAUDE_MODE: 'medium' }, { hook_event_name: 'SessionStart', session_id: `src-${source}`, source }).stdout;
    assert.match(out, /LEAD-MARK[\s\S]*MEDIUM-PLAYBOOK/, source);
  }
});

// Hook output is injected into the lead's context; the CLI truncates large hook output, so the real files must fit.
const MAX_HOOK_OUTPUT_CHARS = 9000;

test('real _lead.md plus the longest playbook and a lead note stay under the hook output cap', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mode-size-'));
  await mkdir(join(home, '.claude'), { recursive: true });
  await cp(fileURLToPath(new URL('../home/modes', import.meta.url)), join(home, '.claude', 'modes'), { recursive: true });
  let longest = 0;
  for (const mode of ['normal', 'medium', 'high', 'extra-high', 'ultra-high']) {
    // A mismatched model forces the lead note into the output of the lead modes.
    const out = runHook(home, { CLAUDE_MODE: mode }, { hook_event_name: 'SessionStart', session_id: `size-${mode}`, source: 'startup', model: 'claude-haiku-5-5' }).stdout;
    longest = Math.max(longest, out.length);
    assert.match(out, /Lead|lead/, `${mode}: lead rules present`);
  }
  assert.ok(longest > 0 && longest <= MAX_HOOK_OUTPUT_CHARS, `longest SessionStart output is ${longest} chars`);
});
