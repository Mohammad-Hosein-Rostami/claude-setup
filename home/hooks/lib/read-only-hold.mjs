// The read-only hold of commit-gate.mjs (round 9, r9-writer-gate): agent-model-guard.mjs lets a writer whose brief has a line starting
// `read-only:` or `scratchpad-only:` launch beside a running writer, so the agent's stop holds it to that line. Exports:
// isHeldReadOnly(input, brief, env) -> boolean, changedOutsideScratch(recorded, env) -> string[], readOnlyReason(count, where) -> string.
// Which agent is held: a subagent whose brief (the first user message of its transcript) has such a line; when the brief cannot be read,
// one whose launch was recorded read-only (lib/writer-agents.mjs readOnlyLaunchOpen). The lead is never held.
// What counts as a change: every file the agent recorded (Edit, Write, MultiEdit, NotebookEdit; committed or not) whose real path is not
// under a temp or scratchpad root, plus its own Bash-made entries in its gated worktree (commit-gate adds those). Roots: the real path of
// os.tmpdir(), of TMPDIR, and Claude Code's per-user scratchpad root /private/tmp/claude-<uid>/ (its /tmp spelling too).
// Invariants: never throws; a root that cannot be resolved is left out (more files count, the hold only gets stricter).
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { isReadOnlyBrief, readOnlyLaunchOpen } from './writer-agents.mjs';

const SCRATCH_PARENTS = ['/private/tmp', '/tmp']; // Claude Code keeps each session's scratchpad under <parent>/claude-<uid>/

/** The real path of a folder, or null when it does not resolve. */
function realFolder(path) {
  try {
    return typeof path === 'string' && path !== '' ? realpathSync.native(path) : null;
  } catch {
    return null; // a missing root holds nothing
  }
}

/** The real temp and scratchpad roots, each without a trailing separator. */
function scratchRoots(env) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const scratch = uid === null ? [] : SCRATCH_PARENTS.map((parent) => join(parent, `claude-${uid}`));
  const roots = [tmpdir(), env.TMPDIR, ...scratch].map(realFolder).filter((root) => root !== null);
  return [...new Set(roots.map((root) => (root.endsWith(sep) && root.length > 1 ? root.slice(0, -1) : root)))];
}

const isUnder = (path, root) => path === root || path.startsWith(`${root}${sep}`);

/**
 * Whether this SubagentStop holds the agent to a read-only brief.
 * @param {{session_id?: string, agent_id?: string, agent_type?: string}} input the SubagentStop hook JSON
 * @param {string | null} brief the agent's brief, null when it cannot be read
 * @param {Record<string, string | undefined>} env HOME (the writer store)
 * @returns {boolean} false for the lead and for any failure
 */
export function isHeldReadOnly(input, brief, env) {
  try {
    if (typeof input?.agent_id !== 'string' || input.agent_id === '') return false;
    if (brief !== null) return isReadOnlyBrief(brief);
    return readOnlyLaunchOpen(input.session_id, input.agent_id, input.agent_type, env);
  } catch {
    return false; // no verdict: the normal gate rules apply
  }
}

/**
 * The recorded files of a held agent that lie outside every temp and scratchpad root.
 * @param {Set<string>} recorded the agent's recorded real paths (lib/own-edits.mjs recordedPaths)
 * @param {Record<string, string | undefined>} env TMPDIR
 * @returns {string[]} those paths, sorted
 */
export function changedOutsideScratch(recorded, env) {
  const roots = scratchRoots(env);
  return [...recorded].filter((path) => !roots.some((root) => isUnder(path, root))).sort();
}

/**
 * The block reason for a held agent; it replaces "commit them".
 * @param {number} count the changed files
 * @param {string | null} where the gated worktree, or null when the agent has none
 * @returns {string}
 */
export function readOnlyReason(count, where) {
  const place = where === null ? 'outside the temp and scratchpad folders' : `in ${where}`;
  return `This agent was launched as read-only but changed ${count} files ${place}: undo them, do not commit them, `
    + 'or tell the lead that the job needs a writer launch.';
}
