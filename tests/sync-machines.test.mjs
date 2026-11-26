// Tests for scripts/sync-machines.mjs with a fake `ssh`, `scp` and `claude` on PATH: no test touches a machine.
// Exports: none (node:test file).
// Invariants: expected values come from the spec (lane sync-script) and the fixes of branch sync-target-version-probe: one alarmed
//   ssh line per remote command with the PATH export inside the quotes, a stale target checked after its install, the removed
//   --row refused with exit 2 (audit R7), a hostile name refused with exit 2, a verify failure with exit 3 and nothing sent, never a push,
//   no doctor step (rows report the install exit), one run at a time (the lock of a killed sync is taken over, e1e226c7), and
//   the base is the checked-out branch (plan base-current-branch, piece base-6): --base refused, a target follows the branch,
//   a detached HEAD stops at verify, and a detached target checkout is refused untouched (base-6 must-fix 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';
import { hardLinkSharedTool, sharedToolDir } from './shared-tools.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/sync-machines.mjs', import.meta.url));
const FLOOR = '2.1.326';
const PATH_EXPORT =
  'export PATH="$HOME/.volta/bin:/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH"; [ -x /usr/libexec/path_helper ] && eval "$(/usr/libexec/path_helper -s)";';
const ALARM = (seconds) => `perl -e 'alarm ${seconds}; exec @ARGV or die "exec: $!"'`;
const SSH_OPTIONS = '-o BatchMode=yes -o ConnectTimeout=30'; // ssh_config(5): no password or host-key question, 30 s to connect

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
  console.log('== version\\n' + (env.FAKE_VERSION_AFTER ?? env.FAKE_VERSION) + ' (Claude Code)\\n== settings\\n"autoUpdatesChannel": "latest",\\n== shell env\\nDISABLE_UPDATES=' + (env.FAKE_PIN_AFTER ?? '1') + '\\n== head\\n' + env.FAKE_HEAD);
}
`;

const OWN_FILES = process.platform === 'win32'; // shared-tools.mjs is POSIX only

/** Writes `body` to `path` and makes it runnable. */
function writeExecutable(path, body) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/**
 * A repo on `branch` (detached at its commit when `detached`) with the files the script reads, stubs for the tools it runs, and a
 * home folder with the local claude settings.
 */
function setup({ targets = undefined, cliVersion = '', dirty = false, branch = 'main', detached = false } = {}) {
  const root = makeTempDir('sync-');
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  for (const dir of [join(repo, 'scripts'), join(repo, 'settings'), join(repo, 'home', 'tools', 'git-tidy'), join(home, '.claude')]) mkdirSync(dir, { recursive: true });
  // On POSIX the repo's script is a hard link of a shared file and the tools one shared folder: a new executable is slow to
  // start. The dirty case writes its own install.sh (it changes the file, and the run stops at verify before any script runs).
  // Shared tools are POSIX only, so win32 writes every file of its own, as before.
  const scripts = { 'install.sh': '#!/bin/sh\nexit 0\n' };
  for (const [name, body] of Object.entries(scripts)) {
    if (OWN_FILES || (dirty && name === 'install.sh')) writeExecutable(join(repo, 'scripts', name), body);
    else hardLinkSharedTool(join(repo, 'scripts', name), body);
  }
  writeFileSync(join(repo, 'home', 'tools', 'git-tidy', 'git-tidy.mjs'), 'process.exit(0);\n');
  writeFileSync(join(repo, 'settings', 'local.json'), JSON.stringify({ claudeSetup: { ...(cliVersion ? { cliVersion } : {}), ...(targets ? { syncTargets: targets } : {}) } }));
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { DISABLE_UPDATES: '1' } }));
  const tools = {
    claude: `#!/bin/sh\necho "${FLOOR} (Claude Code)"\n`,
    ssh: FAKE_SSH,
    scp: '#!/bin/sh\necho "scp $*" >> "$FAKE_LOG"\n',
  };
  const bin = OWN_FILES ? join(root, 'bin') : sharedToolDir(tools);
  if (OWN_FILES) {
    mkdirSync(bin);
    for (const [name, body] of Object.entries(tools)) writeExecutable(join(bin, name), body);
  }
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', branch);
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x');
  if (detached) git('checkout', '-q', '--detach');
  if (dirty) writeFileSync(join(repo, 'scripts', 'install.sh'), '#!/bin/sh\nexit 0 # changed\n');
  return { root, repo, bin, home, log: join(root, 'calls.log'), head: git('rev-parse', 'HEAD').stdout.trim() };
}

function run(fixture, args, env = {}) {
  const result = spawnSync('node', [SCRIPT, '--repo', fixture.repo, '--json', ...args], {
    encoding: 'utf8',
    env: cleanEnv({ PATH: `${fixture.bin}:${process.env.PATH}`, HOME: fixture.home, TMPDIR: fixture.root, FAKE_LOG: fixture.log, FAKE_VERSION: FLOOR, FAKE_HEAD: fixture.head, ...env }),
  });
  const calls = existsSync(fixture.log) ? readFileSync(fixture.log, 'utf8') : '';
  const rows = result.stdout.split('\n').filter((line) => line.startsWith('[')).at(-1);
  return { ...result, calls, rows: rows ? JSON.parse(rows) : [] };
}

test('every machine synced: exit 0, one row each, alarmed ssh lines with the export inside the quotes, scp under its alarm', () => {
  const fixture = setup({ targets: [{ name: 'pc', ssh: 'me@pc.local' }] });
  const result = run(fixture, []);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.rows.map((row) => [row.machine, row.synced, row.installExit]), [['mac', true, 0], ['pc', true, 0]]);
  assert.equal(result.rows[1].sha, fixture.head);
  assert.ok(result.stdout.includes(`${ALARM(120)} ssh ${SSH_OPTIONS} me@pc.local '${PATH_EXPORT} echo "== version"`), 'version read');
  assert.ok(result.stdout.includes(`${ALARM(540)} ssh ${SSH_OPTIONS} me@pc.local '${PATH_EXPORT} cd "`), 'pull and install');
  assert.doesNotMatch(result.stdout, /doctor/, 'sync has no doctor step');
  assert.match(result.stdout, /perl -e 'alarm 300; exec @ARGV or die "exec: \$!"' scp -o BatchMode=yes -o ConnectTimeout=30 \S+\.bundle \S+ me@pc\.local:\/tmp\//);
  assert.match(result.calls, /git pull --ff-only \/tmp\/\S+\.bundle main/);
  assert.doesNotMatch(result.calls, /git push/);
});

test('every ssh and scp that runs never waits for a password and times out on connect (the 2 ssh calls and the scp of a target)', () => {
  const fixture = setup({ targets: [{ name: 'pc', ssh: 'me@pc.local' }] });
  const result = run(fixture, []);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = result.calls.split('\n').filter((line) => /^(ssh|scp) /.test(line));
  assert.deepEqual(calls.map((line) => line.split(' ')[0]), ['ssh', 'scp', 'ssh'], 'version read, bundle copy, pull and install');
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

test('unsafe tag and repo are refused with exit 2', () => {
  const fixture = setup();
  assert.equal(run(fixture, ['--tag', 'v1;x']).status, 2);
  const odd = spawnSync('node', [SCRIPT, '--repo', '~user/repo'], { encoding: 'utf8' });
  assert.equal(odd.status, 2);
});

test('the removed --row is refused with exit 2, naming why, before any ssh', () => {
  const fixture = setup({ targets: [{ name: 'pc', ssh: 'pc' }] });
  const result = run(fixture, ['--row', '7']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--row is gone/);
  assert.equal(result.calls, '');
});

test('the removed --base is refused with exit 2, naming why, before any ssh', () => {
  const fixture = setup({ targets: [{ name: 'pc', ssh: 'pc' }] });
  const result = run(fixture, ['--base', 'main']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--base is gone/);
  assert.equal(result.calls, '');
});

test('a target follows the checked-out branch: a pull when on it, else a fast-forward fetch into it and a switch', () => {
  const fixture = setup({ targets: [{ name: 'pc', ssh: 'pc' }], branch: 'feat' });
  const result = run(fixture, []);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const sync = result.calls.split('\n').find((line) => line.includes('git pull'));
  assert.ok(sync.includes('git pull --ff-only /tmp/sync-sync-pc.bundle feat'), sync);
  assert.ok(sync.includes('git fetch /tmp/sync-sync-pc.bundle feat:refs/heads/feat'), sync);
  assert.ok(sync.includes('git switch -q feat'), sync);
});

test('a detached HEAD: exit 3, a verify line, nothing sent', () => {
  const fixture = setup({ targets: [{ name: 'pc', ssh: 'pc' }], detached: true });
  const result = run(fixture, []);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stdout, /verify: base branch failed: no branch checked out/);
  assert.equal(result.calls, '');
});

test('a detached target checkout is refused with a fix step and left as it was (its own commits stay on HEAD)', () => {
  const fixture = setup({ targets: [{ name: 'pc', ssh: 'pc' }] });
  const result = run(fixture, []);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // The chain the fake ssh got, run for real in a detached clone with its own commit (tess's repro, base-6 must-fix 1).
  const chain = result.calls.match(/\|\| exit 3; (.*); code=\$\?/)[1];
  const pc = join(fixture.root, 'pc');
  const bundle = join(fixture.root, 'main.bundle');
  const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  git(fixture.root, 'clone', '-q', fixture.repo, pc);
  git(fixture.repo, 'commit', '-q', '--allow-empty', '-m', 'newer');
  git(fixture.repo, 'bundle', 'create', '-q', bundle, 'main');
  git(pc, 'switch', '-q', '--detach');
  git(pc, 'commit', '-q', '--allow-empty', '-m', 'pc-only work');
  const pcOnly = git(pc, 'rev-parse', 'HEAD').stdout;
  const ran = spawnSync('bash', ['-c', chain.replaceAll('/tmp/sync-sync-pc.bundle', bundle)], { cwd: pc, encoding: 'utf8' });
  assert.notEqual(ran.status, 0);
  assert.match(ran.stdout, /^the checkout is a detached HEAD: check out a branch there \(git switch -c <name> keeps its commits\)$/m);
  assert.equal(git(pc, 'rev-parse', 'HEAD').stdout, pcOnly, 'HEAD stays on the pc commit');
  assert.equal(git(pc, 'branch', '--show-current').stdout.trim(), '', 'still detached');
  assert.equal(git(pc, 'rev-parse', 'main').stdout.trim(), fixture.head, 'main not moved');
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

const lockPathOf = (fixture) => join(fixture.root, 'sync-machines.lock');
const exitedPid = () => spawnSync(process.execPath, ['-e', '']).pid; // a pid that ran and ended

test('the leftover files of a killed sync are removed and the run goes on', () => {
  const fixture = setup({ targets: [{ name: 'pc', ssh: 'pc' }] });
  const leftovers = [join(fixture.root, 'sync-sync-pc.bundle'), join(fixture.root, 'sync-local-shared.json')];
  for (const file of leftovers) writeFileSync(file, 'leftover');
  const result = run(fixture, []);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const file of leftovers) assert.equal(existsSync(file), false, `${file} is removed after the run`);
});

test('the lock of a killed sync (its pid runs no more) is taken over, and the lock is gone after the run', () => {
  const fixture = setup({ targets: [{ name: 'pc', ssh: 'pc' }] });
  writeFileSync(lockPathOf(fixture), String(exitedPid()));
  const result = run(fixture, []);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(lockPathOf(fixture)), false, 'the run released its lock');
});

test('a second sync while one runs (its lock holds a running pid) exits 2 and sends nothing', () => {
  const fixture = setup({ targets: [{ name: 'pc', ssh: 'pc' }] });
  writeFileSync(lockPathOf(fixture), String(process.pid));
  const result = spawnSync('node', [SCRIPT, '--repo', fixture.repo], { encoding: 'utf8', env: cleanEnv({ PATH: `${fixture.bin}:${process.env.PATH}`, HOME: fixture.home, TMPDIR: fixture.root, FAKE_LOG: fixture.log, FAKE_VERSION: FLOOR, FAKE_HEAD: fixture.head }) });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /another sync runs/);
  assert.equal(readFileSync(lockPathOf(fixture), 'utf8'), String(process.pid), 'the running sync keeps its lock');
  assert.doesNotMatch(readFileSync(fixture.log, 'utf8'), /scp|git pull/);
});

test('the script holds no git push', () => {
  assert.doesNotMatch(readFileSync(SCRIPT, 'utf8'), /git push|push /);
});
