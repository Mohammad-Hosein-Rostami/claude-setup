// One watched session, and the guard-log follower. All I/O is injected or confined to the paths given, so tests drive them
// with temp files, a fake clock and a fake liveness check.
// Exports: createSessionWatcher(options) -> { poll(), finish(), failed }, createGuardFollower(options) -> { poll() }.
// A session watcher reads new transcript lines (classify -> verbose record + action emit), checks subagent transcripts (model
// mismatch) and, unless `once`, the stall detector and the session-end check. `emit(text, cls)` receives action lines that already
// carry the label, with their event class (OWNER, STALL, WATCH_ERROR, ...; see events.mjs); `record(label, text)` receives every verbose line (for the --log file). Both are wrapped so that every
// line is masked (lib/mask.mjs) before it leaves.
// Invariants: a bad line or a failing poll never stops the watcher: it becomes one rate-limited `WATCH_ERROR <label> <reason>`
// line. A file that cannot be read is reported once per failure (not per poll) and sets `failed` (the CLI exits 1 in --once).
// SESSION_END and each STALL are reported once. A gap between two polls longer than `jumpMs` (laptop sleep, suspended process)
// restarts the stall timer instead of reporting a stall nobody could have acted on.
// In follow mode the last LOOKBACK_BYTES of an existing transcript are read at start, only to learn whether a limit window is
// already open (classify.seed): nothing older than the start is reported, a line stamped after it is (it was written before the first look).
// `exitMode` (set by --exit-on-event) is for a caller that waits for one wake and must never be left waiting silently: the stall
// check goes on after SESSION_END (a class list without session-end still ends in a STALL) and a transcript that never appears
// counts as idle from the first poll. Each step of a poll runs on its own, so a failing step cannot switch off the stall check.
import { basename } from 'node:path';
import { actionFor } from './actions.mjs';
import { createClassifier } from './classify.mjs';
import { createErrorReporter } from './errors.mjs';
import { guardAction } from './guard.mjs';
import { maskText } from './mask.mjs';
import { EVENT_CLASS } from './events.mjs';
import { findSessionPids, isProcessAlive } from './resolve.mjs';
import { createStallDetector } from './stall.mjs';
import { agentLine, createSubagentWatcher } from './subagents.mjs';
import { createTail } from './tail.mjs';

const MS_PER_MINUTE = 60_000;
const DEFAULT_JUMP_MS = 2 * MS_PER_MINUTE;
const LOOKBACK_BYTES = 4 * 1024 * 1024; // a limit window is open only while the session is idle, so its LIMIT entry is near the end
const minutes = (ms) => Math.floor(ms / MS_PER_MINUTE);

/** One watched session; use createSessionWatcher. */
class SessionWatcher {
  constructor(options) {
    Object.assign(this, { isAlive: isProcessAlive, jumpMs: DEFAULT_JUMP_MS, classifier: createClassifier(), exitMode: false, ...options });
    const { emit, record } = options;
    this.emit = (text, cls) => emit(maskText(text), cls);
    this.record = (label, text) => record(label, maskText(text));
    this.errors = createErrorReporter({ now: this.now, emit: this.emit, record: this.record });
    this.tail = createTail(this.path, { fromStart: this.once, missingIsError: this.once, lookbackBytes: this.once ? 0 : LOOKBACK_BYTES });
    this.agents = createSubagentWatcher(`${this.path.replace(/\.jsonl$/, '')}/subagents`, { judgeExisting: this.once });
    this.stall = createStallDetector(this.stallMs);
    this.startedAt = this.now();
    this.ended = false;
    this.failed = false;
    this.unreadable = false;
  }

  /** How many replies of the session itself the transcript has shown so far (`--delay-sec` watches it grow). */
  get replies() { return this.classifier.assistantEntries; }

  // The tail of the file at start: old lines only teach the limit window; a line stamped after this watcher started was written
  // before its first look and is a new event.
  replayHistory(history) {
    for (const text of history) {
      try {
        this.classifier.seed(text, this.startedAt).forEach((event) => this.handle(event));
      } catch (error) {
        this.errors.report(this.label, error);
      }
    }
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
    if (action) this.emit(`${this.label}: ${action.text}`, action.cls);
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
      if (agent.mismatch) this.emit(`${this.label}: MODEL MISMATCH type=${agent.type} asked=${agent.asked} ran=${agent.ran}`, EVENT_CLASS.MODEL_MISMATCH);
    }
  }

  // The session has ended when it was registered and no process registered for it is alive any more. A session resumed in a new
  // process registers a new pid, so the registry is read again before the end is declared.
  async checkEnd() {
    if (this.pids === undefined || this.pids.length === 0) this.pids = await findSessionPids(this.sessionId, this.sessionsDir);
    if (this.pids.length === 0 || this.pids.some((pid) => this.isAlive(pid))) return false;
    const current = await findSessionPids(this.sessionId, this.sessionsDir);
    if (current.some((pid) => this.isAlive(pid))) { this.pids = current; return false; }
    this.ended = true;
    this.record(this.label, `${this.stamp()} SESSION_END pid=${this.pids[0]}`);
    this.emit(`${this.label}: SESSION_END pid=${this.pids[0]}`, EVENT_CLASS.SESSION_END);
  }

  checkStall() {
    const at = this.now();
    if (this.exitMode) this.lastWrite ??= at;
    const jumped = this.lastPollAt !== undefined && at - this.lastPollAt > this.jumpMs;
    this.lastPollAt = at;
    if (jumped && !this.stall.stalled && (this.lastWrite === undefined || at > this.lastWrite)) this.lastWrite = at;
    const verdict = this.stall.check(this.lastWrite, at);
    if (!verdict) return;
    if (verdict.type === 'STALL') this.emit(`${this.label}: STALL no transcript or subagent writes for ${minutes(verdict.idleMs)} min`, EVENT_CLASS.STALL);
    else this.emit(`${this.label}: RESUMED writing again`, EVENT_CLASS.RESUMED);
    this.record(this.label, `${this.stamp()} ${verdict.type} idle_min=${minutes(verdict.idleMs)}`);
  }

  async readTranscript() {
    const { lines, history, mtimeMs, error } = await this.tail.poll();
    this.noteReadResult(error);
    this.noteWrite(mtimeMs);
    this.replayHistory(history);
    this.feed(lines);
  }

  // A failing step is reported and the next step still runs.
  async step(action) {
    try { await action(); } catch (error) { this.errors.report(this.label, error); }
  }

  async poll() {
    await this.step(() => this.readTranscript());
    await this.step(() => this.checkAgents());
    if (this.once) return;
    if (!this.ended) await this.step(() => this.checkEnd());
    if (!this.ended || this.exitMode) await this.step(() => this.checkStall());
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
 * @param {boolean} [options.exitMode] the caller exits on the first wake event: see the header (default false)
 * @param {number} options.stallMs stall limit in milliseconds
 * @param {string} options.sessionsDir ~/.claude/sessions
 * @param {() => number} options.now clock in epoch milliseconds
 * @param {(pid: number) => boolean} [options.isAlive] liveness check (default: signal 0)
 * @param {number} [options.jumpMs] a gap between polls above this restarts the stall timer (default 2 min)
 * @param {{ feed: (text: string) => object[] }} [options.classifier] line classifier (default: the real one; tests inject a failing one)
 * @param {(text: string, cls: string) => void} options.emit action line sink; cls is the event class (OWNER, STALL, WATCH_ERROR, ...)
 * @param {(label: string, text: string) => void} options.record verbose line sink
 * @returns {{ poll: () => Promise<void>, finish: () => void, readonly failed: boolean, readonly replies: number }}
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
