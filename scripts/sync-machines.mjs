#!/usr/bin/env node
// Purpose: brings this machine and each sync target to the base tip, or the targets to a phase tag, and installs the setup.
//   The base is the branch checked out in --repo (no option names it); each target follows it. It also checks that every machine
//   runs the same pinned Claude Code. It replaces the sync-machines workflow.
// Usage: node scripts/sync-machines.mjs --repo <abs or ~/path> [--tag <tag>] [--targets <name,...>] [--json]
//   Run it from the repo folder on the main machine after every land: `node scripts/sync-machines.mjs --repo "$PWD"`
//   syncs the PC (the default target `pc` over `ssh pc`). Targets come from settings/local.json `claudeSetup.syncTargets`.
// Steps: verify (tag, a branch checked out with a plain name, no tracked changes; open lanes are not checked; the removed --base,
//   --checks and --row options exit 2), versions (one claude version, channel and pin on every machine, at or above CLAUDE_FLOOR (2.1.326, in
//   scripts/sync/cli-checks.mjs), on the local.json pin), then per machine side by side: install on this machine; on a
//   target a git bundle, the same branch fast-forward only with no tracked changes and no detached HEAD there (a pull when it is checked out, else a
//   fetch into it and a switch to it; or a fetched tag), the shared local values, install, then the version and
//   DISABLE_UPDATES read again. Never pushes; never touches a project repo.
// Output: one line per machine, `<machine>: synced sha <40-hex> install <exit>`, plus ` node <path>` for a target (or a JSON array
//   with --json): { machine, synced, sha, installExit, node, problem }. installExit is install.sh's exit on this machine and the exit
//   of the remote pull-and-install line on a target; null when the install did not run. node is the node a target's install ran
//   ('' on this machine or when unread). A target ssh cannot reach says so in its problem, apart from a claude not found there.
// Exit: 0 every machine synced (installed with exit 0 and at the tip: the base branch's sha, or the tag's commit on a target of a
//   --tag run), 1 a machine failed (its row says why), 2 usage or another sync runs (the run lock below), 3 a verify check failed.
// Record: every run that reached verify writes its result to the sync record (home/tools/board/lib/sync-record.mjs, read by the
//   boss's tick): each machine's state, and how many runs in a row failed since when. A record that cannot be read or written is
//   one stderr line and changes no exit.
// Invariants: everything that reaches an ssh line (base, tag, repo, host) is validated first; every remote command is ONE line,
//   printed before it runs: perl's alarm (this Mac has no `timeout`), ssh, and the PATH export inside the quotes with the command.
//   Every ssh and scp call carries SSH_OPTIONS: it never waits for a password or a host-key question, and gives up on a connect after 30 s.
//   One sync at a time: the run lock <tmp>/sync-machines.lock holds the running sync's pid from before verify until the record is
//   written; a second sync exits 2, and the lock of a killed sync (its pid runs no more) is taken over and its leftover temp
//   files are removed.
import { spawn } from 'node:child_process';
import { lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSyncablePath, nextSyncRecord, readSyncRecord, syncLockPath, writeSyncRecord } from '../home/tools/board/lib/sync-record.mjs';
import { releaseLock, takeLock } from '../home/tools/disk-free/lib/lock-file.mjs';
import { readLocal, sharedPart, syncConfig } from './install/local-settings.mjs';
import { isRunning } from './install/record.mjs';
import { CLAUDE_FLOOR, CLAUDE_READ, NODE_READ, afterInstallProblem, cliProblems, readReport } from './sync/cli-checks.mjs';

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_VERIFY = 3;
// A non-interactive ssh shell on a target has a short PATH, so `claude`, `node` and `git` are not found: every remote command starts with this.
// On macOS path_helper then reorders it as a terminal login shell does, so install builds the tools for the same node the
// owner's terminal runs (the Volta shim first gave the wrong node ABI). path_helper puts /etc/paths first and keeps every entry
// already set after them, so ~/.local/bin (claude) stays. Linux and Windows have no path_helper: PATH stays as set.
// No single quote inside: the line sits in the '...' of the ssh command.
const REMOTE_PATH_EXPORT =
  'export PATH="$HOME/.volta/bin:/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH"; [ -x /usr/libexec/path_helper ] && eval "$(/usr/libexec/path_helper -s)";';
// ssh(1): ssh exits with the remote command's status, or 255 when ssh itself failed (refused, no route, connect timeout, auth).
const SSH_ERROR_EXIT = 255;
const READ_SECONDS = 120; // a remote read
const SYNC_SECONDS = 540; // the remote pull and install
const TRANSFER_SECONDS = 300; // the scp of the bundle over a slow link (the PC sits behind a phone relay)
const TAIL_LINES = 10;
// The temp files of a run: /tmp/sync-local-shared.json and /tmp/sync-sync-<target>.bundle, here and on each target (the names the
// removed --row option gave by default). Here they are made only under the run lock, after a killed run's leftovers are removed.
const TEMP_PREFIX = 'sync';
const NEVER_BY_AGE = Infinity; // takeLock's limit that never breaks a lock for its age alone: a sync has no fixed length
const PLAIN_BASE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const PLAIN_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
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

// ssh_config(5), probed with `man ssh_config` on macOS: BatchMode=yes turns off password prompts and host-key questions (a script has nobody to
// answer); ConnectTimeout=30 is the seconds allowed to connect and finish the handshake, instead of the system's TCP timeout (the PC sits
// behind a flaky phone hotspot). scp passes -o on to ssh. The perl alarm of each line stays the outer limit.
const SSH_OPTIONS = '-o BatchMode=yes -o ConnectTimeout=30';
const alarmed = (seconds) => `perl -e 'alarm ${seconds}; exec @ARGV or die "exec: $!"'`;
const remoteLine = (host, seconds, script) => `${alarmed(seconds)} ssh ${SSH_OPTIONS} ${host} '${REMOTE_PATH_EXPORT} ${script}'`;
const tail = (out) => out.trim().split('\n').slice(-TAIL_LINES).join(' | ');

/** Runs one printed shell line (all its parts were validated): the line the owner sees is the line that runs. */
function runLine(machine, line, seconds) {
  console.log(`[${machine}] ${line}`);
  return exec('sh', ['-c', line], { seconds: seconds + 30 });
}

function parseArgs(argv) {
  const flags = { '--repo': 'repo', '--tag': 'tag', '--targets': 'targets' };
  const opts = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--json') opts.json = true;
    else if (argv[index] === '--base') throw new UsageError('--base is gone: sync uses the branch checked out in --repo');
    else if (argv[index] === '--checks') throw new UsageError('--checks is gone: sync runs no suite or audit gate');
    else if (argv[index] === '--row') throw new UsageError('--row is gone: it named the STATUS row of the removed status tool');
    else if (flags[argv[index]] && argv[index + 1] !== undefined) opts[flags[argv[index]]] = argv[++index];
    else throw new UsageError(`unknown or incomplete argument ${argv[index]}`);
  }
  if (!isSyncablePath(opts.repo)) throw new UsageError('--repo must be an absolute path (or ~/...) of letters, digits and . _ / + @ : ~ -');
  if (opts.tag !== undefined && !PLAIN_TAG.test(opts.tag)) throw new UsageError('--tag must be a tag name');
  return { ...opts, targets: opts.targets?.split(','), localRepo: opts.repo.startsWith('~/') ? join(homedir(), opts.repo.slice(2)) : opts.repo };
}

/** The repo's path on a target: under the target's own home when the repo is under this machine's home, else the same path. */
function remoteCheckout(repo) {
  const relative = repo.replace(HOME_PREFIX, '');
  return relative === repo ? repo : `$HOME/${relative}`;
}

/**
 * Reads the branch checked out in --repo: the base every machine syncs to. It reaches the ssh lines, so it must be a plain name.
 * @param {string} localRepo the repo folder on this machine
 * @returns {Promise<{base: string, why: string}>} why is '' when the branch can be synced, else the verify failure
 */
async function readBase(localRepo) {
  const { status, out } = await exec('git', ['-C', localRepo, 'branch', '--show-current']);
  const base = out.trim();
  if (status !== 0) return { base: '', why: `git branch --show-current exit ${status}: ${tail(out)}` };
  if (!base) return { base, why: 'no branch checked out (detached HEAD); check out the branch to sync' };
  return { base, why: PLAIN_BASE.test(base) ? '' : `the branch "${base}" is not a plain name (letters, digits and . _ / -)` };
}

/** The verify checks in order; each returns '' when it holds, else why not. Open lanes do not matter: sync needs only a clean base. */
function verifyChecks({ localRepo, tag }, checkedOut) {
  const git = (...args) => exec('git', ['-C', localRepo, ...args]);
  const fromStatus = (result, why) => (result.status === 0 ? '' : `${why}: ${tail(result.out)}`);
  const list = [];
  if (tag) list.push(['tag', async () => fromStatus(await git('rev-parse', '--verify', '--quiet', `refs/tags/${tag}`), `no tag ${tag}`)]);
  list.push(['base branch', async () => checkedOut.why]);
  list.push(['tracked changes', async () => { const { out } = await git('status', '--porcelain', '--untracked-files=no'); return out.trim() ? `tracked changes: ${tail(out)}` : ''; }]);
  return list;
}

/** Runs the verify checks and stops at the first failure; returns its line `verify: <check> failed: <why>`, '' when all hold. */
async function verify(options, checkedOut) {
  for (const [name, check] of verifyChecks(options, checkedOut)) {
    const why = await check();
    if (why) return `verify: ${name} failed: ${why}`;
  }
  return '';
}

/** This machine's claude version, channel and DISABLE_UPDATES (its own settings.json or the shell). */
async function readLocalCli() {
  const { out } = await exec('claude', ['--version']);
  let settings = {};
  try { settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')); } catch { settings = {}; }
  return { version: /^(\d+\.\d+\.\d+)\b/m.exec(out)?.[1] ?? '', channel: settings.autoUpdatesChannel ?? 'latest', pinned: settings.env?.DISABLE_UPDATES === '1' || process.env.DISABLE_UPDATES === '1', checkout: true, pin: '' };
}

/**
 * A target's version, settings and pin as one remote script; the pin reads "" while a stale checkout has no local-settings.mjs.
 * `unreachable` holds ssh's own error when it did not reach the target, so that is not reported as a claude problem.
 */
async function readTargetCli(ctx, target) {
  const emptyPin = 'echo "{\\"cliVersion\\":\\"\\"}"';
  const script = 'scripts/install/local-settings.mjs';
  const pin = `if cd "${remoteCheckout(ctx.repo)}"; then if [ -f ${script} ]; then node ${script} targets; else ${emptyPin}; fi; else echo "NO_CHECKOUT"; fi`;
  const ran = await runLine(target.name, remoteLine(target.ssh, READ_SECONDS, `${CLAUDE_READ}; ${SETTINGS_READ}; echo "== pin"; ${pin}`), READ_SECONDS);
  return { ...readReport(ran.out), unreachable: ran.status === SSH_ERROR_EXIT ? tail(ran.out) : '' };
}

/** This machine: install, then HEAD and the claude version. */
async function syncLocal(ctx) {
  const install = await exec(join(ctx.localRepo, 'scripts', 'install.sh'), [], { cwd: ctx.localRepo });
  if (install.status !== 0) return { installExit: install.status, problem: `install.sh exit ${install.status}: ${tail(install.out)}` };
  const head = await exec('git', ['-C', ctx.localRepo, 'rev-parse', 'HEAD']);
  return { installExit: install.status, sha: head.out.trim(), after: await readLocalCli() };
}

/**
 * Takes the lock over when the pid in it runs no more (a killed sync); false while its holder runs, or the file names no pid
 * (a sync writing its pid this moment, or not a lock of ours: a link or FIFO is never read).
 */
function takeFromKilledSync(lockPath) {
  const seen = lstatSync(lockPath, { throwIfNoEntry: false });
  if (!seen) return takeLock(lockPath, Date.now(), NEVER_BY_AGE); // released meanwhile
  if (!seen.isFile()) return false;
  let holder;
  try {
    holder = Number(readFileSync(lockPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return takeLock(lockPath, Date.now(), NEVER_BY_AGE); // released between the look and the read
    throw error;
  }
  if (!Number.isInteger(holder) || holder <= 0 || isRunning(holder)) return false;
  // "Now" is the seen lock's own time and the limit 0, so only that lock is broken: a newer one taken meanwhile stays.
  return takeLock(lockPath, seen.mtimeMs, 0);
}

/**
 * One sync at a time: takes the run lock (O_EXCL, disk-free/lib/lock-file.mjs) and writes this run's pid in it.
 * @param {string} lockPath <tmp>/sync-machines.lock
 * @returns {() => void} removes the lock
 * @throws {UsageError} while another sync runs
 */
function lockRun(lockPath) {
  if (!takeLock(lockPath, Date.now(), NEVER_BY_AGE) && !takeFromKilledSync(lockPath)) {
    throw new UsageError(`another sync runs (${lockPath}); wait for it to end, or remove that file when none runs`);
  }
  writeFileSync(lockPath, String(process.pid));
  return () => releaseLock(lockPath);
}

/**
 * A target: copy the bundle (under an alarm), then ONE remote script. The target follows this machine's branch: with no tracked
 * changes there and a branch checked out, a fast-forward pull when it is on the branch, else a fetch into the branch (git refuses
 * one that is not a fast-forward) and a switch to it. A detached target is refused: a switch would leave its own commits on no
 * branch. The move comes before merge-shared because a target that is
 * behind has no local-settings.mjs until the pull (a tag target is on the previous tag, never behind, so a tag merges first);
 * the version and DISABLE_UPDATES reads come after the install, which sets the pin.
 */
async function syncTarget(ctx, target) {
  const bundle = ctx.bundles[target.name];
  const remoteBundle = `/tmp/${TEMP_PREFIX}-sync-${target.name}.bundle`;
  const remoteShared = `/tmp/${TEMP_PREFIX}-local-shared.json`;
  const made = await exec('git', ['-C', ctx.localRepo, 'bundle', 'create', bundle, ctx.tag ? `refs/tags/${ctx.tag}` : ctx.base]);
  if (made.status !== 0) return { problem: `git bundle create exit ${made.status}: ${tail(made.out)}` };
  const copied = await runLine(target.name, `${alarmed(TRANSFER_SECONDS)} scp ${SSH_OPTIONS} ${bundle} ${ctx.sharedFile} ${target.ssh}:/tmp/`, TRANSFER_SECONDS);
  if (copied.status !== 0) return { problem: `scp exit ${copied.status}: ${tail(copied.out)}` };
  const merge = `node scripts/install/local-settings.mjs merge-shared ${remoteShared}`;
  const chain = ctx.tag
    ? `${merge} && git fetch ${remoteBundle} refs/tags/${ctx.tag}:refs/tags/${ctx.tag} && scripts/install.sh --update --to ${ctx.tag}`
    : `{ [ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "tracked changes in the checkout: commit or undo them there"; false; }; } && { [ -n "$(git branch --show-current)" ] || { echo "the checkout is a detached HEAD: check out a branch there (git switch -c <name> keeps its commits)"; false; }; } && if [ "$(git branch --show-current)" = "${ctx.base}" ]; then git pull --ff-only ${remoteBundle} ${ctx.base}; else git fetch ${remoteBundle} ${ctx.base}:refs/heads/${ctx.base} && git switch -q ${ctx.base}; fi && ${merge} && scripts/install.sh`;
  // A tag install links ~/.claude to a worktree of the tag and leaves the checkout's HEAD where it was (scripts/install/pin.mjs),
  // so the sha that runs there is the tag's commit.
  const installed = ctx.tag ? `refs/tags/${ctx.tag}^{commit}` : 'HEAD';
  const script = `cd "${remoteCheckout(ctx.repo)}" || exit 3; ${chain}; code=$?; ${CLAUDE_READ}; ${SETTINGS_READ}; ${NODE_READ}; echo "== head"; git rev-parse ${installed}; exit $code`;
  const ran = await runLine(target.name, remoteLine(target.ssh, SYNC_SECONDS, script), SYNC_SECONDS);
  const after = readReport(ran.out);
  const installExit = ran.status;
  if (installExit === SSH_ERROR_EXIT) return { installExit, problem: `ssh did not reach it for the pull and install (sync again once it is reachable): ${tail(ran.out)}` };
  return installExit === 0 ? { installExit, sha: after.sha, node: after.node, after } : { installExit, node: after.node, problem: `pull or install exit ${installExit}: ${tail(ran.out)}` };
}

/** One machine's whole sync: install, the after-install checks, the sha against the tip. Always returns its row. */
async function syncMachine(ctx, name, target, before) {
  const row = { machine: name, synced: false, sha: '', installExit: null, node: '', problem: '' };
  try {
    const moved = target ? await syncTarget(ctx, target) : await syncLocal(ctx);
    row.sha = moved.sha ?? '';
    row.installExit = moved.installExit ?? null;
    row.node = moved.node ?? '';
    row.problem = moved.problem ?? afterInstallProblem(name, before, moved.after, Boolean(target));
    if (row.problem) return row;
    const tip = target ? ctx.tips.target : ctx.tips.local;
    if (row.sha !== tip) {
      row.problem = `${name}: at ${row.sha || 'an unreadable sha'} after the install, not the tip ${tip}`;
      return row;
    }
    row.synced = true;
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
  for (const row of rows) console.log(`${row.machine}: ${row.synced ? 'synced' : 'NOT synced'} sha ${row.sha || '-'} install ${row.installExit ?? '-'}${row.node ? ` node ${row.node}` : ''}${row.problem ? ` problem: ${row.problem}` : ''}`);
}

/** Under the run lock: writes this run's bundle and shared files, syncs every machine without a problem side by side, and removes them. */
async function syncAll(options, names, problems, reports) {
  const sharedFile = join(tmpdir(), `${TEMP_PREFIX}-local-shared.json`);
  const bundles = Object.fromEntries(options.targets.map((target) => [target.name, join(tmpdir(), `${TEMP_PREFIX}-sync-${target.name}.bundle`)]));
  const removeTempFiles = () => [sharedFile, ...Object.values(bundles)].forEach((path) => rmSync(path, { force: true }));
  try {
    removeTempFiles(); // a killed sync's; a link there is removed, never followed
    const shared = `${JSON.stringify(sharedPart(readLocal(join(options.localRepo, 'settings', 'local.json'))), null, 2)}\n`;
    writeFileSync(sharedFile, shared, { flag: 'wx', mode: 0o600 });
    const ctx = { ...options, sharedFile, bundles };
    return await Promise.all(names.map((name, index) => (problems[name].length > 0
      ? { machine: name, synced: false, sha: '', installExit: null, node: '', problem: problems[name].join('; ') }
      : syncMachine(ctx, name, options.targets[index - 1], reports[index]))));
  } finally {
    removeTempFiles();
  }
}

/**
 * The sha each machine must be at after its install: this machine stays on the base branch; a target goes to the base branch, or
 * to the tag's commit in a --tag run. Read after verify, which has checked that the branch (and the tag) exist.
 * @param {{localRepo: string, base: string, tag?: string}} options the parsed arguments
 * @returns {Promise<{local: string, target: string}>} the two 40-hex shas
 */
async function tipShas({ localRepo, base, tag }) {
  const sha = async (ref) => (await exec('git', ['-C', localRepo, 'rev-parse', '--verify', '--quiet', ref])).out.trim();
  const local = await sha(`refs/heads/${base}`);
  return { local, target: tag ? await sha(`refs/tags/${tag}^{commit}`) : local };
}

/** After verify: the version reads, the tips and every machine's sync; returns the base tip and the rows. */
async function syncMachines(options, config, targets, base) {
  const withBase = { ...options, base };
  const names = [config.machine, ...targets.map((target) => target.name)];
  const reports = await Promise.all([readLocalCli(), ...targets.map((target) => readTargetCli(options, target))]);
  const problems = cliProblems(names, reports, { floor: CLAUDE_FLOOR, localName: config.machine, pin: config.cliVersion });
  const tips = await tipShas(withBase);
  return { sha: tips.local, rows: await syncAll({ ...withBase, targets, tips }, names, problems, reports) };
}

/**
 * Writes this run into the sync record, merged with the record before it (sync-record.mjs). The record is the boss's view of the
 * sync and never changes its exit: one that cannot be read starts again, and one that cannot be written is a stderr line.
 * @param {{ localRepo: string, tag?: string }} options the parsed arguments
 * @param {string[]} configured every machine name, this machine first
 * @param {{ sha: string, rows: object[], problem: string }} result the base tip, the rows, why the run stopped before the machines
 */
function recordRun(options, configured, result) {
  try {
    const previous = readSyncRecord(options.localRepo);
    if (previous?.unreadable) console.error(`sync-machines: ${previous.unreadable}; writing a new record`);
    const run = { ...result, at: new Date().toISOString(), repo: options.localRepo, tag: options.tag ?? '', configured };
    writeSyncRecord(options.localRepo, nextSyncRecord(previous?.unreadable ? null : previous, run));
  } catch (error) {
    console.error(`sync-machines: the sync record was not written: ${error.message}`);
  }
}

/** Under the run lock: verify, sync every machine, print the rows, and record the run (also a verify failure or a crash). */
async function verifyAndSync(options, config, targets) {
  const configured = [config.machine, ...config.targets.map((target) => target.name)];
  const checkedOut = await readBase(options.localRepo);
  const verifyProblem = await verify(options, checkedOut);
  if (verifyProblem) {
    console.log(verifyProblem);
    recordRun(options, configured, { sha: '', rows: [], problem: verifyProblem });
    return EXIT_VERIFY;
  }
  let synced;
  try {
    synced = await syncMachines(options, config, targets, checkedOut.base);
  } catch (error) {
    recordRun(options, configured, { sha: '', rows: [], problem: `sync-machines: ${error.message}` });
    throw error;
  }
  printRows(synced.rows, options.json);
  recordRun(options, configured, { ...synced, problem: '' });
  return synced.rows.every((row) => row.synced) ? 0 : EXIT_FAILED; // synced: installed with exit 0 and at the tip
}

async function main(argv) {
  const options = parseArgs(argv);
  const { config, targets } = chooseTargets(options);
  // The temp folder holds the run lock and reaches the scp lines.
  if (!isSyncablePath(tmpdir())) throw new UsageError(`the temp folder ${tmpdir()} is not a plain path`);
  const release = lockRun(syncLockPath()); // before verify, held through the record write: one writer of the record
  try {
    return await verifyAndSync(options, config, targets);
  } finally {
    release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(`sync-machines: ${error.message}`);
    process.exitCode = error instanceof UsageError ? EXIT_USAGE : EXIT_FAILED;
  });
}
