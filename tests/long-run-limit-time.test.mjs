// Tests of the usage-limit reset time (spec 5, U1; lib/limit-time.mjs): the printed time is local, has no date and no zone, so it
// means its next local occurrence (+120 s). The file runs itself again under three zones, one on a DST change day, so a zone
// mistake fails here and not only on the owner's machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FALLBACK_WAIT_MS, LIMIT_TEXT, RESUME_MARGIN_MS, limitWaitUntil, parseResetTime, resetFromSamples } from '../home/tools/long-run/lib/limit-time.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';

const ZONES = ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati'];
const local = (...parts) => new Date(...parts);
const parts = (date) => [date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes()];

test('"resets 3:45pm" before 15:45 is today 15:45; after it, tomorrow 15:45 (a calendar day, not 24 h)', () => {
  assert.deepEqual(parts(parseResetTime("You've hit your session limit · resets 3:45pm", local(2026, 10, 24, 10, 0))), [2026, 10, 24, 15, 45]);
  assert.deepEqual(parts(parseResetTime('resets 3:45pm', local(2026, 10, 24, 16, 0))), [2026, 10, 25, 15, 45]);
  assert.deepEqual(parts(parseResetTime('It resets at 3am.', local(2026, 10, 24, 1, 0))), [2026, 10, 24, 3, 0]);
  assert.deepEqual(parts(parseResetTime('resets 12:00am', local(2026, 10, 24, 1, 0))), [2026, 10, 25, 0, 0]);
});

test('weekly "resets Mon 12:00am" is the next Monday at midnight local time', () => {
  const at = parseResetTime("You've hit your weekly limit · resets Mon 12:00am", local(2026, 10, 24, 10, 0)); // a Tuesday
  assert.equal(at.getDay(), 1);
  assert.deepEqual(parts(at), [2026, 10, 30, 0, 0]);
});

test('DST: a reset at 3:00am on the spring-forward day is 03:00 local that day; the wait lands 120 s later', () => {
  const now = local(2026, 2, 8, 1, 30);
  const at = parseResetTime('resets 3:00am', now);
  assert.deepEqual(parts(at), [2026, 2, 8, 3, 0]);
  const { until, source } = limitWaitUntil('resets 3:00am', { now, account: 'acct-a', limitsDir: makeTempDir('limits-') });
  assert.equal(source, 'text');
  assert.equal(until.getTime() - at.getTime(), RESUME_MARGIN_MS);
});

test('no readable time: the newest stored sample (a full window) is used, else one hour from now', () => {
  const now = new Date(Date.UTC(2026, 10, 24, 10));
  const sample = { five_hour: { used_percentage: 100, resets_at: now.getTime() / 1000 + 600 }, seven_day: { used_percentage: 40, resets_at: now.getTime() / 1000 + 9000 } };
  assert.equal(resetFromSamples(sample, now).getTime(), now.getTime() + 600000);
  assert.equal(resetFromSamples(null, now), null);
  const { until, source } = limitWaitUntil('usage limit reached', { now, account: 'acct-a', limitsDir: makeTempDir('limits-') });
  assert.deepEqual([source, until.getTime() - now.getTime()], ['fallback', FALLBACK_WAIT_MS]);
  assert.ok(LIMIT_TEXT.test("You've hit your session limit · resets 3:45pm") && LIMIT_TEXT.test("You've hit your weekly limit · resets Mon 12:00am"));
  assert.ok(!LIMIT_TEXT.test('the rate limiter module is broken'));
});

// Registered only in the first run: the zone runs are its children.
if (!process.env.LONG_RUN_TZ_CHILD) test('the same cases hold under UTC, America/Los_Angeles and Pacific/Kiritimati', () => {
  for (const zone of ZONES) {
    const run = spawnSync(process.execPath, ['--test', fileURLToPath(import.meta.url)], { env: cleanEnv({ TZ: zone, LONG_RUN_TZ_CHILD: '1' }), encoding: 'utf8' });
    assert.equal(run.status, 0, `${zone}: ${run.stdout.split('\n').filter((line) => line.includes('not ok') || line.includes('Error')).join('\n')}`);
  }
});
