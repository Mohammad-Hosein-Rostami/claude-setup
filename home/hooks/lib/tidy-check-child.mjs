// The `git-tidy check` child of git-tidy-gate.mjs and the slim verdict the gate keeps of its report. Moved unchanged from
// git-tidy-gate.mjs (round 9, r9-gates-fix) so the gate file stays under 300 lines (C4).
// Exports: runTidyChild(args, timeoutMs, env, okStatuses), runCheckChild(top, timeoutMs, env), slimVerdict(report, removable),
//   listOf(items, kinds), plainText(text), plainItem(item), MERGE_COMMIT, PRUNE_KINDS, COPY_KINDS, UNLANDED, OPEN_LANE, CHILD_GIT_CONFIG.
// Invariants: the child's git never starts a program the repository names (CHILD_GIT_CONFIG); names and subjects are capped data.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAgentBranch } from '../../tools/git-tidy/lib/copies.mjs';

const GIT_TIDY = fileURLToPath(new URL('../../tools/git-tidy/git-tidy.mjs', import.meta.url));
const MAX_TEXT_CHARS = 200; // of one name, path or commit subject kept from a check, so one odd value cannot flood a reason or the store
const MAX_LISTED = 20; // entries of one kind kept in a verdict and shown in a reason
// findings the gate blocks on; all but merge-commit are removed by `git-tidy prune`
export const MERGE_COMMIT = 'merge-commit';
export const PRUNE_KINDS = new Set(['superseded-copy', 'agent-leftover', 'merged-branch', 'merged-worktree', 'stale-worktree']);
export const COPY_KINDS = new Set(['superseded-copy', 'agent-leftover']);
export const UNLANDED = 'unlanded-lane?';
export const OPEN_LANE = 'unmerged-branch?';
// command-scope config beats the repository's own: the child's git never starts a program the repository names. Appended to
// GIT_CONFIG_PARAMETERS after the caller's own: git reads it after GIT_CONFIG_COUNT and the last value wins, so no caller
// setting switches these back on (as FORCED_CONFIG in tools/git-tidy/lib/git.mjs).
export const CHILD_GIT_CONFIG = "'core.fsmonitor'='false' 'safe.bareRepository'='explicit' 'log.showSignature'='false'";
const childEnv = (env) => ({
  ...env, GIT_CONFIG_PARAMETERS: env.GIT_CONFIG_PARAMETERS ? `${env.GIT_CONFIG_PARAMETERS} ${CHILD_GIT_CONFIG}` : CHILD_GIT_CONFIG,
});

export const listOf = (items, kinds) => items.filter(({ kind }) => kinds.has(kind)).slice(0, MAX_LISTED);
export const plainText = (text) => String(text).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_TEXT_CHARS);
export const plainItem = ({ kind, subject, detail }) => ({ kind, subject: plainText(subject), detail: plainText(detail) });

/**
 * Only what the gate reads of a `check --json` report, so a repo with hundreds of branches stays small in the store. `removable` holds the
 * names and paths the prune dry run would remove: of the findings that prune fixes, only those block (prune keeps a fresh worktree).
 * Copies and agent branches are not lanes, so they are left out of the lane hints.
 */
export function slimVerdict({ base, findings, hints }, removable) {
  const blocking = findings.filter(({ kind, subject }) => kind === MERGE_COMMIT || (PRUNE_KINDS.has(kind) && removable.has(subject)));
  const notLanes = new Set(findings.filter(({ kind }) => COPY_KINDS.has(kind)).map(({ subject }) => subject));
  const isLane = ({ subject }) => !notLanes.has(subject) && !isAgentBranch(subject);
  return {
    base,
    findings: blocking.slice(0, MAX_LISTED).map(plainItem),
    hints: [...listOf(hints, new Set([UNLANDED])).filter(isLane), ...listOf(hints, new Set([OPEN_LANE])).filter(isLane)].map(plainItem),
  };
}

/** `git-tidy <args> --json` as a child: its parsed report, 'timeout', or undefined (one stderr line) when it cannot be read. */
export function runTidyChild(args, timeoutMs, env, okStatuses) {
  const result = spawnSync(process.execPath, [GIT_TIDY, ...args], {
    encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', env: childEnv(env), maxBuffer: 64 << 20,
  });
  if (result.error?.code === 'ETIMEDOUT') return 'timeout';
  if (result.error || !okStatuses.includes(result.status)) {
    process.stderr.write(`git-tidy-gate: git-tidy ${args[0]} failed: ${result.error?.message ?? result.stderr.split('\n')[0]}\n`);
    return undefined;
  }
  return JSON.parse(result.stdout);
}

/** The slim verdict of `top` from `git-tidy check` and, when something is prunable, a prune dry run; 'timeout' or undefined as runTidyChild. */
export function runCheckChild(top, timeoutMs, env) {
  const startedMs = Date.now();
  const report = runTidyChild(['check', top, '--json'], timeoutMs, env, [0, 1]);
  if (report === 'timeout' || report === undefined) return report;
  if (!report.findings.some(({ kind }) => PRUNE_KINDS.has(kind))) return slimVerdict(report, new Set());
  const plan = runTidyChild(['prune', top, '--include-recent', '--json'], Math.max(timeoutMs - (Date.now() - startedMs), 1), env, [0]);
  if (plan === 'timeout' || plan === undefined) return plan;
  return slimVerdict(report, new Set(plan.items.filter(({ action }) => action === 'remove').map(({ subject }) => subject)));
}
