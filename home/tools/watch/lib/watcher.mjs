// One watched session, and the guard-log follower. All I/O is injected or confined to the paths given, so tests drive them
// with temp files, a fake clock and a fake liveness check.
// Exports: createSessionWatcher(options) -> { poll(), finish(), failed }, createGuardFollower(options) -> { poll() }.
// A session watcher reads new transcript lines (classify -> verbose record + action emit), checks subagent transcripts (model
// mismatch) and, unless `once`, the stall detector and the session-end check. `emit(text)` receives action lines that already
// carry the label; `record(label, text)` receives every verbose line (for the --log file). Both are wrapped so that every
// line is masked (lib/mask.mjs) before it leaves.
// Invariants: a bad line or a failing poll never stops the watcher: it becomes one rate-limited `WATCH_ERROR <label> <reason>`
// line. A file that cannot be read is reported once per failure (not per poll) and sets `failed` (the CLI exits 1 in --once).
// SESSION_END and each STALL are reported once. A gap between two polls longer than `jumpMs` (laptop sleep, suspended process)
// restarts the stall timer instead of reporting a stall nobody could have acted on.
import { basename } from 'node:path';
import { actionFor } from './actions.mjs';
import { createClassifier } from './classify.mjs';
import { createErrorReporter } from './errors.mjs';
import { guardAction } from './guard.mjs';
import { maskText } from './mask.mjs';
import { findSessionPid, isProcessAlive } from './resolve.mjs';
import { createStallDetector } from './stall.mjs';
import { agentLine, createSubagentWatcher } from './subagents.mjs';
import { createTail } from './tail.mjs';

const MS_PER_MINUTE = 60_000;
const DEFAULT_JUMP_MS = 2 * MS_PER_MINUTE;
const minutes = (ms) => Math.floor(ms / MS_PER_MINUTE);

/** One watched session; use createSessionWatcher. */
class SessionWatcher {
  constructor(options) {
    Object.assign(this, { isAlive: isProcessAlive, jumpMs: DEFAULT_JUMP_MS, classifier: createClassifier(), ...options });
    const { emit, record } = options;
    this.emit = (text) => emit(maskText(text));
    this.record = (label, text) => record(label, maskText(text));
    this.errors = createErrorReporter({ now: this.now, emit: this.emit, record: this.record });
    this.tail = createTail(this.path, { fromStart: this.once, missingIsError: this.once });
    this.agents = createSubagentWatcher(`${this.path.replace(/\.jsonl$/, '')}/subagents`, { judgeExisting: this.once });
    this.stall = createStallDetector(this.stallMs);
    this.ended = false;
    this.failed = false;
    this.unreadable = false;
  }

  feed(lines) {
    for (const text of lines) {
      try {
        for (const event of this.classifier.feed(text)) this.handle(event);
      } catch (error) {
        this.errors.report(this.label, error);
      }
    }
  }

  handle(event) {
    this.record(this.label, event.line);
    const action = actionFor(event);
    if (action) this.emit(`${this.label}: ${action.text}`);
  }

  noteWrite(mtimeMs) {
    if (mtimeMs !== undefined && (this.lastWrite === undefined || mtimeMs > this.lastWrite)) this.lastWrite = mtimeMs;
  }

  stamp() { return new Date(this.now()).toISOString(); }

  // One report per failure, not per poll; reading again successfully re-arms it.
  noteReadResult(error) {
    if (error === undefined) { this.unreadable = false; return; }
    this.failed = true;
    if (this.unreadable) return;
    this.unreadable = true;
    this.errors.report(this.label, `cannot read ${basename(this.path)} (${error})`);
  }

  async checkAgents() {
    const found = await this.agents.poll();
    this.noteWrite(found.mtimeMs);
    for (const agent of found.agents) {
      this.record(this.label, `${this.stamp()} ${agentLine(agent)}`);
      if (agent.mismatch) this.emit(`${this.label}: MODEL MISMATCH type=${agent.type} asked=${agent.asked} ran=${agent.ran}`);
    }
  }

  async checkEnd() {
    this.pid ??= await findSessionPid(this.sessionId, this.sessionsDir);
    if (this.pid === undefined || this.isAlive(this.pid)) return false;
    this.ended = true;
    this.record(this.label, `${this.stamp()} SESSION_END pid=${this.pid}`);
    this.emit(`${this.label}: SESSION_END pid=${this.pid}`);
    return true;
  }

  checkStall() {
    const at = this.now();
    const jumped = this.lastPollAt !== undefined && at - this.lastPollAt > this.jumpMs;
    this.lastPollAt = at;
    if (jumped && !this.stall.stalled && (this.lastWrite === undefined || at > this.lastWrite)) this.lastWrite = at;
    const verdict = this.stall.check(this.lastWrite, at);
    if (!verdict) return;
    if (verdict.type === 'STALL') this.emit(`${this.label}: STALL no transcript or subagent writes for ${minutes(verdict.idleMs)} min`);
    else this.emit(`${this.label}: RESUMED writing again`);
    this.record(this.label, `${this.stamp()} ${verdict.type} idle_min=${minutes(verdict.idleMs)}`);
  }

  async pollOnce() {
    const { lines, mtimeMs, error } = await this.tail.poll();
    this.noteReadResult(error);
    this.noteWrite(mtimeMs);
    this.feed(lines);
    await this.checkAgents();
    if (this.once || this.ended) return;
    if (await this.checkEnd()) return;
    this.checkStall();
  }

  async poll() {
    try { await this.pollOnce(); } catch (error) { this.errors.report(this.label, error); }
  }

  /** Processes an unterminated last line (only a complete JSON object is used; anything else is dropped). */
  finish() { this.feed(this.tail.finish()); }
}

/**
 * @param {object} options
 * @param {string} options.path main transcript
 * @param {string} options.label short session label
 * @param {string} options.sessionId full session id (names the subagents dir and finds the pid)
 * @param {boolean} options.once read what is there now, no stall or session-end checks
 * @param {number} options.stallMs stall limit in milliseconds
 * @param {string} options.sessionsDir ~/.claude/sessions
 * @param {() => number} options.now clock in epoch milliseconds
 * @param {(pid: number) => boolean} [options.isAlive] liveness check (default: signal 0)
 * @param {number} [options.jumpMs] a gap between polls above this restarts the stall timer (default 2 min)
 * @param {{ feed: (text: string) => object[] }} [options.classifier] line classifier (default: the real one; tests inject a failing one)
 * @param {(text: string) => void} options.emit action line sink
 * @param {(label: string, text: string) => void} options.record verbose line sink
 * @returns {{ poll: () => Promise<void>, finish: () => void, readonly failed: boolean }}
 */
export const createSessionWatcher = (options) => new SessionWatcher(options);

/**
 * @param {{ path: string, watched: Map<string, string>, fromStart: boolean, onError?: (reason: string) => void }} options guard log path and
 *   watched session ids; onError gets "cannot read <file> (<code>)" once per failure
 * @returns {{ poll: () => Promise<string[]>, readonly failed: boolean }} new reportable guard lines per poll
 */
export function createGuardFollower({ path, watched, fromStart, onError = () => {} }) {
  const tail = createTail(path, { fromStart });
  let unreadable = false;
  let failed = false;
  return {
    get failed() { return failed; },
    async poll() {
      const { lines, error } = await tail.poll();
      if (error === undefined) unreadable = false;
      else {
        failed = true;
        if (!unreadable) onError(`cannot read ${basename(path)} (${error})`);
        unreadable = true;
      }
      return lines.map((line) => guardAction(line, watched)).filter((text) => text !== undefined);
    },
  };
}
