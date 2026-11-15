// Replays the finish estimate on two real tables of 14-15 Nov 2026 (tests/estimate-replay-cases.mjs) at the moments the owner
// asked, through the real CLI with TZ=Asia/Tehran and an empty transcript folder. Each case must print the exact Finish line
// of the L30 spec's replay table (A0/A1: as the follow-up round rule changed them), and the true delivery must lie inside the
// printed range, or before it for a case pinned as a recorded miss. A different line means the code differs from the spec's
// formula; never tune a constant to make a case pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, statusAt } from './estimate-replay-cases.mjs';

const CLI = fileURLToPath(new URL('../home/tools/estimate/estimate.mjs', import.meta.url));
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const LOCAL_OFFSET_MS = (3 * 60 + 30) * MINUTE_MS; // Asia/Tehran is +03:30 all year
const CLOCK_STEP_MS = 5 * MINUTE_MS; // the low end may be now floored to this step
const PRINTED = /^Finish: \w{3} \d+ \w{3} (\d\d):(\d\d)-(\d\d):(\d\d) /;

/** The printed clock range as epoch ms: each end is the first such local clock time at or after the local day of `now`. */
function printedRange(line, nowMs) {
  const [, lowH, lowM, highH, highM] = PRINTED.exec(line).map(Number);
  const dayStart = Math.floor((nowMs + LOCAL_OFFSET_MS) / DAY_MS) * DAY_MS - LOCAL_OFFSET_MS;
  const clock = (hours, minutes) => dayStart + (hours * 60 + minutes) * MINUTE_MS;
  const sameOrNextDay = (ms, notBefore) => (ms < notBefore ? ms + DAY_MS : ms);
  const low = sameOrNextDay(clock(lowH, lowM), dayStart + Math.floor((nowMs - dayStart) / CLOCK_STEP_MS) * CLOCK_STEP_MS);
  return { low, high: sameOrNextDay(clock(highH, highM), low) };
}

for (const replay of CASES) {
  test(`replay ${replay.name}: ${replay.finish}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), `estimate-replay-${replay.name}-`));
    const status = join(dir, 'STATUS.md');
    const nowMs = Date.parse(replay.now);
    await writeFile(status, statusAt(replay.table, nowMs));
    const run = spawnSync(process.execPath, [CLI, status, '--transcripts', dir, '--now', replay.now], { encoding: 'utf8', env: { ...process.env, TZ: 'Asia/Tehran' } });
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.trim().split('\n');
    assert.equal(lines[0], replay.finish);
    if (replay.after) assert.equal(lines[3], replay.after);
    const { low, high } = printedRange(lines[0], nowMs);
    const truth = Date.parse(replay.truth);
    if (replay.miss === 'early') assert.ok(truth < low, `recorded miss: truth ${replay.truth} now inside ${lines[0]}`);
    else assert.ok(low <= truth && truth <= high, `truth ${replay.truth} outside ${lines[0]}`);
  });
}
