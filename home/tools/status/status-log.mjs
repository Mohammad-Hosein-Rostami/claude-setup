// `status.mjs log "<text>"`: long log lines go to STATUS.log.md beside STATUS.md, never into STATUS.md, which the lead re-reads
// after every compaction (the ICE STATUS.md grew to 130,633 bytes, 53,092 of them its `## Log`; spec-p5 `r9-status-cli`, O4).
// Exports: appendLog(statusFile, text, now, deps) -> { code, message }; LOG_NAME.
// Git: in a repo the log file is hidden first: `/<path>/STATUS.log.md` goes into the repo's info/exclude unless git already ignores
// it; when STATUS.md itself is tracked the log is refused (exit 2), since a log beside a tracked file would be committed or would
// leave the tree dirty (an untracked, not-ignored file also stops test-pass recording a PASS). Outside a repo it just appends.
// Invariants: STATUS.md is never opened for writing; each git call has its own timeout and fixed flags; a git failure other than
// "not a repo" refuses the write (exit 1) rather than risk a visible file; the text is one line (line breaks become spaces).
import { execFileSync } from 'node:child_process';
import { appendFileSync, lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

export const LOG_NAME = 'STATUS.log.md';
const GIT_TIMEOUT_MS = 2000;
const NOT_A_REPO = 128; // git's exit code outside a work tree
const EXIT_REFUSED = 1;
const EXIT_TRACKED = 2;
const MAX_LOG_CHARS = 2000;

/** Runs git in `folder`; returns { ok, out, status }. Never throws. */
function git(folder, args) {
  try {
    return { ok: true, out: execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }).trim(), status: 0 };
  } catch (error) {
    return { ok: false, out: '', status: typeof error.status === 'number' ? error.status : -1 };
  }
}

/** Adds the exclude line for the log unless git already ignores it; returns an error text or null. */
function hideInRepo(folder, top, logPath) {
  if (git(folder, ['check-ignore', '-q', '--', logPath]).ok) return null;
  const exclude = git(folder, ['rev-parse', '--git-path', 'info/exclude']);
  if (!exclude.ok) return 'cannot find the repository\'s info/exclude';
  const excludePath = resolve(folder, exclude.out);
  const line = `/${relative(top, logPath).split('\\').join('/')}`;
  let existing = '';
  try {
    existing = readFileSync(excludePath, 'utf8');
  } catch {
    existing = ''; // no exclude file yet: appendFileSync makes it
  }
  if (!existing.split('\n').includes(line)) appendFileSync(excludePath, `${existing === '' || existing.endsWith('\n') ? '' : '\n'}${line}\n`);
  return null;
}

/**
 * @param {string} statusFile the real path of STATUS.md
 * @param {string} text the log line
 * @param {Date} now the clock
 * @returns {{ code: number, message: string }} 0 when appended; 1 refused (git unusable, a link at the log path); 2 STATUS.md is tracked
 */
export function appendLog(statusFile, text, now) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_LOG_CHARS);
  if (line === '') return { code: EXIT_TRACKED, message: 'log needs "<text>"' };
  const folder = dirname(statusFile);
  const logPath = join(folder, LOG_NAME);
  const top = git(folder, ['rev-parse', '--show-toplevel']);
  if (top.ok) {
    if (git(folder, ['ls-files', '--error-unmatch', '--', basename(statusFile)]).ok) {
      return { code: EXIT_TRACKED, message: `${statusFile} is tracked by git: a log beside it would show in the repo; untrack STATUS.md first (it is a work note)` };
    }
    const failure = hideInRepo(folder, top.out, logPath);
    if (failure) return { code: EXIT_REFUSED, message: `log: ${failure}; nothing written` };
  } else if (top.status !== NOT_A_REPO) {
    return { code: EXIT_REFUSED, message: 'log: git did not answer; nothing written' };
  }
  try {
    if (!lstatSync(logPath, { throwIfNoEntry: false })?.isFile() && lstatSync(logPath, { throwIfNoEntry: false })) {
      return { code: EXIT_REFUSED, message: `${logPath} is not a regular file: refused` };
    }
    appendFileSync(logPath, `- ${now.toISOString().slice(0, 16)}Z ${line}\n`, { mode: 0o600 });
  } catch (error) {
    return { code: EXIT_REFUSED, message: `cannot write ${logPath}: ${error.code ?? error.message}` };
  }
  return { code: 0, message: `log: ok (${logPath})` };
}
