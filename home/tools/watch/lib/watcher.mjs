// One watched session, and the guard-log follower. All I/O is injected or confined to the paths given, so tests drive them
// with temp files, a fake clock and a fake liveness check.
// Exports: createSessionWatcher(options) -> { poll(), finish() }, createGuardFollower({ path, watched, fromStart }) -> { poll() }.
// A session watcher reads new transcript lines (classify -> verbose record + action emit), checks subagent transcripts (model
// mismatch) and, unless `once`, the stall detector and the session-end check. `emit(text)` receives action lines that already
// carry the label; `record(label, text)` receives every verbose line (for the --log file).
// Invariants: a poll never throws on a missing or unreadable file; SESSION_END and each STALL are reported once.
import { actionFor } from './actions.mjs';
import { createClassifier } from './classify.mjs';
import { guardAction } from './guard.mjs';
import { findSessionPid, isProcessAlive } from './resolve.mjs';
import { createStallDetector } from './stall.mjs';
import { agentLine, createSubagentWatcher } from './subagents.mjs';
import { createTail } from './tail.mjs';

const MS_PER_MINUTE = 60_000;
const minutes = (ms) => Math.floor(ms / MS_PER_MINUTE);

/** One watched session; use createSessionWatcher. */
class SessionWatcher {
  constructor(options) {
    Object.assign(this, { isAlive: isProcessAlive, ...options });
    this.tail = createTail(this.path, { fromStart: this.once });
    this.classifier = createClassifier();
    this.agents = createSubagentWatcher(`${this.path.replace(/\.jsonl$/, '')}/subagents`, { judgeExisting: this.once });
    this.stall = createStallDetector(this.stallMs);
    this.ended = false;
  }

  feed(lines) {
    for (const event of lines.flatMap((text) => this.classifier.feed(text))) {
      this.record(this.label, event.line);
      const action = actionFor(event);
      if (action) this.emit(`${this.label}: ${action.text}`);
    }
  }

  noteWrite(mtimeMs) {
    if (mtimeMs !== undefined && (this.lastWrite === undefined || mtimeMs > this.lastWrite)) this.lastWrite = mtimeMs;
  }

  stamp() { return new Date(this.now()).toISOString(); }

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
    const verdict = this.stall.check(this.lastWrite, this.now());
    if (!verdict) return;
    if (verdict.type === 'STALL') this.emit(`${this.label}: STALL no transcript or subagent writes for ${minutes(verdict.idleMs)} min`);
    else this.emit(`${this.label}: RESUMED writing again`);
    this.record(this.label, `${this.stamp()} ${verdict.type} idle_min=${minutes(verdict.idleMs)}`);
  }

  async poll() {
    const { lines, mtimeMs } = await this.tail.poll();
    this.noteWrite(mtimeMs);
    this.feed(lines);
    await this.checkAgents();
    if (this.once || this.ended) return;
    if (await this.checkEnd()) return;
    this.checkStall();
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
 * @param {(text: string) => void} options.emit action line sink
 * @param {(label: string, text: string) => void} options.record verbose line sink
 * @returns {{ poll: () => Promise<void>, finish: () => void }}
 */
export const createSessionWatcher = (options) => new SessionWatcher(options);

/**
 * @param {{ path: string, watched: Map<string, string>, fromStart: boolean }} options guard log path and watched session ids
 * @returns {{ poll: () => Promise<string[]> }} new reportable guard lines per poll
 */
export function createGuardFollower({ path, watched, fromStart }) {
  const tail = createTail(path, { fromStart });
  return {
    async poll() {
      const { lines } = await tail.poll();
      return lines.map((line) => guardAction(line, watched)).filter((text) => text !== undefined);
    },
  };
}
