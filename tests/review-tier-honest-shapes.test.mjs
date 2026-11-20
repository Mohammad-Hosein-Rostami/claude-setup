// Tests that review-tier's verified import carries every honest shape of history (lane r7-delta, fix round 5, spec check K9): each lane
// of tests/review-tier-shape-helpers.mjs is read with the exit code, file count and tier written here. The numbers are what the tool
// gave before the import existed (fix 4, c47b40d) on the same repositories: a differential run of both versions found every call equal
// but for the reading lines the start's attributes give back (S8). A shape the import cannot carry shows here as exit 2 or 1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { CLEAN_ENV } from './git-tidy-helpers.mjs';
import { CLI } from './review-tier-helpers.mjs';
import { HONEST_SHAPES } from './review-tier-shape-helpers.mjs';

const NOTHING_CHANGED = /nothing to review: .* holds no changed file/;
const NOT_UTF8 = /a changed path is not UTF-8 \(.*bytes 7372632f67ff74652e6d6a73\)/;
/** Per shape, per call in order: [files, tier], or the message of the exit 2 it must give. */
const EXPECTED = {
  'an octopus merge in the lane; range sides with ~ and ^': [[3, 1], [3, 1], [1, 1], [3, 1], [1, 1], [1, 1]],
  'a criss-cross lane with two merge bases': [[2, 1], [2, 1], [1, 1], [1, 1]],
  'the start is the root commit': [[1, 1], [1, 1], [1, 1]],
  'an empty commit in the lane and as the fix': [[2, 1], [1, 1], NOTHING_CHANGED],
  'a lane with only deletions': [[3, 1], [1, 1]],
  'a file becomes a symlink, another a folder, and back': [[2, 1], [3, 1]],
  'a submodule pointer added, bumped and removed': [[1, 1], [2, 1], [1, 1], [1, 1]],
  'attributes in a sub-folder of the start': [[1, 1], [1, 1]],
  'a range whose end is not HEAD': [[2, 2], [1, 1], [1, 1], [2, 2], [1, 0]],
  'a path that is not UTF-8': [NOT_UTF8, NOT_UTF8],
  'the composite lane (merge of main, rename with edit, mode, binary, space, submodule)': [[8, 2], [2, 2]],
  'the composite lane rebuilt on a moved main': [[8, 2], [8, 2], [8, 2]],
};

for (const shape of HONEST_SHAPES) {
  test(`an honest lane is read as before the import: ${shape.name}`, { skip: shape.posixOnly && process.platform === 'win32' && 'the shape needs a symlink' }, () => {
    const { dir, log, calls } = shape.build();
    const expected = EXPECTED[shape.name];
    assert.equal(calls.length, expected.length, 'every call of the shape has its expectation');
    calls.forEach((call, index) => {
      const result = spawnSync(process.execPath, [CLI, ...call.args], { cwd: dir, encoding: 'utf8', env: { ...CLEAN_ENV, REVIEW_TIER_LOG: log } });
      if (expected[index] instanceof RegExp) {
        assert.equal(result.status, 2, `${call.label}: ${result.stderr}`);
        assert.match(result.stderr, expected[index], call.label);
        return;
      }
      assert.equal(result.status, 0, `${call.label}: ${result.stderr}`);
      assert.equal(result.stderr, '', call.label);
      const report = JSON.parse(result.stdout);
      assert.deepEqual([report.files, report.tier], expected[index], call.label);
    });
  });
}

test('every shape of the list has an expectation, and no expectation is left without its shape', () => {
  assert.deepEqual(HONEST_SHAPES.map((shape) => shape.name).sort(), Object.keys(EXPECTED).sort());
});
