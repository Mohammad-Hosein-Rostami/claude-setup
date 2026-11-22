// Tests for home/hooks/session-notes.mjs (the hook that printed the setup modes until they were removed; the file keeps its old
// name): the lead rules at every SessionStart, the compaction notes, settings never written, unsafe ids (node:test, no dependencies).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isStale } from '../home/hooks/lib/state-files.mjs';
import { LEAD_RULES_MAX_BYTES } from '../home/hooks/session-notes.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

test('isStale flips after 14 days', () => {
  const now = Date.now();
  assert.equal(isStale(now - 13 * MS_PER_DAY, now), false);
  assert.equal(isStale(now - 15 * MS_PER_DAY, now), true);
});

const HOOK = fileURLToPath(new URL('../home/hooks/session-notes.mjs', import.meta.url));

function runHook(home, env, input) {
  return spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), env: { ...process.env, HOME: home, USERPROFILE: home, ...env }, encoding: 'utf8' });
}

test('SessionStart leaves settings.json untouched', async () => {
  const home = makeTempDir('mode-home-');
  await mkdir(join(home, '.claude'), { recursive: true });
  const settings = join(home, '.claude', 'settings.json');
  const original = '{"a":1,\n"b":[2]}\n';
  await writeFile(settings, original);
  const start = runHook(home, {}, { hook_event_name: 'SessionStart', session_id: 's1', source: 'startup' });
  assert.equal(start.status, 0);
  assert.equal(await readFile(settings, 'utf8'), original);
  assert.doesNotMatch(start.stdout, /fast/i);
});

test('compact adds the recall line, and the handoff line from the 3rd compaction on', async () => {
  const home = makeTempDir('mode-home-');
  const compact = (id) => runHook(home, { CLAUDE_MODE: 'high' }, { hook_event_name: 'SessionStart', session_id: id, source: 'compact' }).stdout;
  assert.match(compact('k1'), /Context was compacted.*recall .*--session current.*select:Monitor,SendMessage,TaskStop/);
  assert.match(compact('k3'), /Re-read `## Standing rules`; backfill it with `recall --owner --session current`/);
  assert.doesNotMatch(compact('k1'), /has compacted/);
  assert.match(compact('k1'), /This session has compacted 3 times.*`handoff` skill/);
  assert.match(compact('k1'), /compacted 4 times/);
  assert.doesNotMatch(compact('k2'), /has compacted/); // counted per session
  const startup = runHook(home, { CLAUDE_MODE: 'high' }, { hook_event_name: 'SessionStart', session_id: 'k3', source: 'startup' }).stdout;
  assert.doesNotMatch(startup, /Context was compacted/);
});

test('an unsafe session_id is never used as a file name', async () => {
  const home = makeTempDir('mode-home-');
  const transcript = join(home, 'transcript.jsonl');
  const usage = { input_tokens: 90_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }; // over the big-context line's 60k
  await writeFile(transcript, `${JSON.stringify({ type: 'assistant', message: { usage, content: [] } })}\n`);
  const compacted = runHook(home, {}, { hook_event_name: 'SessionStart', session_id: '../evil', source: 'compact', transcript_path: transcript });
  const prompted = runHook(home, {}, { hook_event_name: 'UserPromptSubmit', session_id: '../evil', prompt: 'x'.repeat(500), transcript_path: transcript });
  assert.equal(compacted.status, 0);
  assert.equal(prompted.status, 0);
  for (const name of ['evil', 'evil.compacts', 'evil.bigctx']) {
    await assert.rejects(readFile(join(home, '.claude', 'state', name), 'utf8'), undefined, name);
    await assert.rejects(readFile(join(home, '.claude', 'state', 'modes', '..', name), 'utf8'), undefined, name);
  }
});

/** A temp HOME whose ~/.claude/lead-rules.md holds `text`; none when `text` is undefined. */
async function homeWithLeadRules(text) {
  const home = makeTempDir('mode-lead-');
  await mkdir(join(home, '.claude'), { recursive: true });
  if (text !== undefined) await writeFile(join(home, '.claude', 'lead-rules.md'), text);
  return home;
}

test('SessionStart prints lead-rules.md first', async () => {
  const home = await homeWithLeadRules('# Lead rules\nLEAD-MARK\n');
  const out = runHook(home, {}, { hook_event_name: 'SessionStart', session_id: 'l-start', source: 'startup' }).stdout;
  assert.match(out, /^# Lead rules\nLEAD-MARK/);
  assert.doesNotMatch(out, /^Mode: /m);
});

test('SessionStart without lead-rules.md prints no lead text and does not fail', async () => {
  const home = await homeWithLeadRules(undefined);
  const result = runHook(home, {}, { hook_event_name: 'SessionStart', session_id: 'l-none', source: 'startup' });
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /Lead rules|LEAD-MARK|^Mode: /m);
  assert.doesNotMatch(result.stderr, /lead-rules\.md/);
});

// SA3 (P1): a FIFO at lead-rules.md held the hook past its 5 s timeout, so Claude Code dropped the whole SessionStart output.
const FIFO_WAIT_MS = 3000; // well under the hook's 5,000 ms timeout; a hook that waits on the FIFO is killed here

test('a FIFO at lead-rules.md, or a link to one, is not read: the hook ends at once and prints no lead text', async () => {
  const home = await homeWithLeadRules(undefined);
  const fifo = join(home, 'pipe');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0, 'mkfifo made the FIFO');
  for (const plant of ['fifo', 'link']) {
    const rules = join(home, '.claude', 'lead-rules.md');
    await rm(rules, { force: true });
    if (plant === 'fifo') assert.equal(spawnSync('mkfifo', [rules]).status, 0);
    else await symlink(fifo, rules);
    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: `fifo-${plant}`, source: 'compact' }),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
      timeout: FIFO_WAIT_MS,
    });
    assert.equal(result.signal, null, `${plant}: the hook did not wait on the FIFO`);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /recall/, `${plant}: the compact notes still print`);
    assert.match(result.stderr, /lead-rules\.md/, `${plant}: the refused file is reported on stderr`);
  }
});

test('lead-rules.md as an install link to a regular file prints it; a file over the cap prints no lead text', async () => {
  const home = await homeWithLeadRules(undefined);
  const repoFile = join(home, 'repo-lead-rules.md');
  await writeFile(repoFile, 'LINKED-LEAD-MARK\n');
  await symlink(repoFile, join(home, '.claude', 'lead-rules.md'));
  const linked = runHook(home, {}, { hook_event_name: 'SessionStart', session_id: 'l-link', source: 'startup' });
  assert.match(linked.stdout, /^LINKED-LEAD-MARK/);
  await writeFile(repoFile, `HUGE-MARK\n${'x'.repeat(LEAD_RULES_MAX_BYTES)}`);
  const huge = runHook(home, {}, { hook_event_name: 'SessionStart', session_id: 'l-huge', source: 'startup' });
  assert.equal(huge.status, 0);
  assert.doesNotMatch(huge.stdout, /HUGE-MARK/);
  assert.match(huge.stderr, /lead-rules\.md/);
});

test('mode.mjs stays within the 300-line file limit', async () => {
  assert.ok((await readFile(HOOK, 'utf8')).split('\n').length <= 300);
});

test('SessionStart prints lead-rules.md for resume, clear and compact too (it re-fires on each)', async () => {
  const home = await homeWithLeadRules('LEAD-MARK\n');
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    const out = runHook(home, {}, { hook_event_name: 'SessionStart', session_id: `src-${source}`, source }).stdout;
    assert.match(out, /^LEAD-MARK/, source);
  }
});
