// Tests for home/bin/ccm: the printed launch line per mode (CCM_DRY_RUN=1, so `claude` is never started).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CCM = fileURLToPath(new URL('../home/bin/ccm', import.meta.url));
const CCM_PS1 = fileURLToPath(new URL('../home/bin/ccm.ps1', import.meta.url));
const MODES = ['normal', 'medium', 'high', 'extra-high', 'ultra-high'];
const HAS_PWSH = spawnSync('pwsh', ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).status === 0;
const EXIT_USAGE = 2;

function dryRun(...args) {
  return spawnSync('bash', [CCM, ...args], { env: { ...process.env, CCM_DRY_RUN: '1', CCM_LEAD_EFFORT: '' }, encoding: 'utf8' });
}

function dryRunEffort(effort, ...args) {
  return spawnSync('bash', [CCM, ...args], { env: { ...process.env, CCM_DRY_RUN: '1', CCM_LEAD_EFFORT: effort }, encoding: 'utf8' });
}

test('no mode word unsets CLAUDE_MODE and adds no lead flags', () => {
  const out = dryRun();
  assert.equal(out.status, 0);
  assert.equal(out.stdout.trim(), 'env -u CLAUDE_MODE claude');
});

test('normal, medium and high pin the base lead (Opus at high) and pass extra args', () => {
  for (const mode of ['normal', 'medium', 'high']) {
    assert.equal(dryRun(mode, '-c').stdout.trim(), `env CLAUDE_MODE=${mode} claude --model opus --effort high -c`);
  }
});

test('extra-high launches Opus at max effort', () => {
  assert.equal(dryRun('extra-high').stdout.trim(), 'env CLAUDE_MODE=extra-high claude --model opus --effort max');
});

test('ultra-high is case-insensitive and launches Fable at high effort', () => {
  assert.equal(dryRun('Ultra-High', '-c').stdout.trim(), 'env CLAUDE_MODE=ultra-high claude --model fable --effort high -c');
});

test('CCM_LEAD_EFFORT overrides the effort of extra-high and ultra-high only', () => {
  assert.equal(dryRunEffort('max', 'ultra-high').stdout.trim(), 'env CLAUDE_MODE=ultra-high claude --model fable --effort max');
  assert.equal(dryRunEffort('xhigh', 'ultra-high').stdout.trim(), 'env CLAUDE_MODE=ultra-high claude --model fable --effort xhigh');
  assert.equal(dryRunEffort('high', 'extra-high').stdout.trim(), 'env CLAUDE_MODE=extra-high claude --model opus --effort high');
  for (const mode of ['normal', 'medium', 'high']) {
    assert.equal(dryRunEffort('max', mode).stdout.trim(), `env CLAUDE_MODE=${mode} claude --model opus --effort high`);
  }
  assert.equal(dryRunEffort('bogus', 'medium').status, 0);
});

test('an invalid CCM_LEAD_EFFORT is a usage error for the lead modes', () => {
  for (const mode of ['extra-high', 'ultra-high']) {
    const out = dryRunEffort('bogus', mode);
    assert.equal(out.status, EXIT_USAGE);
    assert.match(out.stderr, /CCM_LEAD_EFFORT must be low\|medium\|high\|xhigh\|max/);
  }
  assert.equal(dryRunEffort('MAX', 'ultra-high').status, EXIT_USAGE, 'effort words are case-sensitive');
});

test('an unknown first word is a usage error', () => {
  const out = dryRun('bogus');
  assert.equal(out.status, EXIT_USAGE);
  assert.match(out.stderr, /usage: ccm \[normal\|medium\|high\|extra-high\|ultra-high\]/);
});

test('ccm.ps1 has the same mode words and lead args as ccm', () => {
  const bash = readFileSync(CCM, 'utf8');
  const ps1 = readFileSync(CCM_PS1, 'utf8');
  for (const mode of MODES) assert.ok(ps1.includes(`'${mode}'`), `ccm.ps1 lacks mode ${mode}`);
  assert.match(bash, /normal\|medium\|high\) echo "--model opus --effort high"/);
  assert.match(ps1, /'--model', 'opus', '--effort', 'high'/);
  assert.match(bash, /extra-high\) echo "--model opus --effort \$\{effort:-max\}"/);
  assert.match(bash, /ultra-high\) echo "--model fable --effort \$\{effort:-high\}"/);
  assert.match(ps1, /'--model', 'opus', '--effort', \$\(if \(\$effort\) \{ \$effort \} else \{ 'max' \}\)/);
  assert.match(ps1, /'--model', 'fable', '--effort', \$\(if \(\$effort\) \{ \$effort \} else \{ 'high' \}\)/);
  assert.match(ps1, /exit \$ExitUsage/);
  assert.match(ps1, /\$Efforts -cnotcontains \$effort/, 'ccm.ps1 must reject effort words case-sensitively, like bash');
});

test('ccm.ps1 dry run prints the same lead args (needs pwsh)', { skip: !HAS_PWSH && 'pwsh not installed' }, () => {
  const run = (...args) => spawnSync('pwsh', ['-NoProfile', '-File', CCM_PS1, ...args], { env: { ...process.env, CCM_DRY_RUN: '1', CCM_LEAD_EFFORT: '' }, encoding: 'utf8' });
  const runEffort = (effort, ...args) => spawnSync('pwsh', ['-NoProfile', '-File', CCM_PS1, ...args], { env: { ...process.env, CCM_DRY_RUN: '1', CCM_LEAD_EFFORT: effort }, encoding: 'utf8' });
  assert.equal(run('Ultra-High', '-c').stdout.trim(), 'env CLAUDE_MODE=ultra-high claude --model fable --effort high -c');
  assert.equal(runEffort('max', 'ultra-high').stdout.trim(), 'env CLAUDE_MODE=ultra-high claude --model fable --effort max');
  assert.equal(runEffort('bogus', 'ultra-high').status, EXIT_USAGE);
  assert.equal(run().stdout.trim(), 'env -u CLAUDE_MODE claude');
  assert.equal(run('high', '-c').stdout.trim(), 'env CLAUDE_MODE=high claude --model opus --effort high -c');
  assert.equal(runEffort('max', 'high').stdout.trim(), 'env CLAUDE_MODE=high claude --model opus --effort high');
  assert.equal(run('bogus').status, EXIT_USAGE);
});

test('ccm.cmd shim calls ps\\ccm.ps1 and passes the exit code through', () => {
  const shim = readFileSync(fileURLToPath(new URL('../home/bin/ccm.cmd', import.meta.url)), 'utf8');
  assert.match(shim, /-File "%~dp0ps\\ccm\.ps1" %\*/);
  assert.match(shim, /exit \/b %ERRORLEVEL%/);
});
