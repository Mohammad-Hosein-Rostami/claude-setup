// Tests for the doctor checks check_node and check_claude_version (scripts/doctor.sh, DOCTOR_ONLY mode), and the re-read tie
// (VERIFIED_ON_CLI): on that version an ok line, on any other a WARN that lists the files copying Claude Code behaviour, never a FAIL.
// The floor text says it replaces the older versions and not to use the stable channel (2.1.323), in doctor and the installer.
// The Bash guard's settings entry relies on `onFailure: "block"`, which Claude Code honours from 2.1.295, and the phase pin's floor is 2.1.326; the guard's Windows path tests
// need module.registerHooks, which Node has from 22.15 (without it they are skipped). Doctor must fail on anything older, and must
// compare the parts as numbers: 2.1.99 is older than 2.1.295. The tools are fakes on PATH; HOME is a temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';

const DOCTOR = fileURLToPath(new URL('../scripts/doctor.sh', import.meta.url));
const INSTALL_CLI = fileURLToPath(new URL('../scripts/install/cli.mjs', import.meta.url));
const skip = process.platform === 'win32' ? 'the fake tools are sh scripts' : false;
const VERIFIED_ON_CLI = /^VERIFIED_ON_CLI=(\d+\.\d+\.\d+)$/m.exec(readFileSync(DOCTOR, 'utf8'))?.[1];

/** Runs one doctor check with a fake `tool` on PATH that prints `output` whatever it is asked. */
function doctorWith(check, tool, output) {
  const bin = makeTempDir('doctor-bin-');
  const home = makeTempDir('doctor-home-');
  writeFileSync(join(bin, tool), `#!/bin/sh\necho '${output}'\n`);
  chmodSync(join(bin, tool), 0o755);
  const env = { ...process.env, HOME: home, USERPROFILE: home, DOCTOR_ONLY: check, PATH: `${bin}${delimiter}${process.env.PATH}` };
  const run = spawnSync('bash', [DOCTOR], { encoding: 'utf8', env });
  return { status: run.status, out: run.stdout };
}

test('doctor fails on a Claude Code older than the floor 2.1.326 and says what breaks', { skip }, () => {
  for (const version of ['2.1.325', '2.1.295', '2.1.99', '2.0.400', '1.9.999']) {
    const { status, out } = doctorWith('check_claude_version', 'claude', `${version} (Claude Code)`);
    assert.equal(status, 1, version);
    assert.ok(out.includes(`FAIL  claude >= 2.1.326 required (found ${version};`), out);
    assert.match(out, /onFailure: block/);
    assert.match(out, /run claude update, and do not use the stable channel \(2\.1\.323\)$/m);
  }
});

test('the floor replaces the older versions: doctor and the installer say so, and refuse the stable channel 2.1.323', { skip }, async () => {
  const floorComment = /^# Claude Code 2\.1\.326[\s\S]*?^CLAUDE_FLOOR=/m.exec(readFileSync(DOCTOR, 'utf8'))?.[0] ?? '';
  assert.match(floorComment, /replaces the\s+# PC's 2\.1\.323 and Windows' 2\.1\.316, which are below it/);
  assert.doesNotMatch(floorComment, /covers.*2\.1\.3(23|16)/);
  const installer = readFileSync(INSTALL_CLI, 'utf8');
  assert.match(installer, /2\.1\.326: it replaces Windows' 2\.1\.316 and the stable channel's 2\.1\.323/);
  const { installClaude } = await import(pathToFileURL(INSTALL_CLI).href);
  assert.throws(() => installClaude({ claudeVersion: '2.1.323' }), (error) => error.exitCode === 2
    && error.message === '--claude-version 2.1.323 is below the floor 2.1.326; do not use the stable channel (2.1.323)');
});

test('doctor accepts Claude Code 2.1.326 and later, and only warns when the CLI gives no version', { skip }, () => {
  for (const version of ['2.1.326', '2.1.329', '2.2.0', '3.0.0']) {
    const { status, out } = doctorWith('check_claude_version', 'claude', `${version} (Claude Code)`);
    assert.deepEqual([status, out.startsWith(`ok    claude ${version}`)], [0, true], out);
  }
  const silent = doctorWith('check_claude_version', 'claude', 'no version here');
  assert.deepEqual([silent.status, silent.out.startsWith('WARN  claude --version gave no version')], [0, true], silent.out);
});

test('doctor ties the CLI version to the re-read: ok on VERIFIED_ON_CLI, a WARN with the file list on any other, no FAIL', { skip }, () => {
  assert.equal(VERIFIED_ON_CLI, '2.1.330');
  const verified = doctorWith('check_claude_version', 'claude', '2.1.330 (Claude Code)');
  assert.equal(verified.status, 0, verified.out);
  assert.match(verified.out, /^ok    claude 2\.1\.330 is the version the files that copy Claude Code behaviour were read again on/m);
  assert.doesNotMatch(verified.out, /^(WARN|FAIL) /m);
  // 2.1.329 is the rollback: it must stay at 0 FAIL. A newer or a much newer version needs the re-read just the same.
  for (const version of ['2.1.329', '2.1.331', '2.2.0']) {
    const { status, out } = doctorWith('check_claude_version', 'claude', `${version} (Claude Code)`);
    assert.equal(status, 0, out);
    assert.doesNotMatch(out, /^FAIL /m);
    const warn = out.split('\n').find((line) => line.startsWith('WARN  '));
    assert.ok(warn?.includes(`claude ${version} is not 2.1.330`) && warn.includes(`set VERIFIED_ON_CLI=${version}`), out);
    const files = out.split('\n').filter((line) => /^ {6}home\/(hooks|tools)\//.test(line)).map((line) => line.trim());
    assert.ok(warn.includes(`these ${files.length} files`), out);
    assert.ok(files.includes('home/hooks/lib/agent-pins.mjs') && files.includes('home/tools/token-view/lib/transcripts.mjs'), out);
    assert.ok(files.length >= 16, `the re-read list shrank to ${files.length} files`);
  }
});

test('doctor warns, never crashes or fails, when claude is missing or prints junk', { skip }, () => {
  const junk = doctorWith('check_claude_version', 'claude', 'Error: \x1b[31mnot logged in 99\x07');
  assert.equal(junk.status, 0, junk.out);
  assert.match(junk.out, /^WARN  claude --version gave no version: cannot check the floor 2\.1\.326 or the re-read version 2\.1\.330/m);
  assert.doesNotMatch(junk.out, /^FAIL /m);
  // No claude anywhere on PATH: the folders that hold one are left out (the real CLI included).
  const home = makeTempDir('doctor-home-');
  const path = process.env.PATH.split(delimiter).filter((dir) => dir && !existsSync(join(dir, 'claude'))).join(delimiter);
  const env = { ...process.env, HOME: home, USERPROFILE: home, DOCTOR_ONLY: 'check_claude_version', PATH: path };
  const missing = spawnSync('bash', [DOCTOR], { encoding: 'utf8', env });
  assert.equal(missing.status, 0, missing.stdout + missing.stderr);
  assert.match(missing.stdout, /^WARN  claude --version gave no version/m);
  assert.doesNotMatch(missing.stdout, /^FAIL /m);
});

test('doctor fails on a Node older than 22.15 and accepts 22.15 and later', { skip }, () => {
  for (const version of ['22.14.0', '22.9.1', '21.99.99', '20.19.0']) {
    const { status, out } = doctorWith('check_node', 'node', version);
    assert.equal(status, 1, version);
    assert.ok(out.includes(`FAIL  node >= 22.15 required (found ${version})`), out);
  }
  for (const version of ['22.15.0', '22.20.1', '24.0.0']) {
    const { status, out } = doctorWith('check_node', 'node', version);
    assert.deepEqual([status, out.trim()], [0, `ok    node ${version}`], version);
  }
});

test('the whole doctor run checks Claude Code and fails below its floor', { skip }, () => {
  // No DOCTOR_ONLY: this pins that check_claude_version is in the run list at all. The repo suite is replaced by `true`, and every
  // other check reads the temp HOME, so only the claude line is asserted.
  const bin = makeTempDir('doctor-bin-');
  const home = makeTempDir('doctor-home-');
  writeFileSync(join(bin, 'claude'), "#!/bin/sh\necho '2.1.294 (Claude Code)'\n");
  chmodSync(join(bin, 'claude'), 0o755);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    DOCTOR_PROJECT: home,
    DOCTOR_LOG_DIR: join(home, 'logs'),
    DOCTOR_TEST_COMMAND: 'true',
    // the disk-clean dry run lists these roots, not the machine's real temp folders (a dry run: no --apply)
    DOCTOR_DISK_CLEAN_ARGS: `--claude-tmp ${join(home, 'none')} --projects ${join(home, 'projects')} --tmp ${join(home, 'tmp')}`,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
  };
  delete env.DOCTOR_ONLY;
  delete env.CLAUDE_PROD_HOSTS_FILE; // doctor.sh reads these from the parent environment: the run must use the temp HOME's own state
  for (const name of Object.keys(env)) if (name.startsWith('RECALL_') || name.startsWith('DISK_')) delete env[name];
  env.DISK_FREE_CLAUDE_TMP = join(home, 'none'); // a low-disk warning sizes this folder, never the machine's real Claude temp folder
  const run = spawnSync('bash', [DOCTOR], { encoding: 'utf8', env });
  assert.equal(run.status, 1);
  assert.ok(run.stdout.includes('FAIL  claude >= 2.1.326 required (found 2.1.294;'), run.stdout);
});
