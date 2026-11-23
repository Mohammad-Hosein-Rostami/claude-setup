// Purpose: line 3 of the road gate (road-gate.mjs): `git-tidy check` reads one git line, except for the branches and worktrees of work
//   still in flight, which are INFO.
// Exports: gitLines(tidy, road, items, { otherRoads, held, live, branchAhead }) -> PASS, FAIL and INFO lines; openWriterFolders(env,
//   nowMs) -> held; liveSessions(env) -> live.
// In flight: a finding about one branch or worktree (`merged-branch`, `merged-worktree`, `superseded-copy`, `agent-leftover`; a fresh
//   branch at the base tip reads as merged while its lane is built) is INFO when it is about
//   - a lane in flight: its row (or close row) started, the lane not landed, of this road or of `otherRoads` (the road files beside
//     STATUS.md), matched by the branch the road file names; or
//   - a worktree an open writer holds: an open launch record (hooks/lib/open-writers.mjs, closed only at the writer's SubagentStop) whose
//     folder is that worktree, matched by real path, so a lane the lead built on a branch name other than the road file's still counts
//     (row r22.gate-open-lanes, 2026-11-23); the branch checked out there is held too, and so is `worktree-agent-<agent id>` of an open
//     launch (Claude Code's own isolation worktree). A record is only a claim (a crashed writer's stays open up to 7 days, and anyone can
//     write one under a made-up session id), so it holds only when all three hold: the STATUS row its brief named (the record's `row`) is
//     started and not done in this STATUS.md; its session is live by the session store's own rule (disk-free/lib/live-sessions.mjs: a
//     ~/.claude/sessions/<pid>.json Claude Code wrote naming that session id, its pid alive; a pid alone is no identity, P16); and
//     `branchAhead(branch)` (the caller asks git): the branch has commits not on the base, or none yet (its tip is the base tip).
//   Every other finding is a FAIL: a leftover branch or worktree of a landed lane (its branch an ancestor of the base, or its row done)
//   whose record is stale or planted included.
// Invariants: gitLines is pure (the caller runs git-tidy and git); openWriterFolders and liveSessions only read the stores under HOME; a
//   store folder that does not exist holds nothing, any other read error throws (the gate then fails: more FAIL, never less); nothing is
//   held without `live` and `branchAhead` (their defaults hold nothing).
import { readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isSessionId } from '../../../hooks/lib/session-store.mjs';
import { openWritersOf, writersDirOf } from '../../../hooks/lib/writer-agents.mjs';
import { liveSessionIds } from '../../disk-free/lib/live-sessions.mjs';
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
 * The open writer launches of every session, each with what it claims to hold (gitLines decides whether it holds it).
 * @param {Record<string, string | undefined>} env HOME / USERPROFILE (the launch stores' home)
 * @param {number} nowMs epoch ms (records older than the open-record age cap are dropped by the reader)
 * @returns {{ session: string, folder: string | null, agentBranch: string | null, row: string | null }[]} folder as folderKey gives it
 *   (null: none recorded or gone); agentBranch `worktree-agent-<id>` once the agent started; row the STATUS row its brief named
 * @throws when the store folder exists but cannot be listed, or a recorded folder cannot be resolved for another reason than absence
 */
export function openWriterFolders(env, nowMs) {
  let names;
  try {
    names = readdirSync(writersDirOf(env));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const sessions = names.map((name) => STORE_FILE.exec(name)?.[1]).filter(isSessionId);
  return sessions.flatMap((session) => openWritersOf(session, env, nowMs).map((entry) => ({
    session,
    folder: typeof entry.cwd === 'string' ? folderKey(entry.cwd) : null,
    agentBranch: typeof entry.agent === 'string' ? `${AGENT_BRANCH}${entry.agent}` : null,
    row: typeof entry.row === 'string' ? entry.row : null,
  })));
}

/**
 * The ids of the Claude Code sessions running now, by the session store's own rule (live-sessions.mjs liveSessionIds).
 * @param {Record<string, string | undefined>} env HOME / USERPROFILE, as for the launch stores
 * @returns {Promise<Set<string>>}
 */
export function liveSessions(env) {
  return liveSessionIds(join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'sessions'));
}

/** The branch a git-tidy finding is about, or null for a finding about no one branch (a merge commit, a dirty base folder, ...). */
function findingBranch(finding) {
  if (BRANCH_FINDINGS.has(finding.kind)) return String(finding.subject);
  if (finding.kind === MERGED_WORKTREE) return WORKTREE_BRANCH.exec(String(finding.detail))?.[1] ?? null;
  return null;
}

/** The launches whose claim can hold: their session live and the row their brief named started and not done in this STATUS.md. */
function holdingWriters(held, items, live) {
  const open = new Set(items.filter((item) => item.started != null && item.done == null).map((item) => String(item.id).toLowerCase()));
  return held.filter((writer) => live.has(writer.session) && writer.row !== null && open.has(writer.row.toLowerCase()));
}

/**
 * Branch -> why it is held: each branch checked out in a held worktree (by the merged-worktree findings) and each open agent branch of
 * a holding writer (holdingWriters), when `branchAhead` says the branch is no landed leftover.
 */
function heldBranches(findings, writers, branchAhead) {
  const folders = new Map(writers.filter((writer) => writer.folder !== null).map((writer) => [writer.folder, writer.row]));
  const branches = new Map(writers.filter((writer) => writer.agentBranch !== null).map((writer) => [writer.agentBranch, `an open writer of row ${writer.row}`]));
  for (const finding of findings) {
    const row = finding?.kind === MERGED_WORKTREE ? folders.get(folderKey(String(finding.subject))) : undefined;
    const branch = row === undefined ? null : findingBranch(finding);
    if (branch !== null) branches.set(branch, `an open writer of row ${row} in ${finding.subject}`);
  }
  return new Map([...branches].filter(([branch]) => branchAhead(branch)));
}

// Unreadable output is null: the caller's FAIL names the exit and the first line.
const findingsOf = (out) => { try { return JSON.parse(out)?.findings ?? null; } catch { return null; } };

/**
 * Line 3 from the result of `git-tidy check <repo> --base <base> --json`.
 * @param {{ exit: number, out: string }} tidy the git-tidy result
 * @param {object} road a checked road
 * @param {object[]} items parseWorkItems(...).items of the road's STATUS.md
 * @param {{ otherRoads?: object[], held?: ReturnType<typeof openWriterFolders>, live?: Set<string>,
 *   branchAhead?: (branch: string) => boolean }} [context] the other roads beside STATUS.md; the open writer launches
 *   (openWriterFolders), the live session ids (liveSessions) and whether a branch has commits not on the base or none yet (git, the
 *   caller's): a launch holds nothing without all three (header)
 * @returns {string[]} one PASS or FAIL line first when clean, then an INFO line per finding of work in flight; else the FAIL lines
 */
export function gitLines(tidy, road, items, { otherRoads = [], held = [], live = new Set(), branchAhead = () => false } = {}) {
  if (tidy.exit === 0) return [pass('3 one git line: git-tidy check clean')];
  const findings = tidy.exit === 1 ? findingsOf(tidy.out) : null;
  if (!Array.isArray(findings)) return [fail(`3 one git line: exit ${tidy.exit}: ${tidy.out.split('\n').find(Boolean) ?? ''}`.trim())];
  const flying = inFlightBranches([road, ...otherRoads], items);
  const holders = heldBranches(findings, holdingWriters(held, items, live), branchAhead);
  const lines = findings.map((finding) => {
    const text = `${finding?.kind} ${finding?.subject} ${finding?.detail}`;
    const branch = finding === null || typeof finding !== 'object' ? null : findingBranch(finding);
    if (branch !== null && flying.has(branch)) return `INFO 3 one git line: in flight (${flying.get(branch)} started): ${text}`;
    if (branch !== null && holders.has(branch)) return `INFO 3 one git line: in flight (held by ${holders.get(branch)}): ${text}`;
    return fail(`3 one git line: ${text}`);
  });
  return lines.some((line) => line.startsWith('FAIL')) ? lines : [pass('3 one git line: git-tidy check clean but for lanes in flight'), ...lines];
}
