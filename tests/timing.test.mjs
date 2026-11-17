// Tests for tests/timing.mjs: fastestCpuMs ignores time the process spends waiting, fastestMs counts it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fastestCpuMs, fastestMs } from './timing.mjs';

const WAIT_MS = 60;
const waitWithoutCpu = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WAIT_MS);

test('fastestMs counts the time a job waits', () => {
  assert.ok(fastestMs(waitWithoutCpu, 1) >= WAIT_MS - 5);
});

test('fastestCpuMs does not count the time a job waits', () => {
  assert.ok(fastestCpuMs(waitWithoutCpu, 1) < WAIT_MS / 2);
});

test('fastestCpuMs counts the CPU a job burns', () => {
  const cpuMs = () => { const { user, system } = process.cpuUsage(); return (user + system) / 1000; };
  const burn = () => { for (const until = cpuMs() + WAIT_MS; cpuMs() < until;); }; // spins until WAIT_MS of CPU is used, however long the wall clock takes
  assert.ok(fastestCpuMs(burn, 1) >= WAIT_MS - 5);
});

test('the fastest of several runs is returned', () => {
  let runs = 0;
  const slowFirst = () => { runs += 1; if (runs === 1) waitWithoutCpu(); };
  assert.ok(fastestMs(slowFirst, 3) < WAIT_MS / 2);
});
