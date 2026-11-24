// The open launch records of plain writer agents (spec-p3 `r9-resume`, H1/H2): written before the agent starts (intent), closed only at its
// SubagentStop (outcome), so a writer whose process ended with the session (an exit, a usage-limit stop, a kill) stays listed for the
// next session's notice. Pure functions over the `open` list of lib/writer-agents.mjs's store; writer-agents.mjs does the locked I/O.
// Exports: OPEN_MAX_AGE_MS, parseOpen(list, now), addOpen(list, entry, now), startOpen(list, agentId, type), stopOpen(list, agentId, type),
//   launchAbout(about).
// Entry: { type, at, agent?, cwd?, description?, row?, isolated? }. A PostToolUse(Agent) with `async_launched` (a background agent's launch
//   result) never closes one: nothing here is called for it.
// Invariants: never throws; text fields are cut and lose control characters on the way in (they are shown to the lead as data); at most
//   OPEN_KEPT entries, none older than OPEN_MAX_AGE_MS.

export const OPEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const OPEN_KEPT = 50;
const MAX_TEXT_CHARS = 200;
const MAX_PATH_CHARS = 1000;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029<>]/g;
// A work item the brief names: `row <id>` or `row: <id>` (the board shows it; the field keeps its old name `row`).
const ROW_IN_BRIEF = /\brow:?\s+`?([A-Za-z0-9][\w.:-]{0,39})`?/i;

const cleanText = (value, max) => (typeof value === 'string' && value !== '' ? value.replace(CONTROL, ' ').slice(0, max) : undefined);

/**
 * The fields of a launch worth keeping for the notice: the lead's folder, the call's description and the work item its brief names.
 * @param {{ cwd?: unknown, description?: unknown, prompt?: unknown } | undefined} about
 * @returns {{ cwd?: string, description?: string, row?: string }}
 */
export function launchAbout(about) {
  const row = typeof about?.prompt === 'string' ? ROW_IN_BRIEF.exec(about.prompt)?.[1] : undefined;
  const fields = { cwd: cleanText(about?.cwd, MAX_PATH_CHARS), description: cleanText(about?.description, MAX_TEXT_CHARS), row };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

/** The usable entries of a stored list, newest last, within the age and count caps. */
export function parseOpen(list, now) {
  return (Array.isArray(list) ? list : [])
    .filter((entry) => typeof entry?.type === 'string' && Number.isFinite(entry.at) && now - entry.at < OPEN_MAX_AGE_MS)
    .slice(-OPEN_KEPT);
}

/** The list with one more entry. */
export const addOpen = (list, entry, now) => [...parseOpen(list, now), entry].slice(-OPEN_KEPT);

/** The list with the oldest unstarted entry of `type` given the agent id (SubagentStart). */
export function startOpen(list, agentId, type) {
  const index = list.findIndex((entry) => entry.type === type && typeof entry.agent !== 'string');
  return index === -1 ? list : list.map((entry, at) => (at === index ? { ...entry, agent: agentId } : entry));
}

/** The list without the entry of `agentId`, else without the oldest entry of `type` (SubagentStop). */
export function stopOpen(list, agentId, type) {
  const own = list.findIndex((entry) => entry.agent === agentId);
  const index = own !== -1 ? own : list.findIndex((entry) => entry.type === type && typeof entry.agent !== 'string');
  return index === -1 ? list : list.filter((_, at) => at !== index);
}
