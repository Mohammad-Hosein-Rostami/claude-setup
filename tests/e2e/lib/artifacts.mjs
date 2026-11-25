// What a live run keeps after its root is removed: the scenario logs, the transcripts and the guard log, redacted, in the out
// folder, and one plain record per scenario for results.json. Exports: DROPPED_KEYS, plain(value), copyRedacted(from, to),
// keepTranscripts(projectsDir, root, to, realHomeMode), scenarioRecord(scenario, ctx, lines).
// Why: the run root (temp HOME, repos, transcripts) is removed at the end, but a FAIL must stay readable afterwards; and nothing
// kept may hold a token (owner rule), so every file is read as text and redacted before it is written (owner-only, 0600).
// Invariants: reads only from the run root and, in real-HOME mode, the project folders of folders inside it; writes only in `to`.
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './redact.mjs';
import { projectKey } from './transcripts.mjs';

/** Keys left out of results.json: whole event lists and loaded transcripts (they are in the kept files). */
export const DROPPED_KEYS = Object.freeze(['events', 'loaded', 'lines', 'agents']);
const BINARY = /\.(?:png|jpe?g|gif|pdf|zip|gz)$/i;

/** @returns {unknown} the value as plain JSON data: Sets as arrays, the DROPPED_KEYS left out, functions dropped */
export function plain(value) {
  return JSON.parse(JSON.stringify(value ?? null, (key, inner) => {
    if (DROPPED_KEYS.includes(key)) return undefined;
    if (inner instanceof Set) return [...inner];
    if (typeof inner === 'function') return undefined;
    return inner;
  }));
}

/**
 * Copies a folder tree, each text file redacted; links are not followed (a link is skipped).
 * @returns {number} the files copied
 */
export function copyRedacted(from, to) {
  let entries = [];
  try { entries = readdirSync(from, { withFileTypes: true }); } catch { return 0; }
  mkdirSync(to, { recursive: true, mode: 0o700 });
  let copied = 0;
  for (const entry of entries) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) copied += copyRedacted(source, target);
    else if (entry.isFile() && !lstatSync(source).isSymbolicLink()) {
      if (BINARY.test(entry.name)) copyFileSync(source, target);
      else writeFileSync(target, redact(readFileSync(source, 'utf8')), { mode: 0o600 });
      copied += 1;
    }
  }
  return copied;
}

/**
 * The transcripts of the run: every project folder in the temp HOME, or in real-HOME mode only those of folders inside the root.
 * @returns {number} the files copied
 */
export function keepTranscripts(projectsDir, root, to, realHomeMode) {
  const rootKey = projectKey(root);
  let names = [];
  try { names = readdirSync(projectsDir); } catch { return 0; }
  const ours = realHomeMode ? names.filter((name) => name === rootKey || name.startsWith(`${rootKey}-`)) : names;
  return ours.reduce((sum, name) => sum + copyRedacted(join(projectsDir, name), join(to, name)), 0);
}

/** @returns {object} one scenario's entry of results.json */
export function scenarioRecord(scenario, ctx, lines) {
  const record = plain({
    id: scenario.id, title: scenario.title, model: scenario.model, notRun: ctx?.notRun ?? null, timedOut: ctx?.timedOut ?? false,
    sessions: (ctx?.sessions ?? []).map(({ name, model, sessionId, exit, limit, args }) => ({ name, model, sessionId, exit, limit, args })),
    notes: ctx?.notes ?? {}, steps: ctx?.steps ?? [],
  });
  return { ...record, lines: plain(lines) }; // `lines` is a DROPPED_KEYS name inside notes, not here
}
