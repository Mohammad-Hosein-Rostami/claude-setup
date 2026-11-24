// Tests of the job file (spec 6, 14 "odd input"): defaults, the no-Fable rule, prompt files (inside the job folder, UTF-8, size,
// not empty), ids, folders, `next` targets, and the reload rule of an edited job.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_MODEL, JobError, loadJob, reloadChanges } from '../home/tools/long-run/lib/job.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

function jobDir() {
  const dir = makeTempDir('long-run-job-');
  mkdirSync(join(dir, 'repo'));
  return dir;
}

const write = (dir, job) => {
  const path = join(dir, 'job.json');
  writeFileSync(path, JSON.stringify(job));
  return path;
};
const base = (dir, steps, extra = {}) => ({ name: 'job', cwd: join(dir, 'repo'), steps, ...extra });
const problems = (fn) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof JobError) return error.problems.join('\n');
    throw error;
  }
  assert.fail('the job was accepted');
};

test('defaults: model claude-opus-5-5, no effort, loop guards 3 / 10, retry 60 s x4 max 1800 s, 3 at once, 3 visits, no step timeout', () => {
  const dir = jobDir();
  const { job } = loadJob(write(dir, base(dir, [{ id: 'one', prompt: 'One.' }])));
  assert.equal(DEFAULT_MODEL, 'claude-opus-5-5');
  assert.equal(job.steps[0].model, 'claude-opus-5-5');
  assert.equal(job.steps[0].effort, null);
  assert.deepEqual(job.loopGuards, { maxAttempts: 3, maxStarts: 10 });
  assert.deepEqual(job.retry, { firstDelaySeconds: 60, factor: 4, maxDelaySeconds: 1800 });
  assert.deepEqual([job.maxParallel, job.steps[0].maxVisits, job.stepTimeoutMinutes], [3, 3, null]);
});

test('Fable is refused in the job, a step and an item, as an alias or a full id', () => {
  const dir = jobDir();
  assert.match(problems(() => loadJob(write(dir, base(dir, [{ id: 'one', prompt: 'x' }], { model: 'fable' })))), /Fable is never used/);
  assert.match(problems(() => loadJob(write(dir, base(dir, [{ id: 'one', prompt: 'x', model: 'claude-fable-5' }])))), /Fable is never used/);
  const group = { id: 'g', parallel: [{ id: 'a', prompt: 'x', model: 'Claude-FABLE-1' }, { id: 'b', prompt: 'y', cwd: dir }] };
  assert.match(problems(() => loadJob(write(dir, base(dir, [group])))), /Fable is never used/);
  assert.match(problems(() => loadJob(write(dir, base(dir, [{ id: 'one', prompt: 'x', model: 'gpt-5' }])))), /a model is opus, sonnet, haiku/);
  assert.equal(loadJob(write(dir, base(dir, [{ id: 'one', prompt: 'x', model: 'sonnet' }]))).job.steps[0].model, 'sonnet');
});

test('prompt files: relative inside the job folder, CRLF kept, 100 KB allowed; .., a link out, non-UTF-8, empty and over 100 KB refused', () => {
  const dir = jobDir();
  writeFileSync(join(dir, 'crlf.md'), 'line one\r\nline two\r\n');
  writeFileSync(join(dir, 'big.md'), 'x'.repeat(100 * 1024));
  writeFileSync(join(dir, 'huge.md'), 'x'.repeat(100 * 1024 + 1));
  writeFileSync(join(dir, 'latin1.md'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  writeFileSync(join(dir, 'blank.md'), '  \n');
  const outside = makeTempDir('long-run-out-');
  writeFileSync(join(outside, 'secret.md'), 'outside');
  symlinkSync(join(outside, 'secret.md'), join(dir, 'link.md'));
  const one = (promptFile) => base(dir, [{ id: 'one', promptFile }]);
  assert.equal(loadJob(write(dir, one('crlf.md'))).job.steps[0].prompt, 'line one\r\nline two\r\n');
  assert.equal(loadJob(write(dir, one('big.md'))).job.steps[0].prompt.length, 100 * 1024);
  assert.match(problems(() => loadJob(write(dir, one('huge.md')))), /over 102400 bytes/);
  assert.match(problems(() => loadJob(write(dir, one('../x.md')))), /without \.\./);
  assert.match(problems(() => loadJob(write(dir, one('link.md')))), /leads out of the job folder/);
  assert.match(problems(() => loadJob(write(dir, one('latin1.md')))), /promptFile latin1\.md/);
  assert.match(problems(() => loadJob(write(dir, one('blank.md')))), /the prompt is empty/);
  assert.match(problems(() => loadJob(write(dir, base(dir, [{ id: 'one', prompt: 'a', promptFile: 'big.md' }])))), /exactly one of prompt and promptFile/);
});

test('odd input: no steps, an empty prompt, bad or repeated ids, a missing folder, an unknown next target, cmd characters on win32', () => {
  const dir = jobDir();
  assert.match(problems(() => loadJob(write(dir, base(dir, [])))), /steps/);
  assert.match(problems(() => loadJob(write(dir, base(dir, [{ id: 'one', prompt: '' }])))), /the prompt is empty/);
  assert.match(problems(() => loadJob(write(dir, base(dir, [{ id: 'One!', prompt: 'x' }])))), /an id is 1-40/);
  assert.match(problems(() => loadJob(write(dir, base(dir, [{ id: 'a', prompt: 'x' }, { id: 'a', prompt: 'y' }])))), /unique across steps and items: a/);
  assert.match(problems(() => loadJob(write(dir, { ...base(dir, [{ id: 'a', prompt: 'x' }]), cwd: join(dir, 'gone') }))), /is not a folder/);
  assert.match(problems(() => loadJob(write(dir, base(dir, [{ id: 'a', prompt: 'x', next: { failed: 'nowhere' } }])))), /next\.failed names no step: nowhere/);
  const odd = join(dir, 'a&b');
  mkdirSync(odd);
  assert.match(problems(() => loadJob(write(dir, { ...base(dir, [{ id: 'a', prompt: 'x' }]), cwd: odd }), { platform: 'win32' })), /may not hold/);
  assert.match(problems(() => loadJob(write(dir, { ...base(dir, [{ id: 'a', prompt: 'x' }]), account: 'a' }))), /Unrecognized key/);
});

test('reload: unfinished prompt changes are listed; a finished step that changed its place or kind is refused', () => {
  const dir = jobDir();
  const old = loadJob(write(dir, base(dir, [{ id: 'one', prompt: 'One.' }, { id: 'two', prompt: 'Two.' }]))).job;
  const edited = loadJob(write(dir, base(dir, [{ id: 'one', prompt: 'One.' }, { id: 'two', prompt: 'Two, better.' }]))).job;
  assert.deepEqual(reloadChanges(old, edited, new Set(['one'])), ['two']);
  const moved = loadJob(write(dir, base(dir, [{ id: 'two', prompt: 'Two.' }, { id: 'one', prompt: 'One.' }]))).job;
  assert.throws(() => reloadChanges(old, moved, new Set(['one'])), /step one is finished/);
});

test('a folder written ~/... is the same folder under the home folder; ~user is not expanded', () => {
  const dir = jobDir();
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  try {
    const { job } = loadJob(write(dir, { name: 'job', cwd: '~/repo', steps: [{ id: 'one', prompt: 'x', cwd: '~' }] }));
    assert.equal(job.cwd, join(dir, 'repo'));
    assert.equal(job.steps[0].cwd, dir);
    assert.match(problems(() => loadJob(write(dir, { name: 'job', cwd: '~other/repo', steps: [{ id: 'one', prompt: 'x' }] }))), /cwd must be an absolute path/);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
