// The machine-wide queue of `suite run`: at most `slots` suites run at once, the others wait their turn in arrival order.
// Exports: acquireSlot, queueState, HOLDER_MAX_MS.
// Layout under the state folder (one folder for every session and worktree, so two sessions share one queue):
//   tickets/<ms>-<pid>   one per waiter, JSON {pid, since, repo, command}; rewritten at every check, so its time shows it is alive
//   slots/<i>/           one folder per running suite (mkdir is atomic: only one process can make it), with holder.json
//                        {pid, startedAt, repo, command, token}
// Invariants:
// - Arrival order: a waiter takes a slot only when fewer waiters are ahead of it than slots are free.
// - A crashed holder never blocks the queue for good: a holder whose pid is gone, that is older than HOLDER_MAX_MS or has no valid
//   pid or start time, or a slot folder that got no holder.json within HOLDER_WRITE_GRACE_MS, is removed by the next waiter. A ticket whose pid is gone or that
//   was not rewritten for TICKET_STALE_MS is removed the same way.
// - Release removes the slot only while it still holds this run's token, so it never frees a slot another run took.
// - Left over: a holder that takes a slot in the instant between another waiter's stale check of that slot and its rename can lose
//   the slot; then one more suite runs than `slots` allows, once. The queue only limits load, so that costs time, never a result.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHECK_MS = 2000; // how often a waiter looks again; the wait happens here, so agents never poll
export const HOLDER_MAX_MS = (2 * 60 + 10) * 60 * 1000; // 2 h 10 min: past the 2 h command timeout agents use, nobody waits on it
const TICKET_STALE_MS = 30_000; // 15 missed checks: the waiter is gone (also when its pid was reused by another process)
const HOLDER_WRITE_GRACE_MS = 10_000; // a slot folder without holder.json this long was left by a crash between mkdir and write
const SLOT_NAME = /^\d+$/;
const TICKET_NAME = /^(\d+)-(\d+)$/;

// Tickets sort by their time, then by pid: the oldest waiter first.
const ticketOrder = (name) => TICKET_NAME.exec(name).slice(1, 3).map(Number);
const byArrival = (a, b) => {
  const [[msA, pidA], [msB, pidB]] = [ticketOrder(a), ticketOrder(b)];
  return msA - msB || pidA - pidB;
};

const folders = (stateDir) => ({ slots: join(stateDir, 'slots'), tickets: join(stateDir, 'tickets') });

/** @returns {boolean} false only when the process is known to be gone (ESRCH); EPERM means it runs under another user */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

/** The parsed JSON file at `path`, or null when it is missing or not (yet) valid JSON. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

/** The entry names of `folder` that match `pattern`; none when the folder does not exist. */
function namesIn(folder, pattern) {
  try {
    return readdirSync(folder).filter((name) => pattern.test(name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/** True when the slot folder's holder no longer runs, is too old, was never written, or has no valid pid or start time. */
function isStaleSlot(slotDir, holder) {
  if (holder === null) {
    const stats = statSync(slotDir, { throwIfNoEntry: false });
    return stats !== undefined && Date.now() - stats.mtimeMs > HOLDER_WRITE_GRACE_MS;
  }
  // a holder nobody can judge (`{}`, a planted or foreign file) would hold its slot for good
  const startedAt = Date.parse(holder.startedAt);
  if (!Number.isInteger(holder.pid) || holder.pid <= 0 || !Number.isFinite(startedAt)) return true;
  return !isAlive(holder.pid) || Date.now() - startedAt > HOLDER_MAX_MS;
}

/** Removes the stale slot folders. Renamed aside first, so of many waiters on one stale slot only one removes it. */
function reclaimStaleSlots(slotsDir) {
  for (const name of namesIn(slotsDir, SLOT_NAME)) {
    const slotDir = join(slotsDir, name);
    if (!isStaleSlot(slotDir, readJson(join(slotDir, 'holder.json')))) continue;
    const aside = join(slotsDir, `.stale-${name}-${process.pid}-${Date.now()}`);
    try {
      renameSync(slotDir, aside);
    } catch (error) {
      if (error.code === 'ENOENT') continue; // another waiter removed it first
      throw error;
    }
    rmSync(aside, { recursive: true, force: true });
  }
}

/** The live tickets in arrival order (oldest first); stale ones are removed on the way. */
function liveTickets(ticketsDir) {
  const live = [];
  for (const name of namesIn(ticketsDir, TICKET_NAME)) {
    const path = join(ticketsDir, name);
    const stats = statSync(path, { throwIfNoEntry: false });
    if (stats === undefined) continue;
    const [, pid] = ticketOrder(name);
    if (isAlive(pid) && Date.now() - stats.mtimeMs <= TICKET_STALE_MS) live.push(name);
    else rmSync(path, { force: true });
  }
  return live.sort(byArrival);
}

/** Makes this waiter's ticket `<ms>-<pid>` (a name taken in the same millisecond moves on by one ms); returns its path. */
function takeTicket(ticketsDir, text) {
  for (let ms = Date.now(); ; ms += 1) {
    const path = join(ticketsDir, `${ms}-${process.pid}`);
    try {
      writeFileSync(path, text, { flag: 'wx' });
      return path;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

/** True when fewer live waiters are ahead of `ticketPath` than slots 0..slots-1 are free. */
function isMyTurn({ slots: slotsDir, tickets: ticketsDir }, ticketPath, slots) {
  const ahead = liveTickets(ticketsDir).indexOf(ticketPath.slice(ticketsDir.length + 1));
  const held = namesIn(slotsDir, SLOT_NAME).filter((name) => Number(name) < slots).length;
  return ahead >= 0 && ahead < slots - held;
}

/** Takes the first free slot folder of 0..slots-1 and writes its holder; returns the held slot, or null when all are taken. */
function takeFreeSlot(slotsDir, slots, label) {
  for (let index = 0; index < slots; index += 1) {
    const slotDir = join(slotsDir, String(index));
    try {
      mkdirSync(slotDir);
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    const holder = { pid: process.pid, startedAt: new Date().toISOString(), ...label, token: randomBytes(16).toString('hex') };
    // write aside, then rename: a stale check never reads half a holder
    writeFileSync(join(slotDir, 'holder.json.tmp'), JSON.stringify(holder));
    renameSync(join(slotDir, 'holder.json.tmp'), join(slotDir, 'holder.json'));
    return heldSlot(slotDir, holder.token);
  }
  return null;
}

/** The handle of a held slot: release() removes the slot folder while it still holds `token`; it also runs at process exit. */
function heldSlot(slotDir, token) {
  const release = () => {
    process.removeListener('exit', release);
    if (readJson(join(slotDir, 'holder.json'))?.token === token) rmSync(slotDir, { recursive: true, force: true });
  };
  process.once('exit', release);
  return { release };
}

/**
 * Waits until this process may run a suite, then holds a slot for it. Checks every CHECK_MS; a stale holder or ticket is removed.
 * The ticket is removed when the slot is taken and at process exit (a signal handler that exits leaves none).
 * @param {{ stateDir: string, slots: number, label: { repo: string, command: string } }} options the state folder, how many suites may
 *   run at once (slot folders 0..slots-1), and what `suite status` shows for this run
 * @returns {Promise<{ release(): void }>} release frees the slot; it is safe to call twice and also runs at process exit
 */
export async function acquireSlot({ stateDir, slots, label }) {
  const dirs = folders(stateDir);
  mkdirSync(dirs.tickets, { recursive: true });
  const text = JSON.stringify({ pid: process.pid, since: new Date().toISOString(), ...label });
  const ticketPath = takeTicket(dirs.tickets, text);
  const dropTicket = () => rmSync(ticketPath, { force: true });
  process.once('exit', dropTicket);
  try {
    for (;;) {
      // made again at every check: the state folder may be deleted at any time
      mkdirSync(dirs.slots, { recursive: true });
      mkdirSync(dirs.tickets, { recursive: true });
      writeFileSync(ticketPath, text); // the new time shows this waiter is alive; also brings back a ticket removed as stale
      reclaimStaleSlots(dirs.slots);
      const slot = isMyTurn(dirs, ticketPath, slots) ? takeFreeSlot(dirs.slots, slots, label) : null;
      if (slot !== null) return slot;
      await sleep(CHECK_MS);
    }
  } finally {
    process.removeListener('exit', dropTicket);
    dropTicket();
  }
}

/**
 * What `suite status` prints: every slot folder with its holder, and every waiter in arrival order. Only reads.
 * @param {string} stateDir the suite state folder
 * @returns {{ holders: { slot: string, holder: object | null, stale: boolean }[], waiters: object[] }} a holder is the parsed
 *   holder.json (null while it is being written); a waiter is the parsed ticket
 */
export function queueState(stateDir) {
  const { slots: slotsDir, tickets: ticketsDir } = folders(stateDir);
  const holders = namesIn(slotsDir, SLOT_NAME).sort((a, b) => Number(a) - Number(b)).map((slot) => {
    const holder = readJson(join(slotsDir, slot, 'holder.json'));
    return { slot, holder, stale: isStaleSlot(join(slotsDir, slot), holder) };
  });
  const waiters = namesIn(ticketsDir, TICKET_NAME)
    .sort(byArrival)
    .map((name) => readJson(join(ticketsDir, name)))
    .filter((ticket) => ticket !== null);
  return { holders, waiters };
}
