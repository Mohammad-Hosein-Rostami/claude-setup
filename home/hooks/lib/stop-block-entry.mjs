// The chain entry of the Stop-block counter (lib/stop-block-count.mjs): how one block changes it, and how the counts file is kept small.
// Exports: nextEntry(entry, facts) (pure), entryOf(stored), eventKey(input), parseCounts(text), countsText(agents, agent, entry),
// MAX_COUNTS_BYTES.
// Entry: {n, at, key, hooks, eventHooks, recorded}. n is the chain's count of continuations, at the last block, key the hash of the
// event's stop_hook_active and reply, hooks every hook of the chain, eventHooks those that blocked in the last event.
// Invariants: nothing here touches the disk or the clock; the counts file never passes MAX_COUNTS_BYTES, and the agent just counted is
// always kept (the oldest others are dropped first).
import { createHash } from 'node:crypto';

const SAME_EVENT_MS = 10 * 60 * 1000; // above the longest Stop hook timeout: parallel gates of one event finish within it
const AGENTS_KEPT = 100;
const MAX_HOOKS_KEPT = 8; // the 7 blocking gates and one spare
const EVENT_KEY_CHARS = 16; // hex characters of the reply hash: enough to tell two replies apart, short to keep the entry small
export const MAX_COUNTS_BYTES = 64 * 1024; // AGENTS_KEPT entries of at most about 600 bytes (an agent id, a short key, two lists of MAX_HOOKS_KEPT gate names)

const lastNames = (names) => names.slice(-MAX_HOOKS_KEPT);

/**
 * The chain entry after one block: the block joins the last event (same count) when it is of the same reply and event flag, within
 * SAME_EVENT_MS, of a hook that has not blocked in it, and its gate started before the last block; else it is the next continuation.
 * @param {{n: number, at: number, key: string, hooks: string[], eventHooks: string[], recorded: boolean}} entry the chain so far
 * @param {{hook: string, key: string, now: number, resetAt: number, continued: boolean, startedAt: number}} facts this block
 */
export function nextEntry(entry, { hook, key, now, resetAt, continued, startedAt }) {
  const toolCallSince = resetAt > entry.at;
  const startedBeforeLastBlock = startedAt < entry.at;
  const sameEvent = entry.n > 0 && !toolCallSince && entry.key === key && now - entry.at < SAME_EVENT_MS && startedBeforeLastBlock && !entry.eventHooks.includes(hook);
  const hooks = lastNames([...new Set([...entry.hooks, hook])]);
  if (sameEvent) return { ...entry, at: now, hooks, eventHooks: lastNames([...entry.eventHooks, hook]) };
  if (!continued || toolCallSince || entry.n === 0) return { n: 1, at: now, key, hooks: [hook], eventHooks: [hook], recorded: false };
  return { n: entry.n + 1, at: now, key, hooks, eventHooks: [hook], recorded: entry.recorded };
}

/** The counts text: `agent` moves to the newest place, the newest AGENTS_KEPT stay, and the oldest others go until it fits MAX_COUNTS_BYTES. */
export function countsText(agents, agent, entry) {
  const others = Object.entries(agents).filter(([name]) => name !== agent);
  const kept = [...others, [agent, entry]].slice(-AGENTS_KEPT);
  let text = JSON.stringify({ agents: Object.fromEntries(kept) });
  while (kept.length > 1 && Buffer.byteLength(text) > MAX_COUNTS_BYTES) {
    kept.shift();
    text = JSON.stringify({ agents: Object.fromEntries(kept) });
  }
  return text;
}

/** Parses the counts store; a corrupt file reads as empty (a chain may then be undercounted once). */
export function parseCounts(text) {
  try {
    const agents = text === null ? {} : JSON.parse(text)?.agents;
    return agents !== null && typeof agents === 'object' ? agents : {};
  } catch {
    return {};
  }
}

const emptyEntry = () => ({ n: 0, at: 0, key: '', hooks: [], eventHooks: [], recorded: false });
// An entry stored before `eventHooks` existed reads as an event no hook has blocked in (the old merge rule, once).
export const entryOf = (value) => (Number.isFinite(value?.n) && Number.isFinite(value?.at) && Array.isArray(value?.hooks)
  ? { ...value, eventHooks: Array.isArray(value.eventHooks) ? value.eventHooks : [] }
  : emptyEntry());
export const eventKey = (input) => createHash('sha256').update(`${input.stop_hook_active === true}\0${String(input.last_assistant_message ?? '')}`).digest('hex').slice(0, EVENT_KEY_CHARS);

