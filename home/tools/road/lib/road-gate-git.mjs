// Purpose: line 3 of the road gate (road-gate.mjs): `git-tidy check` reads one git line, except for the branches and worktrees of work
//   still in flight, which are INFO.
// Exports: gitLines(tidy, road, items, { otherRoads, held }) -> PASS, FAIL and INFO lines; openWriterFolders(env, nowMs) -> held.
// In flight: a finding about one branch or worktree (`merged-branch`, `merged-worktree`, `superseded-copy`, `agent-leftover`; a fresh
//   branch at the base tip reads as merged while its lane is built) is INFO when it is about
//   - a lane in flight: its row (or close row) started, the lane not landed, of this road or of `otherRoads` (the road files beside
//     STATUS.md), matched by the branch the road file names; or
//   - a worktree an open writer holds: an open launch record (hooks/lib/open-writers.mjs, closed only at the writer's SubagentStop) whose
//     folder is that worktree, matched by real path, so a lane the lead built on a branch name other than the road file's still counts
//     (row r22.gate-open-lanes, 2026-11-23); the branch checked out there is held too, and so is `worktree-agent-<agent id>` of an open
//     launch (Claude Code's own isolation worktree).
//   Every other finding is a FAIL: a leftover branch or worktree of a landed lane whose writer stopped included.
// Invariants: gitLines is pure (the caller runs git-tidy); openWriterFolders only reads the launch stores under HOME; a store folder that
//   does not exist holds nothing, any other read error throws (the gate then fails: more FAIL, never less).
import { readdirSync, realpathSync } from 'node:fs';
import { isSessionId } from '../../../hooks/lib/session-store.mjs';
import { openWritersOf, writersDirOf } from '../../../hooks/lib/writer-agents.mjs';
import { inFlightBranches } from './road-state.mjs';

// Findings about one branch: a lane in flight has them while it is built (a fresh branch at the base tip reads as merged).
const BRANCH_FINDINGS = new Set(['merged-branch', 'superseded-copy', 'agent-leftover']);
const MERGED_WORKTREE = 'merged-worktree';
const WORKTREE_BRANCH = /^branch (.+)$/;
const STORE_FILE = /^(.+)\.json$/; // one `<session id>.json` per session (hooks/lib/agent-launches.mjs)
const AGENT_BRANCH = 'worktree-agent-'; // the branch of a Claude Code isolation worktree, named for its agent id
const CASE_INSENSITIVE = process.platform === 'win32'; // drive paths: `C:\x` and `c:/x` are one folder

const pass = (text) => `PASS ${text}`;
const fail = (text) => `FAIL ${text}`;

/** A folder as compared: its real path with `/` separators (lower-case on Windows), or null when it does not exist. */
function folderKey(path) {
  let real;
  try {
    real = realpathSync(path);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
  const slashed = real.replace(/\\/g, '/');
  return CASE_INSENSITIVE ? slashed.toLowerCase() : slashed;
}

/**
 * The folders and agent branches the open writer launches of every session hold.
 * @param {Record<string, string | undefined>} env HOME / USERPROFILE (the launch stores' home)
 * @param {number} nowMs epoch ms (records older than the open-record age cap are dropped by the reader)
 * @returns {{ folders: string[], branches: string[] }} folders as folderKey gives them; `worktree-agent-<id>` branch names
 * @throws when the store folder exists but cannot be listed, or a recorded folder cannot be resolved for another reason than absence
 */
export function openWriterFolders(env, nowMs) {
  let names;
  try {
    names = readdirSync(writersDirOf(env));
  } catch (error) {
    if (error.code === 'ENOENT') return { folders: [], branches: [] };
    throw error;
  }
  const sessions = names.map((name) => STORE_FILE.exec(name)?.[1]).filter(isSessionId);
  const entries = sessions.flatMap((session) => openWritersOf(session, env, nowMs));
  const folders = entries.map((entry) => (typeof entry.cwd === 'string' ? folderKey(entry.cwd) : null)).filter((key) => key !== null);
  const branches = entries.filter((entry) => typeof entry.agent === 'string').map((entry) => `${AGENT_BRANCH}${entry.agent}`);
  return { folders: [...new Set(folders)], branches: [...new Set(branches)] };
}

/** The branch a git-tidy finding is about, or null for a finding about no one branch (a merge commit, a dirty base folder, ...). */
function findingBranch(finding) {
  if (BRANCH_FINDINGS.has(finding.kind)) return String(finding.subject);
  if (finding.kind === MERGED_WORKTREE) return WORKTREE_BRANCH.exec(String(finding.detail))?.[1] ?? null;
  return null;
}

/** Branch -> why it is held: each branch checked out in a held worktree (by the merged-worktree findings) and each open agent branch. */
function heldBranches(findings, held) {
  const folders = new Set(held.folders);
  const branches = new Map(held.branches.map((branch) => [branch, 'an open writer']));
  for (const finding of findings) {
    if (finding?.kind !== MERGED_WORKTREE || !folders.has(folderKey(String(finding.subject)))) continue;
    const branch = findingBranch(finding);
    if (branch !== null) branches.set(branch, `an open writer in ${finding.subject}`);
  }
  return branches;
}

// Unreadable output is null: the caller's FAIL names the exit and the first line.
const findingsOf = (out) => { try { return JSON.parse(out)?.findings ?? null; } catch { return null; } };

/**
 * Line 3 from the result of `git-tidy check <repo> --base <base> --json`.
 * @param {{ exit: number, out: string }} tidy the git-tidy result
 * @param {object} road a checked road
 * @param {object[]} items parseWorkItems(...).items of the road's STATUS.md
 * @param {{ otherRoads?: object[], held?: { folders: string[], branches: string[] } }} [context] the other roads beside STATUS.md, and
 *   what open writers hold (openWriterFolders; none when not given)
 * @returns {string[]} one PASS or FAIL line first when clean, then an INFO line per finding of work in flight; else the FAIL lines
 */
export function gitLines(tidy, road, items, { otherRoads = [], held = { folders: [], branches: [] } } = {}) {
  if (tidy.exit === 0) return [pass('3 one git line: git-tidy check clean')];
  const findings = tidy.exit === 1 ? findingsOf(tidy.out) : null;
  if (!Array.isArray(findings)) return [fail(`3 one git line: exit ${tidy.exit}: ${tidy.out.split('\n').find(Boolean) ?? ''}`.trim())];
  const flying = inFlightBranches([road, ...otherRoads], items);
  const holders = heldBranches(findings, held);
  const lines = findings.map((finding) => {
    const text = `${finding?.kind} ${finding?.subject} ${finding?.detail}`;
    const branch = finding === null || typeof finding !== 'object' ? null : findingBranch(finding);
    if (branch !== null && flying.has(branch)) return `INFO 3 one git line: in flight (${flying.get(branch)} started): ${text}`;
    if (branch !== null && holders.has(branch)) return `INFO 3 one git line: in flight (held by ${holders.get(branch)}): ${text}`;
    return fail(`3 one git line: ${text}`);
  });
  return lines.some((line) => line.startsWith('FAIL')) ? lines : [pass('3 one git line: git-tidy check clean but for lanes in flight'), ...lines];
}
