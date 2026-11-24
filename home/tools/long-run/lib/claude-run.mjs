// Purpose: one `claude -p` start of a step (spec 7.4): its arguments, the scrubbed log stream, the result line, a graceful end
//   (now or at the next safe point, spec 19.2), and the exhaustive classification of how it ended (spec 7.2, 5).
// Exports: KILL_AFTER, LOG_MAX_BYTES, SAFE_POINT_MAX_MS, claudeArgs, startClaude, classify, parseVerdict, scrub.
// Invariants: the prompt goes on stdin, never argv; the token is only in the child env (claude-child.mjs childEnv drops every
//   billing variable, CLAUDE_CODE_RETRY_WATCHDOG* and CLAUDECODE); every stdout and stderr line is scrubbed of the token and any
//   token-shaped text before it is written; no `--bare`, no permission flag, no `--max-turns` (owner decisions O2, O4); the exit
//   code alone never makes a step done; an unknown result subtype is `crash`.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { callErrorClass } from '../../account/lib/claude-call.mjs';
import { TOKEN_SHAPED, childEnv, claudeLaunch } from '../../account/lib/claude-child.mjs';
import { PRIVATE_FILE_MODE } from '../../account/lib/private-fs.mjs';
import { LIMIT_TEXT } from './limit-time.mjs';

/** Graceful end: SIGINT at once, SIGTERM after `term`, SIGKILL (or `taskkill /F`) after `kill` milliseconds. */
export const KILL_AFTER = { term: 10 * 1000, kill: 20 * 1000 };
/** Past this size a step log keeps only `result` lines (and one note that it was cut). */
export const LOG_MAX_BYTES = 50 * 1024 * 1024;
/** `tell` waits at most this long for a safe point before it ends the child anyway (spec 19.2). */
export const SAFE_POINT_MAX_MS = 120 * 1000;
const DROPPED_ENV = /^(?:CLAUDE_CODE_RETRY_WATCHDOG.*|CLAUDECODE)$/;
// What `claude --resume` prints for a session it cannot find (older than the 30-day transcript retention, or never written).
const NO_CONVERSATION = /no conversation found/i;
const VERDICT = /^STEP-RESULT:\s*(done|blocked|needs-owner)\s*(?::\s*(.*))?$/;
const SUMMARY_MAX_CHARS = 600;
const STDERR_TAIL_CHARS = 4000;
const TRUNCATED_NOTE = '{"type":"long-run","note":"log truncated"}\n';

/** Text with the token and any token-shaped text replaced by `<token>`. */
export const scrub = (text, token) => (token ? String(text).split(token).join('<token>') : String(text)).replace(TOKEN_SHAPED, '<token>');

/**
 * @param {{model: string, effort: string | null, sessionId: string, resume: boolean}} start
 * @returns {string[]} `-p --output-format stream-json --verbose --model <m> [--effort <e>]` and `--session-id`/`--resume <id>`.
 */
export function claudeArgs({ model, effort, sessionId, resume }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model];
  if (effort) args.push('--effort', effort);
  args.push(resume ? '--resume' : '--session-id', sessionId);
  return args;
}

function openLog(path) {
  const fd = openSync(path, 'a', PRIVATE_FILE_MODE);
  let bytes = 0;
  let truncated = false;
  return {
    write(line, isResult) {
      const text = `${line}\n`;
      if (bytes + Buffer.byteLength(text) > LOG_MAX_BYTES && !isResult) {
        if (!truncated) writeSync(fd, TRUNCATED_NOTE);
        truncated = true;
        return;
      }
      bytes += Buffer.byteLength(text);
      writeSync(fd, text);
    },
    close: () => closeSync(fd),
  };
}

const isSafePoint = (event) => event?.type === 'result'
  || (event?.type === 'user' && Array.isArray(event.message?.content) && event.message.content.some((part) => part?.type === 'tool_result'));

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null; // a plain text line of the child: kept in the log, not an event
  }
}

function killTree(child, platform, signal, runner) {
  if (platform === 'win32') {
    runner('taskkill', ['/PID', String(child.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])], { windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error; // ESRCH: the group is already gone
  }
}

/**
 * Starts one `claude -p` child.
 * @param {{args: string[], prompt: string, cwd: string, env: object, token: string, added: object, logBase: string,
 *   platform?: string, killAfter?: {term: number, kill: number}, runner?: Function}} start `added`: the labels for the child env;
 *   `logBase`: `<run>/logs/<id>.<start>` (the stream goes to `.jsonl`, stderr to `.stderr.log`); `runner` stands in for spawnSync.
 * @returns {{pid: number, done: Promise<object>, end: (reason: string) => void, endAtSafePoint: (reason: string, maxMs?: number) => void}}
 *   `done` resolves with `{exitCode, signal, result, stderrTail, endedBy, endedHow, error}`; it never rejects.
 */
export function startClaude({ args, prompt, cwd, env, token, added, logBase, platform = process.platform, killAfter = KILL_AFTER, runner = spawnSync }) {
  const launch = claudeLaunch(platform, args);
  const child = spawn(launch.command, launch.args, {
    cwd, env: childEnv(env, { ...added, CLAUDE_CODE_OAUTH_TOKEN: token }, DROPPED_ENV), shell: launch.shell,
    detached: platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const out = openLog(`${logBase}.jsonl`);
  const err = openLog(`${logBase}.stderr.log`);
  const state = { result: null, stderrTail: '', endedBy: null, endedHow: 'exit', timers: [], safePoint: null };
  const end = (reason) => {
    if (state.endedBy !== null || child.exitCode !== null) return;
    state.endedBy = reason;
    state.endedHow = platform === 'win32' ? 'taskkill' : 'SIGINT';
    killTree(child, platform, 'SIGINT', runner);
    state.timers.push(setTimeout(() => { state.endedHow = 'SIGTERM'; killTree(child, platform, 'SIGTERM', runner); }, killAfter.term));
    state.timers.push(setTimeout(() => { state.endedHow = platform === 'win32' ? 'taskkill /F' : 'SIGKILL'; killTree(child, platform, 'SIGKILL', runner); }, killAfter.kill));
  };
  const endAtSafePoint = (reason, maxMs = SAFE_POINT_MAX_MS) => {
    if (state.safePoint !== null) return;
    state.safePoint = reason;
    state.timers.push(setTimeout(() => end(reason), maxMs));
  };
  createInterface({ input: child.stdout }).on('line', (raw) => {
    const line = scrub(raw, token);
    const event = parseLine(line);
    if (event?.type === 'result') state.result = event;
    out.write(line, event?.type === 'result');
    if (state.safePoint !== null && isSafePoint(event)) end(state.safePoint);
  });
  createInterface({ input: child.stderr }).on('line', (raw) => {
    const line = scrub(raw, token);
    state.stderrTail = `${state.stderrTail}${line}\n`.slice(-STDERR_TAIL_CHARS);
    err.write(line, false);
  });
  child.stdin.on('error', () => {}); // the child may exit before it reads the prompt; `close` reports how it ended
  child.stdin.end(prompt);
  const done = new Promise((resolve) => {
    let spawnError = null;
    child.once('error', (error) => { spawnError = error.code === 'ENOENT' ? 'claude is not on PATH' : scrub(error.message, token); });
    child.once('close', (exitCode, signal) => {
      for (const timer of state.timers) clearTimeout(timer);
      out.close();
      err.close();
      resolve({ exitCode, signal, result: state.result, stderrTail: state.stderrTail, endedBy: state.endedBy, endedHow: state.endedHow, error: spawnError });
    });
  });
  return { pid: child.pid, done, end, endAtSafePoint };
}

/**
 * The verdict line of a final message.
 * @param {string} text the `result` text.
 * @returns {{verdict: 'done' | 'blocked' | 'needs-owner' | null, reason: string, summary: string}} `summary`: the text without the
 *   verdict line, at most 600 characters.
 */
export function parseVerdict(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').trimEnd().split('\n');
  const match = VERDICT.exec((lines.at(-1) ?? '').trim());
  const body = match ? lines.slice(0, -1) : lines;
  const summary = body.join('\n').trim().slice(0, SUMMARY_MAX_CHARS);
  return { verdict: match ? match[1] : null, reason: match?.[2]?.trim() ?? '', summary };
}

const ENDED_BY = { pause: 'paused', stop: 'stopped', takeover: 'taken-over', timeout: 'timeout', tell: 'told' };

function classifySuccess(run) {
  if (run.result.is_error || run.exitCode !== 0) return { outcome: 'crash', detail: `exit ${run.exitCode}, is_error ${run.result.is_error}` };
  const { verdict, reason, summary } = parseVerdict(run.result.result);
  switch (verdict) {
    case 'done': return { outcome: 'done', summary };
    case 'blocked': return { outcome: 'blocked', reason, summary };
    case 'needs-owner': return { outcome: 'needs-owner', question: reason, summary };
    case null: return { outcome: 'no-verdict', summary };
    default: throw new Error(`unknown verdict ${verdict}`);
  }
}

/**
 * How a start ended (spec 7.2 step 2), before the step check.
 * @param {{exitCode: number | null, result: object | null, stderrTail: string, endedBy: string | null, error: string | null}} run
 * @returns {{outcome: string, summary?: string, reason?: string, question?: string, detail?: string, limitText?: string}}
 *   outcome one of done, limit, auth, max-turns, timeout, crash, no-verdict, blocked, needs-owner, paused, stopped, taken-over, told.
 */
export function classify(run) {
  if (run.endedBy !== null) return { outcome: ENDED_BY[run.endedBy] ?? 'crash', detail: run.endedBy };
  const errors = Array.isArray(run.result?.errors) ? run.result.errors.map(String).join('\n') : '';
  const text = [run.result?.result ?? '', errors, run.stderrTail, run.error ?? ''].join('\n');
  const failed = run.result === null || run.result.is_error === true || run.result.subtype !== 'success';
  if (failed && callErrorClass(text) === 'auth') return { outcome: 'auth', detail: 'login missing or refused' };
  if (failed && LIMIT_TEXT.test(text)) return { outcome: 'limit', limitText: text };
  if (run.result === null) return { outcome: 'crash', detail: run.error ?? `exit ${run.exitCode} without a result line`, noConversation: NO_CONVERSATION.test(text) };
  switch (run.result.subtype) {
    case 'success': return classifySuccess(run);
    case 'error_max_turns': return { outcome: 'max-turns', detail: 'error_max_turns' };
    case 'error_during_execution':
    case 'error_max_budget_usd':
    case 'error_max_structured_output_retries': return { outcome: 'crash', detail: run.result.subtype };
    default: return { outcome: 'crash', detail: `unknown result subtype ${String(run.result.subtype).slice(0, 40)}` };
  }
}
