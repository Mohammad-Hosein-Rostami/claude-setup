// Tests for the default scope of `status.mjs rule` (owner decision OD-7, 2026-11-21): a rule added without `--scope` is tagged
// `always`; an explicit `--scope` is kept; a STATUS.md that already holds `job` or `project` tags still reads and is not rewritten.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runStatus } from '../home/tools/status/status.mjs';
import { parseRules } from '../home/tools/status/status-bullets.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const NOW = new Date('2026-11-22T10:00Z');
const OLD_TAGS = `# STATUS

## Standing rules
- old job rule {R1 2026-11-10 job}
- old project rule {R2 2026-11-11 project}

## Work items

| id | item | size | started | done | evidence |
| -- | ---- | ---- | ------- | ---- | -------- |
| 1 | first | S | - | - | - |
`;

async function project(text) {
  const cwd = makeTempDir('rule-scope-');
  const stateDir = makeTempDir('rule-scope-state-');
  await writeFile(join(cwd, 'STATUS.md'), text);
  const run = (...argv) => runStatus(argv, { cwd, now: NOW, stateDir });
  const read = () => readFile(join(cwd, 'STATUS.md'), 'utf8');
  return { run, read };
}

test('a rule without --scope is written as always', async () => {
  const { run, read } = await project(OLD_TAGS);
  assert.equal(run('rule', 'push only when asked').code, 0);
  assert.match(await read(), /- push only when asked \{R3 2026-11-22 always\}\n/);
});

test('an explicit --scope is kept', async () => {
  const { run, read } = await project(OLD_TAGS);
  assert.equal(run('rule', 'only this job', '--scope', 'job').code, 0);
  assert.match(await read(), /- only this job \{R3 2026-11-22 job\}\n/);
});

test('old job and project tags still read, and adding a rule leaves them as they were', async () => {
  const { run, read } = await project(OLD_TAGS);
  run('rule', 'new one');
  const text = await read();
  assert.deepEqual(parseRules(text).map((rule) => [rule.id, rule.scope, rule.active]), [['R1', 'job', true], ['R2', 'project', true], ['R3', 'always', true]]);
  assert.ok(text.includes('- old job rule {R1 2026-11-10 job}\n- old project rule {R2 2026-11-11 project}\n'));
});
