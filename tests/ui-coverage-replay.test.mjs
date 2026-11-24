// T11: replay of a real two-day auth UI job. The fixture in fixtures/ui-coverage/replay-auth/ is the state that was handed
// to the owner as done: 4 template surfaces x en,fa at 1440 whose rest cells pass on probe evidence, 8 Figma frames of which
// 2 were never listed, 1 maps to no cell and 2 mapped ones have no compare record, 2 failing compares, and an accepted
// difference backed only by an ask-queue ref (a form no longer read). `check` must refuse it, naming each miss.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../home/tools/ui-coverage/ui-coverage.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/ui-coverage/replay-auth/', import.meta.url));

test('T11 the replayed auth job exits 1 with frame-missing, frame-unmapped, no-compare, owner-ref and frames: 0/8', () => {
  const run = spawnSync(process.execPath, [CLI, 'check', `${FIXTURE}matrix.json`, '--results', `${FIXTURE}results.json`, '--verbose'], { encoding: 'utf8' });
  assert.equal(run.status, 1, run.stdout);
  const lines = run.stdout.split('\n');
  assert.equal(lines[2], 'frames: 0/8 compared and passing, 0 accepted by the owner, 1 not built');
  const codes = (code) => lines.filter((line) => line.startsWith(`  [${code}]`));
  assert.equal(codes('frame-missing').length, 2);
  assert.match(codes('frame-missing').join('\n'), /Welcome email[\s\S]*Language dropdown sheet/);
  assert.equal(codes('frame-unmapped').length, 1);
  assert.equal(codes('no-compare').length, 2);
  assert.equal(codes('owner-ref').length, 1);
  assert.match(codes('owner-ref')[0], /owner\.ask is no longer read/, 'an ask queue ref is no owner decision');
  assert.equal(codes('fail').length, 2, 'the unaccepted difference and the pixel difference both still fail');
});
