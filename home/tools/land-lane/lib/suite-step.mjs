// Purpose: step 5 of land-lane: a full-suite PASS for the rebased tip. A recorded PASS is reused; else the suite runs in the lane's worktree
//   (when its HEAD is the tip and it is clean) or in a detached temporary worktree at the tip that is always removed, and the PASS is
//   checked again after the run (test-pass writes no record from a dirty tree, so a run that exits 0 is not yet a PASS).
// Exports: suiteStep, failuresIn.
// Invariants: the suite is only ever run through `test-pass run --suite` (the repo's own declared command, no override); nothing is landed here.
//   A result is `{ ok: true, note }` or `{ ok: false, code, lines }` (code 4: red or no PASS, 14: a temporary worktree could not be made).
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, firstLine, tool } from './tools.mjs';

const SUITE_TIMEOUT_MS = 60 * 60 * 1000; // one full run of a repo's suite; a longer run counts as no PASS
const CHECK_TIMEOUT_MS = 60_000;
const TAIL_LINES = 8; // log lines shown when the log has no failure list in node's format
const FAILURE_HEADERS = new Set(['✖ failing tests:', 'Failed tests:']);

const hasPass = (repo, sha) => tool('test-pass', 'test-pass.mjs', ['check', sha, '--repo', repo, '--suite'], { timeoutMs: CHECK_TIMEOUT_MS }).ok;

/** The failing tests in a `node --test` log (spec or dot reporter): `<file>: <name>: <first error line>`; [] when the log has no such list. */
export function failuresIn(log) {
  const lines = log.split('\n');
  const start = lines.findIndex((line) => FAILURE_HEADERS.has(line.trim()));
  if (start === -1) return [];
  const found = [];
  let file = null;
  for (let i = start + 1; i < lines.length; i++) {
    const text = lines[i].trim();
    if (text.startsWith('test at ')) file = text.slice('test at '.length).replace(/:\d+:\d+$/, '');
    else if (text.startsWith('✖ ')) {
      const error = lines.slice(i + 1).find((next) => next.trim() !== '');
      found.push(`${file ?? 'a test'}: ${text.slice(2).replace(/ \([\d.]+ms\)$/, '')}: ${error?.trim() ?? 'no error line'}`);
      file = null;
    }
  }
  return found;
}

/** The lines that say why the suite is red: each failing test with its first error line, else the log's last lines, then the log path. */
function redLines(sha, logPath, ranExit) {
  const log = (() => { try { return readFileSync(logPath, 'utf8'); } catch { return ''; } })();
  const failures = failuresIn(log);
  const shown = failures.length > 0 ? failures : log.split('\n').filter((line) => line.trim() !== '').slice(-TAIL_LINES);
  return [`suite red at ${sha} (test-pass run --suite exit ${ranExit ?? 'none: stopped or timed out'})`, ...shown, `log: ${logPath}`];
}

function runSuiteIn(folder, sha) {
  const logFolder = mkdtempSync(join(tmpdir(), 'land-lane-suite-'));
  const logPath = join(logFolder, 'suite.log');
  const fd = openSync(logPath, 'w');
  const ran = tool('test-pass', 'test-pass.mjs', ['run', '--suite', '--repo', folder], { timeoutMs: SUITE_TIMEOUT_MS, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  if (ran.ok && hasPass(folder, sha)) {
    rmSync(logFolder, { recursive: true, force: true });
    return { ok: true, note: `suite PASS recorded at ${sha}` };
  }
  return { ok: false, code: 4, lines: ran.ok ? [`suite exited 0 at ${sha} but no PASS is recorded for it (a dirty tree or an unusable state folder), log: ${logPath}`] : redLines(sha, logPath, ran.status) };
}

/** True when the folder's HEAD is `sha` and `git status --porcelain` is empty (a failed git call is not clean). */
function worktreeIsTip(worktree, sha) {
  const head = git(worktree, ['rev-parse', 'HEAD']);
  const status = git(worktree, ['status', '--porcelain']);
  return head.ok && head.out === sha && status.ok && status.out === '';
}

function runInTemporaryWorktree(repo, sha) {
  const parent = mkdtempSync(join(tmpdir(), 'land-lane-wt-'));
  const folder = join(parent, 'tip');
  try {
    const added = git(repo, ['worktree', 'add', '--detach', '--quiet', '--', folder, sha]);
    if (!added.ok) return { ok: false, code: 14, lines: [`could not add the temporary worktree ${folder} for the suite run: ${firstLine(added)}`] };
    try {
      return runSuiteIn(folder, sha);
    } finally {
      git(repo, ['worktree', 'remove', '--force', '--', folder]);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
    git(repo, ['worktree', 'prune']);
  }
}

/**
 * A full-suite PASS for `sha`, from the record or from a run.
 * @param {{ repo: string, worktree: string|null }} where the base folder and the lane's worktree (null: none)
 * @param {string} sha the rebased tip
 * @returns {{ ok: true, note: string } | { ok: false, code: 4|14, lines: string[] }}
 */
export function suiteStep({ repo, worktree }, sha) {
  if (hasPass(repo, sha)) return { ok: true, note: `suite PASS already recorded at ${sha}` };
  try {
    if (worktree !== null && worktreeIsTip(worktree, sha)) return runSuiteIn(worktree, sha);
    return runInTemporaryWorktree(repo, sha);
  } catch (error) {
    // a full or missing temp folder: nothing ran and nothing landed, and the lead must see which step could not start
    return { ok: false, code: 14, lines: [`the suite step could not make its temporary folder or worktree for ${sha}: ${error.message}`] };
  }
}
