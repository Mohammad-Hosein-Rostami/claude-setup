// Tests for scripts/sync-machines.mjs with a fake `ssh`, `scp` and `claude` on PATH: no test touches a machine.
// Exports: none (node:test file).
// Invariants: expected values come from the spec (lane sync-script) and the fixes of branch sync-target-version-probe: one alarmed
//   ssh line per remote command with the PATH export inside the quotes, a stale target checked after its install, row ids with ':',
//   a hostile name refused with exit 2, a verify failure with exit 3 and nothing sent, never a push.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/sync-machines.mjs', import.meta.url));
const FLOOR = '2.1.326';
const PATH_EXPORT = 'export PATH="$HOME/.volta/bin:/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH";';
const ALARM = (seconds) => `perl -e 'alarm ${seconds}; exec @ARGV or die "exec: $!"'`;
const SSH_OPTIONS = '-o BatchMode=yes -o ConnectTimeout=30'; // ssh_config(5): no password or host-key question, 30 s to connect
const HEAD_SHA = 'a'.repeat(40);

/** The fake ssh answers by the script it is given; FAKE_* variables pick the answer. It logs each call to $FAKE_LOG. */
const FAKE_SSH = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
while (args[0] === '-o') args.splice(0, 2); // the options before the host
const script = args.slice(1).join(' ');
fs.appendFileSync(process.env.FAKE_LOG, 'ssh ' + process.argv.slice(2).join(' ') + '\\n');
const env = process.env;
if (script.includes('== pin')) {
  console.log('== version\\n' + env.FAKE_VERSION + ' (Claude Code)\\n== settings\\n"autoUpdatesChannel": "latest",\\n== shell env\\nDISABLE_UPDATES=' + (env.FAKE_PIN_BEFORE ?? '1'));
  console.log('== pin\\n' + (env.FAKE_PIN_JSON ?? '{"cliVersion":""}'));
} else if (script.includes('git pull')) {
  console.log('== version\\n' + (env.FAKE_VERSION_AFTER ?? env.FAKE_VERSION) + ' (Claude Code)\\n== settings\\n"autoUpdatesChannel": "latest",\\n== shell env\\nDISABLE_UPDATES=' + (env.FAKE_PIN_AFTER ?? '1') + '\\n== head\\n' + '${HEAD_SHA}');
}
`;

/** A repo on main with the files the script reads, stubs for the tools it runs, and a home folder with the local claude settings. */
function setup({ targets = undefined, cliVersion = '', dirty = false } = {}) {
  const root = makeTempDir('sync-');
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  for (const dir of [join(repo, 'scripts'), join(repo, 'settings'), join(repo, 'home', 'tools', 'git-tidy'), bin, join(home, '.claude')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(repo, 'scripts', 'doctor.sh'), `#!/bin/sh\nCLAUDE_FLOOR=${FLOOR}\nexit 0\n`);
  writeFileSync(join(repo, 'scripts', 'install.sh'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(repo, 'home', 'tools', 'git-tidy', 'git-tidy.mjs'), 'process.exit(0);\n');
  writeFileSync(join(repo, 'settings', 'local.json'), JSON.stringify({ claudeSetup: { ...(cliVersion ? { cliVersion } : {}), ...(targets ? { syncTargets: targets } : {}) } }));
  for (const name of ['doctor.sh', 'install.sh']) chmodSync(join(repo, 'scripts', name), 0o755);
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { DISABLE_UPDATES: '1' } }));
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "${FLOOR} (Claude Code)"\n`);
  writeFileSync(join(bin, 'ssh'), FAKE_SSH);
  writeFileSync(join(bin, 'scp'), '#!/bin/sh\necho "scp $*" >> "$FAKE_LOG"\n');
  for (const name of ['claude', 'ssh', 'scp']) chmodSync(join(bin, name), 0o755);
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x');
  if (dirty) writeFileSync(join(repo, 'scripts', 'install.sh'), '#!/bin/sh\nexit 0 # changed\n');
  return { root, repo, bin, home, log: join(root, 'calls.log') };
}

function run(fixture, args, env = {}) {
  const row = `t${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const result = spawnSync('node', [SCRIPT, '--repo', fixture.repo, '--row', row, '--json', ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH}`, HOME: fixture.home, TMPDIR: fixture.root, FAKE_LOG: fixture.log, FAKE_VERSION: FLOOR, ...env },
  });
  const calls = existsSync(fixture.log) ? readFileSync(fixture.log, 'utf8') : '';
  const rows = result.stdout.split('\n').filter((line) => line.startsWith('[')).at(-1);
  return { ...result, calls, rows: rows ? JSON.parse(rows) : [], row };
}

test('every machine synced: exit 0, one row each, alarmed ssh lines with the export inside the quotes, scp under its alarm', () => {
  const fixture = setup({ targets: [{ name: 'pc', ssh: 'me@pc.local' }] });
  const result = run(fixture, []);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.rows.map((row) => [row.machine, row.synced, row.doctorExit]), [['macbook', true, 0], ['pc', true, 0]]);
  assert.equal(result.rows[1].sha, HEAD_SHA);
  assert.ok(result.stdout.includes(`${ALARM(120)} ssh ${SSH_OPTIONS} me@pc.local '${PATH_EXPORT} echo "== version"`), 'version read');
  assert.ok(result.stdout.includes(`${ALARM(540)} ssh ${SSH_OPTIONS} me@pc.local '${PATH_EXPORT} cd "`), 'pull and install');
  assert.ok(result.stdout.includes(`${ALARM(300)} ssh ${SSH_OPTIONS} me@pc.local '${PATH_EXPORT} cd "`), 'doctor');
  assert.match(result.stdout, /perl -e 'alarm 300; exec @ARGV or die "exec: \$!"' scp -o BatchMode=yes -o ConnectTimeout=30 \S+\.bundle \S+ me@pc\.local:\/tmp\//);
  assert.match(result.calls, /git pull --ff-only \/tmp\/\S+\.bundle main/);
  assert.doesNotMatch(result.calls, /git push/);
});

test('every ssh and scp that runs never waits for a password and times out on connect (the 3 ssh calls and the scp of a target)', () => {
  const fixture = setup({ targets: [{ name: 'pc', ssh: 'me@pc.local' }] });
  const result = run(fixture, []);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = result.calls.split('\n').filter((line) => /^(ssh|scp) /.test(line));
  assert.deepEqual(calls.map((line) => line.split(' ')[0]), ['ssh', 'scp', 'ssh', 'ssh'], 'version read, bundle copy, pull and install, doctor');
  for (const call of calls) assert.ok(call.includes(SSH_OPTIONS), `missing options: ${call.slice(0, 80)}`);
  const lines = result.stdout.split('\n').filter((line) => / (ssh|scp) /.test(line));
  assert.equal(lines.length, calls.length, 'every printed ssh or scp line is a call');
  for (const line of lines) assert.ok(line.includes(SSH_OPTIONS), `printed line without options: ${line.slice(0, 80)}`);
});

test('a pin mismatch gives exit 1 and the machine\'s row names the pin', () => {
  const fixture = setup({ cliVersion: '2.1.400' });
  const result = run(fixture, []);
  assert.equal(result.status, 1);
  assert.match(result.rows[0].problem, /pins 2\.1\.400/);
  assert.equal(result.rows[0].synced, false);
});

test('machines on different claude versions are not synced', () => {
  const fixture = setup({ targets: [{ name: 'pc', ssh: 'pc' }] });
  const result = run(fixture, [], { FAKE_VERSION: '2.1.327' });
  assert.equal(result.status, 1);
  assert.match(result.rows.find((row) => row.machine === 'pc').problem, /differ in claude version/);
});

test('a hostile target name or host is refused with exit 2 before any ssh', () => {
  for (const target of [{ name: 'pc;rm -rf ~', ssh: 'pc' }, { name: 'pc', ssh: 'pc;touch x' }]) {
    const fixture = setup({ targets: [target] });
    const result = run(fixture, []);
    assert.equal(result.status, 2, JSON.stringify(target));
    assert.equal(result.calls, '');
  }
});

test('unsafe row, base and repo are refused with exit 2; a row id with a colon and a ~/ repo are accepted', () => {
  const fixture = setup();
  for (const args of [['--row', 'a b'], ['--base', "main'x"], ['--tag', 'v1;x']]) assert.equal(run(fixture, args).status, 2, args.join(' '));
  const odd = spawnSync('node', [SCRIPT, '--repo', '~user/repo'], { encoding: 'utf8' });
  assert.equal(odd.status, 2);
  assert.equal(run(fixture, ['--row', 'close:5']).status, 0);
});

test('tracked changes: exit 3, a verify line, nothing sent', () => {
  const fixture = setup({ dirty: true });
  const result = run(fixture, []);
  assert.equal(result.status, 3);
  assert.match(result.stdout, /verify: tracked changes failed/);
  assert.equal(result.calls, '');
});

test('a target with no DISABLE_UPDATES yet passes the version phase; its pin is checked after the install', () => {
  const fixture = setup({ targets: [{ name: 'pc', ssh: 'pc' }] });
  const synced = run(fixture, [], { FAKE_PIN_BEFORE: '0', FAKE_PIN_AFTER: '1' });
  assert.equal(synced.status, 0, synced.stdout);
  const unpinned = run(fixture, [], { FAKE_PIN_BEFORE: '0', FAKE_PIN_AFTER: '0' });
  assert.equal(unpinned.status, 1);
  assert.match(unpinned.rows.find((row) => row.machine === 'pc').problem, /DISABLE_UPDATES=1 is not set after the install/);
});

test('a claude version that changed during the install fails that machine', () => {
  const fixture = setup({ targets: [{ name: 'pc', ssh: 'pc' }] });
  const result = run(fixture, [], { FAKE_VERSION_AFTER: '2.1.400' });
  assert.equal(result.status, 1);
  assert.match(result.rows.find((row) => row.machine === 'pc').problem, /after the install, but was/);
});

test('a bundle file already in use stops the run with exit 2', () => {
  const fixture = setup({ targets: [{ name: 'pc', ssh: 'pc' }] });
  writeFileSync(join(fixture.root, 'busy-sync-pc.bundle'), '');
  const result = spawnSync('node', [SCRIPT, '--repo', fixture.repo, '--row', 'busy'], { encoding: 'utf8', env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH}`, HOME: fixture.home, TMPDIR: fixture.root, FAKE_LOG: fixture.log, FAKE_VERSION: FLOOR } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /exists/);
});

test('the script holds no git push', () => {
  assert.doesNotMatch(readFileSync(SCRIPT, 'utf8'), /git push|push /);
});
