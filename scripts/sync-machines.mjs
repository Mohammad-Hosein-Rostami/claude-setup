#!/usr/bin/env node
// Purpose: bring this machine and each sync target to the base tip (or the targets to a phase tag), check that every machine runs
//   the same pinned Claude Code, install the setup and run doctor on each. It replaces the sync-machines workflow.
// Usage: node scripts/sync-machines.mjs --repo <abs or ~/path> [--base <branch, default main>] [--tag <tag>] [--targets <name,...>]
//          [--row <STATUS row id>] [--checks <cat,...>] [--json]
//   Run it from the repo folder on the MacBook, once per job, after the last land: `node scripts/sync-machines.mjs --repo "$PWD"`
//   syncs the PC (the default target `pc` over `ssh pc`). Targets come from settings/local.json `claudeSetup.syncTargets`.
// Steps: verify (tag, base branch, no tracked changes, git-tidy; the suite PASS with `test` in --checks, the audit-log gate with
//   `review`), versions (one claude version and channel on every machine, at or above the floor of scripts/doctor.sh, on the local.json
//   pin), then per machine side by side: install on this machine; on a target a git bundle, a fast-forward pull (or a fetched tag),
//   the shared local values, install, then the version and DISABLE_UPDATES read again; then doctor.sh. Never pushes; never touches a project repo.
// Output: one line per machine (or a JSON array with --json): { machine, synced, sha, doctorExit, problem }.
// Exit: 0 every machine synced and doctor exited 0, 1 a machine failed (its row says why), 2 usage, 3 a verify check failed.
// Invariants: everything that reaches an ssh line (row, base, tag, repo, host) is validated first; every remote command is ONE line,
//   printed before it runs: perl's alarm (this Mac has no `timeout`), ssh, and the PATH export inside the quotes with the command.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLocal, sharedPart, syncConfig } from './install/local-settings.mjs';
import { afterInstallProblem, cliProblems, readFloor, readReport } from './sync/cli-checks.mjs';

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_VERIFY = 3;
// A non-interactive ssh shell on a target has a short PATH, so `claude`, `node` and `git` are not found: every remote command starts with this.
const REMOTE_PATH_EXPORT = 'export PATH="$HOME/.volta/bin:/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH";';
const READ_SECONDS = 120; // a remote read
const SYNC_SECONDS = 540; // the remote pull and install
const TRANSFER_SECONDS = 300; // the scp of the bundle over a slow link (the PC sits behind a phone relay)
const DOCTOR_SECONDS = 660; // doctor runs the whole suite when no PASS is recorded (about 4 minutes), plus a margin
const TAIL_LINES = 10;
const ROW_ID = /^[A-Za-z0-9][\w.:-]*$/; // the STATUS row id shape (`7`, `close:5`); no `/`, so /tmp/<row>-... stays one file name
const PLAIN_BASE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const PLAIN_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PLAIN_PATH = /^(\/|~\/)[A-Za-z0-9._/+@:~-]*$/; // absolute or ~/..., no space, quote, $, backtick or backslash
// A home folder at the start of the repo path (the target has its own home): /Users/<me>/ (not /Users/Shared/), /home/<me>/ or ~/.
const HOME_PREFIX = /^(?:\/Users\/(?!Shared\/)[^/]+|\/home\/[^/]+|~)\//;
const SETTINGS_READ = 'echo "== settings"; grep -E "autoUpdatesChannel|DISABLE_UPDATES" "$HOME/.claude/settings.json"; echo "== shell env"; echo "DISABLE_UPDATES=$DISABLE_UPDATES"';

class UsageError extends Error {}

/** Runs a command; resolves { status, out } (stdout and stderr together). A missing command is status 127; a kill by signal is status 128. */
function exec(command, args, { cwd, seconds } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    const timer = seconds ? setTimeout(() => child.kill('SIGKILL'), seconds * 1000) : null;
    child.on('error', (error) => resolve({ status: 127, out: `${out}${error.message}` }));
    child.on('close', (status) => { clearTimeout(timer); resolve({ status: status ?? 128, out }); });
  });
}

const alarmed = (seconds) => `perl -e 'alarm ${seconds}; exec @ARGV or die "exec: $!"'`;
const remoteLine = (host, seconds, script) => `${alarmed(seconds)} ssh ${host} '${REMOTE_PATH_EXPORT} ${script}'`;
const tail = (out) => out.trim().split('\n').slice(-TAIL_LINES).join(' | ');

/** Runs one printed shell line (all its parts were validated): the line the owner sees is the line that runs. */
function runLine(machine, line, seconds) {
  console.log(`[${machine}] ${line}`);
  return exec('sh', ['-c', line], { seconds: seconds + 30 });
}

function parseArgs(argv) {
  const flags = { '--repo': 'repo', '--base': 'base', '--tag': 'tag', '--targets': 'targets', '--row': 'row', '--checks': 'checks' };
  const opts = { base: 'main', row: 'sync', checks: [], json: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--json') opts.json = true;
    else if (flags[argv[index]] && argv[index + 1] !== undefined) opts[flags[argv[index]]] = argv[++index];
    else throw new UsageError(`unknown or incomplete argument ${argv[index]}`);
  }
  if (typeof opts.repo !== 'string' || !PLAIN_PATH.test(opts.repo)) throw new UsageError('--repo must be an absolute path (or ~/...) of letters, digits and . _ / + @ : ~ -');
  if (!PLAIN_BASE.test(opts.base)) throw new UsageError('--base must be a plain branch name');
  if (!ROW_ID.test(opts.row)) throw new UsageError('--row must be a STATUS row id (letters, digits, _ . : -)');
  if (opts.tag !== undefined && !PLAIN_TAG.test(opts.tag)) throw new UsageError('--tag must be a tag name');
  const checks = typeof opts.checks === 'string' ? opts.checks.split(',') : [];
  if (!checks.every((name) => /^[a-z]+$/.test(name))) throw new UsageError('--checks must be lower-case category names');
  return { ...opts, checks, targets: opts.targets?.split(','), localRepo: opts.repo.startsWith('~/') ? join(homedir(), opts.repo.slice(2)) : opts.repo };
}

/** The repo's path on a target: under the target's own home when the repo is under this machine's home, else the same path. */
function remoteCheckout(repo) {
  const relative = repo.replace(HOME_PREFIX, '');
  return relative === repo ? repo : `$HOME/${relative}`;
}

/** Where a tool lives: the repo's own copy when it has one (it is the one being synced), else the installed one. */
function toolPath(repo, name) {
  const inRepo = join(repo, 'home', 'tools', name);
  return existsSync(inRepo) ? inRepo : join(homedir(), '.claude', 'tools', name);
}

/** The verify checks in order; each returns '' when it holds, else why not. */
function verifyChecks({ localRepo, base, tag, checks }) {
  const git = (...args) => exec('git', ['-C', localRepo, ...args]);
  const node = (script, ...args) => exec('node', [script, ...args]);
  const fromStatus = (result, why) => (result.status === 0 ? '' : `${why}: ${tail(result.out)}`);
  const list = [];
  if (tag) list.push(['tag', async () => fromStatus(await git('rev-parse', '--verify', '--quiet', `refs/tags/${tag}`), `no tag ${tag}`)]);
  list.push(['base branch', async () => { const { out } = await git('branch', '--show-current'); return out.trim() === base ? '' : `on "${out.trim()}", not ${base}`; }]);
  list.push(['tracked changes', async () => { const { out } = await git('status', '--porcelain', '--untracked-files=no'); return out.trim() ? `tracked changes: ${tail(out)}` : ''; }]);
  list.push(['git-tidy', async () => fromStatus(await node(toolPath(localRepo, 'git-tidy/git-tidy.mjs'), 'check', localRepo, '--base', base), 'git-tidy check found')]);
  if (checks.includes('test')) list.push(['suite', async () => fromStatus(await node(toolPath(localRepo, 'test-pass/test-pass.mjs'), 'check', 'HEAD', '--repo', localRepo, '--suite'), 'no suite PASS at HEAD')]);
  const auditLog = toolPath(localRepo, 'review-tier/audit-log.mjs');
  if (checks.includes('review') && existsSync(auditLog)) list.push(['audit-log', async () => fromStatus(await node(auditLog, 'gate', '--repo', localRepo, '--tip', 'HEAD'), 'audit-log gate')]);
  return list;
}

/** Runs the verify checks and stops at the first failure; returns the exit code (0 when all hold). */
async function verify(options) {
  for (const [name, check] of verifyChecks(options)) {
    const why = await check();
    if (why) { console.log(`verify: ${name} failed: ${why}`); return EXIT_VERIFY; }
  }
  return 0;
}

/** This machine's claude version, channel and DISABLE_UPDATES (its own settings.json or the shell). */
async function readLocalCli() {
  const { out } = await exec('claude', ['--version']);
  let settings = {};
  try { settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')); } catch { settings = {}; }
  return { version: /^(\d+\.\d+\.\d+)\b/m.exec(out)?.[1] ?? '', channel: settings.autoUpdatesChannel ?? 'latest', pinned: settings.env?.DISABLE_UPDATES === '1' || process.env.DISABLE_UPDATES === '1', checkout: true, pin: '' };
}

/** A target's version, settings and pin as one remote script; the pin reads "" while a stale checkout has no local-settings.mjs. */
async function readTargetCli(ctx, target) {
  const emptyPin = 'echo "{\\"cliVersion\\":\\"\\"}"';
  const script = 'scripts/install/local-settings.mjs';
  const pin = `if cd "${remoteCheckout(ctx.repo)}"; then if [ -f ${script} ]; then node ${script} targets; else ${emptyPin}; fi; else echo "NO_CHECKOUT"; fi`;
  const ran = await runLine(target.name, remoteLine(target.ssh, READ_SECONDS, `echo "== version"; claude --version; ${SETTINGS_READ}; echo "== pin"; ${pin}`), READ_SECONDS);
  return readReport(ran.out);
}

/** This machine: install, then HEAD and the claude version. */
async function syncLocal(ctx) {
  const install = await exec(join(ctx.localRepo, 'scripts', 'install.sh'), [], { cwd: ctx.localRepo });
  if (install.status !== 0) return { problem: `install.sh exit ${install.status}: ${tail(install.out)}` };
  const head = await exec('git', ['-C', ctx.localRepo, 'rev-parse', 'HEAD']);
  return { sha: head.out.trim(), after: await readLocalCli() };
}

/** Creates an empty file nobody else holds (F2: a second run, or a killed one's leftover, is a usage error naming the file). */
function claim(path) {
  try { writeFileSync(path, '', { flag: 'wx', mode: 0o600 }); } catch (error) {
    if (error.code === 'EEXIST') throw new UsageError(`${path} exists: another sync runs, or a killed one left it (remove it when none runs)`);
    throw error;
  }
  return path;
}

/**
 * A target: copy the bundle (under an alarm), then ONE remote script. The pull comes before merge-shared because a target that is
 * behind has no local-settings.mjs until the pull (a tag target is on the previous tag, never behind, so a tag merges first);
 * the version and DISABLE_UPDATES reads come after the install, which sets the pin.
 */
async function syncTarget(ctx, target) {
  const bundle = ctx.bundles[target.name];
  const remoteBundle = `/tmp/${ctx.row}-sync-${target.name}.bundle`;
  const remoteShared = `/tmp/${ctx.row}-local-shared.json`;
  const made = await exec('git', ['-C', ctx.localRepo, 'bundle', 'create', bundle, ctx.tag ? `refs/tags/${ctx.tag}` : ctx.base]);
  if (made.status !== 0) return { problem: `git bundle create exit ${made.status}: ${tail(made.out)}` };
  const copied = await runLine(target.name, `${alarmed(TRANSFER_SECONDS)} scp ${bundle} ${ctx.sharedFile} ${target.ssh}:/tmp/`, TRANSFER_SECONDS);
  if (copied.status !== 0) return { problem: `scp exit ${copied.status}: ${tail(copied.out)}` };
  const merge = `node scripts/install/local-settings.mjs merge-shared ${remoteShared}`;
  const chain = ctx.tag
    ? `${merge} && git fetch ${remoteBundle} refs/tags/${ctx.tag}:refs/tags/${ctx.tag} && scripts/install.sh --update --to ${ctx.tag}`
    : `[ "$(git branch --show-current)" = "${ctx.base}" ] && [ -z "$(git status --porcelain --untracked-files=no)" ] && git pull --ff-only ${remoteBundle} ${ctx.base} && ${merge} && scripts/install.sh`;
  const script = `cd "${remoteCheckout(ctx.repo)}" || exit 3; ${chain}; code=$?; echo "== version"; claude --version; ${SETTINGS_READ}; echo "== head"; git rev-parse HEAD; exit $code`;
  const ran = await runLine(target.name, remoteLine(target.ssh, SYNC_SECONDS, script), SYNC_SECONDS);
  const after = readReport(ran.out);
  return ran.status === 0 ? { sha: after.sha, after } : { problem: `pull or install exit ${ran.status}: ${tail(ran.out)}` };
}

/** doctor.sh on a machine: { exit, tail }. */
async function doctor(ctx, target) {
  if (!target) return exec(join(ctx.localRepo, 'scripts', 'doctor.sh'), [], { cwd: ctx.localRepo, seconds: DOCTOR_SECONDS }).then((result) => ({ exit: result.status, tail: tail(result.out) }));
  const ran = await runLine(target.name, remoteLine(target.ssh, DOCTOR_SECONDS, `cd "${remoteCheckout(ctx.repo)}" || exit 3; scripts/doctor.sh`), DOCTOR_SECONDS);
  return { exit: ran.status, tail: tail(ran.out) };
}

/** One machine's whole sync: install, the after-install checks, doctor. Always returns its row. */
async function syncMachine(ctx, name, target, before) {
  const row = { machine: name, synced: false, sha: '', doctorExit: null, problem: '' };
  try {
    const moved = target ? await syncTarget(ctx, target) : await syncLocal(ctx);
    row.sha = moved.sha ?? '';
    row.problem = moved.problem ?? afterInstallProblem(name, before, moved.after, Boolean(target));
    if (row.problem) return row;
    row.synced = true;
    const checked = await doctor(ctx, target);
    row.doctorExit = checked.exit;
    if (checked.exit !== 0) row.problem = `${name}: doctor exit ${checked.exit}: ${checked.tail}`;
  } catch (error) {
    row.problem = `${name}: ${error.message}`;
  }
  return row;
}

/** The configured targets (validated by local-settings), narrowed by --targets; a usage error when a name is unknown or is this machine. */
function chooseTargets(options) {
  let config;
  try { config = syncConfig(readLocal(join(options.localRepo, 'settings', 'local.json'))); } catch (error) { throw new UsageError(`settings/local.json: ${error.message}`); }
  const names = config.targets.map((target) => target.name);
  const unknown = (options.targets ?? []).filter((name) => !names.includes(name));
  if (unknown.length > 0) throw new UsageError(`unknown target ${unknown.join(', ')} (configured: ${names.join(', ')})`);
  if (names.includes(config.machine) || new Set(names).size !== names.length) throw new UsageError(`target names must be unique and differ from this machine's name ${config.machine}`);
  return { config, targets: config.targets.filter((target) => !options.targets || options.targets.includes(target.name)) };
}

function printRows(rows, json) {
  if (json) return console.log(JSON.stringify(rows));
  for (const row of rows) console.log(`${row.machine}: ${row.synced ? 'synced' : 'NOT synced'} sha ${row.sha || '-'} doctor ${row.doctorExit ?? '-'}${row.problem ? ` problem: ${row.problem}` : ''}`);
}

/** Claims this run's bundle and shared files, syncs every machine without a problem side by side, and removes the files. */
async function syncAll(options, names, problems, reports) {
  if (!PLAIN_PATH.test(tmpdir())) throw new UsageError(`the temp folder ${tmpdir()} is not a plain path`);
  const claimed = [];
  try {
    const sharedFile = claim(join(tmpdir(), `${options.row}-local-shared.json`));
    claimed.push(sharedFile);
    const bundles = Object.fromEntries(options.targets.map((target) => [target.name, claim(join(tmpdir(), `${options.row}-sync-${target.name}.bundle`))]));
    claimed.push(...Object.values(bundles));
    writeFileSync(sharedFile, `${JSON.stringify(sharedPart(readLocal(join(options.localRepo, 'settings', 'local.json'))), null, 2)}\n`);
    const ctx = { ...options, sharedFile, bundles };
    return await Promise.all(names.map((name, index) => (problems[name].length > 0
      ? { machine: name, synced: false, sha: '', doctorExit: null, problem: problems[name].join('; ') }
      : syncMachine(ctx, name, options.targets[index - 1], reports[index]))));
  } finally {
    claimed.forEach((path) => rmSync(path, { force: true }));
  }
}

async function main(argv) {
  const options = parseArgs(argv);
  const { config, targets } = chooseTargets(options);
  const verified = await verify(options);
  if (verified !== 0) return verified;
  const names = [config.machine, ...targets.map((target) => target.name)];
  const reports = await Promise.all([readLocalCli(), ...targets.map((target) => readTargetCli(options, target))]);
  const problems = cliProblems(names, reports, { floor: readFloor(options.localRepo), localName: config.machine, pin: config.cliVersion });
  const rows = await syncAll({ ...options, targets }, names, problems, reports);
  printRows(rows, options.json);
  return rows.every((row) => row.synced && row.doctorExit === 0) ? 0 : EXIT_FAILED;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(`sync-machines: ${error.message}`);
    process.exitCode = error instanceof UsageError ? EXIT_USAGE : EXIT_FAILED;
  });
}
