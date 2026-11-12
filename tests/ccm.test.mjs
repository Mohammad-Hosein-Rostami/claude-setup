// Tests for home/bin/ccm: the printed launch line per mode (CCM_DRY_RUN=1, so `claude` is never started).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const CCM = new URL('../home/bin/ccm', import.meta.url).pathname;
const EXIT_USAGE = 2;

function dryRun(...args) {
  return spawnSync('bash', [CCM, ...args], { env: { ...process.env, CCM_DRY_RUN: '1' }, encoding: 'utf8' });
}

test('no mode word unsets CLAUDE_MODE and adds no lead flags', () => {
  const out = dryRun();
  assert.equal(out.status, 0);
  assert.equal(out.stdout.trim(), 'env -u CLAUDE_MODE claude');
});

test('high passes extra args and no lead flags', () => {
  assert.equal(dryRun('high', '-c').stdout.trim(), 'env CLAUDE_MODE=high claude -c');
});

test('extra-high launches Opus at max effort', () => {
  assert.equal(dryRun('extra-high').stdout.trim(), 'env CLAUDE_MODE=extra-high claude --model opus --effort max');
});

test('ultra-high is case-insensitive and launches Fable at max effort', () => {
  assert.equal(dryRun('Ultra-High', '-c').stdout.trim(), 'env CLAUDE_MODE=ultra-high claude --model fable --effort max -c');
});

test('an unknown first word is a usage error', () => {
  const out = dryRun('bogus');
  assert.equal(out.status, EXIT_USAGE);
  assert.match(out.stderr, /usage: ccm \[normal\|medium\|high\|extra-high\|ultra-high\]/);
});
