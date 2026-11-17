// Stop, SubagentStop and PreCompact: keeps git on one line (C37). A lead's Stop is blocked once per repository state while the repo holds
// leftovers `git-tidy check` finds (an unpublished merge commit, an older copy of a re-done lane, a workflow agent's leftover branch, a
// merged branch or worktree), while a base branch moved during this session has no full-suite PASS, or while an old unmerged lane is named
// by no open row of the session's STATUS.md. A SubagentStop is blocked once when the agent left its own empty `worktree-agent-<id>` branch.
// PreCompact prints one line per open lane so the summary keeps them.
// Exports: decide(input, env, deps) -> Promise<{block: false} | {block: true, reason}>, openLanes(input, env, deps) -> Promise<string[]>.
//   deps (tests): runCheck(top, timeoutMs, env), checkTimeoutMs, hasPass (null: no test-pass tool), now (ms, for the cache age).
//   Env: GIT_TIDY_GATE_CHECK_TIMEOUT_MS overrides CHECK_TIMEOUT_MS (a loaded machine, the test suite).
// Invariants:
// - The gated folder is the session's own worktree (lib/gated-folder.mjs). A lead also gates the worktrees of files the session itself
//   edited (one per repository, up to 5, newest first; one stop spends at most one check budget in all, finding them included, and each
//   check gets only the time left; PreCompact keeps to the same budget), so a session started in a folder that is no repo (~) is still
//   checked; a repo the session did not edit in is never touched. A subagent gates its start folder only. The check runs as a child of
//   `git-tidy.mjs check --json` with
//   core.fsmonitor and log.showSignature off and bare repositories off, and never in a repo where any worktree's own config view names a
//   filter (`git status` there would run it): there only a cached verdict is read, so such a repo is never judged.
// - A finding blocks only when the advised `prune` would act on it (a dry run in the same child, so a fresh worktree at the base, which
//   prune protects, never blocks), or is a merge commit; names and subjects reach the reason quoted and capped (they are data).
// - State: ~/.claude/state/git-tidy-gate/<session>.json holds the check verdict per (repo, fingerprint) and the states already blocked. The
//   fingerprint is a hash of all refs and the worktree list, so a repo unchanged for under 10 minutes is a cache hit: two git calls and no
//   child (the age bound is because findings such as "unlanded for 2 h" change with time alone).
//   A miss runs the child with a CHECK_TIMEOUT_MS bound; on a timeout the stop passes and one detached refresh fills the cache.
// - Blocks at most once per state (agent + repo + the problems found); a continued stop (stop_hook_active) gets at most
//   MAX_CHAINED_BLOCKS blocks in a row (lib/tidy-gate-store.mjs), so the gate can never loop. A state that cannot be stored is not blocked.
// - Without a transcript timestamp or the test-pass tool the base tip is not judged; without a linked STATUS.md no lane is called unnamed.
// - Any internal error is one stderr line and exit 0: a session is never trapped.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { editedWorktrees, gatedFolder, gitOut, gitText, namesFilterProgram, readHead, worktreeOf } from './lib/gated-folder.mjs';
import { isSessionId } from './lib/session-store.mjs';
import { statusFileOf } from './lib/status-file-of.mjs';
import { cachedVerdict, recordOnce, storeVerdict } from './lib/tidy-gate-store.mjs';
import { parseWorkItems } from '../tools/estimate/lib/items.mjs';
import { isAgentBranch } from '../tools/git-tidy/lib/copies.mjs';
import { readStatusFile } from '../tools/status/status-file.mjs';

const GIT_TIDY = fileURLToPath(new URL('../tools/git-tidy/git-tidy.mjs', import.meta.url));
const TEST_PASS = '../tools/test-pass/test-pass.mjs';
const PASS = Object.freeze({ block: false });
const CHECK_TIMEOUT_MS = 4000; // a Stop hook must answer fast; a slower check is finished by the detached refresh
const MAX_TEXT_CHARS = 200; // of one name, path or commit subject kept from a check, so one odd value cannot flood a reason or the store
const REFRESH_TIMEOUT_MS = 60_000;
const MAX_LISTED = 20; // entries of one kind kept in a verdict and shown in a reason
const TRANSCRIPT_HEAD_BYTES = 4 * 1024 * 1024;
const AGENT_BRANCH_PREFIX = 'worktree-agent-';
// findings the gate blocks on; all but merge-commit are removed by `git-tidy prune`
const MERGE_COMMIT = 'merge-commit';
const PRUNE_KINDS = new Set(['superseded-copy', 'agent-leftover', 'merged-branch', 'merged-worktree', 'stale-worktree']);
const COPY_KINDS = new Set(['superseded-copy', 'agent-leftover']);
const UNLANDED = 'unlanded-lane?';
const OPEN_LANE = 'unmerged-branch?';
// command-scope config beats the repository's own: the child's git never starts a program the repository names
const CHILD_GIT_CONFIG = {
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'safe.bareRepository', GIT_CONFIG_VALUE_1: 'explicit',
  GIT_CONFIG_KEY_2: 'log.showSignature', GIT_CONFIG_VALUE_2: 'false',
};

const homeOf = (env) => env.HOME || env.USERPROFILE || homedir();
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const short = (hash) => hash.slice(0, 8);

/** A hash of every ref and the worktree list: equal while nothing a check looks at changed; null when git cannot be read. */
function fingerprintOf(top) {
  const refs = gitOut(top, ['for-each-ref', '--format=%(objectname) %(refname)']);
  const trees = gitOut(top, ['worktree', 'list', '--porcelain']);
  return refs === null || trees === null ? null : sha256(`${refs}\0${trees}`);
}

const listOf = (items, kinds) => items.filter(({ kind }) => kinds.has(kind)).slice(0, MAX_LISTED);
const plainText = (text) => String(text).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_TEXT_CHARS);
const plainItem = ({ kind, subject, detail }) => ({ kind, subject: plainText(subject), detail: plainText(detail) });

/**
 * Only what the gate reads of a `check --json` report, so a repo with hundreds of branches stays small in the store. `removable` holds the
 * names and paths the prune dry run would remove: of the findings that prune fixes, only those block (prune keeps a fresh worktree).
 * Copies and agent branches are not lanes, so they are left out of the lane hints.
 */
function slimVerdict({ base, findings, hints }, removable) {
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
function runTidyChild(args, timeoutMs, env, okStatuses) {
  const result = spawnSync(process.execPath, [GIT_TIDY, ...args], {
    encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', env: { ...env, ...CHILD_GIT_CONFIG }, maxBuffer: 64 << 20,
  });
  if (result.error?.code === 'ETIMEDOUT') return 'timeout';
  if (result.error || !okStatuses.includes(result.status)) {
    process.stderr.write(`git-tidy-gate: git-tidy ${args[0]} failed: ${result.error?.message ?? result.stderr.split('\n')[0]}\n`);
    return undefined;
  }
  return JSON.parse(result.stdout);
}

/** The slim verdict of `top` from `git-tidy check` and, when something is prunable, a prune dry run; 'timeout' or undefined as runTidyChild. */
function runCheckChild(top, timeoutMs, env) {
  const startedMs = Date.now();
  const report = runTidyChild(['check', top, '--json'], timeoutMs, env, [0, 1]);
  if (report === 'timeout' || report === undefined) return report;
  if (!report.findings.some(({ kind }) => PRUNE_KINDS.has(kind))) return slimVerdict(report, new Set());
  const plan = runTidyChild(['prune', top, '--include-recent', '--json'], Math.max(timeoutMs - (Date.now() - startedMs), 1), env, [0]);
  if (plan === 'timeout' || plan === undefined) return plan;
  return slimVerdict(report, new Set(plan.items.filter(({ action }) => action === 'remove').map(({ subject }) => subject)));
}

/** One detached run of this file that checks `top` without a time bound worth waiting for and stores the verdict. */
function startRefresh(top, session, env) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--refresh', top, session], { detached: true, stdio: 'ignore', env, windowsHide: true });
  child.on('error', (error) => process.stderr.write(`git-tidy-gate: cannot start the refresh: ${error.message}\n`));
  child.unref();
}

/** True when the config view of the worktree `top`, or of any worktree of its repository, defines a filter (each worktree has its own view). */
function anyWorktreeNamesFilter(top) {
  const listed = gitOut(top, ['worktree', 'list', '--porcelain']);
  if (listed === null) return true;
  const folders = listed.split('\n\n').filter((block) => !block.split('\n').includes('bare'))
    .map((block) => block.split('\n')[0].replace(/^worktree /, '')).filter((folder) => existsSync(folder));
  return [top, ...folders].some(namesFilterProgram);
}

const checkBudgetMs = (env, deps) => deps.checkTimeoutMs ?? (Number(env.GIT_TIDY_GATE_CHECK_TIMEOUT_MS) || CHECK_TIMEOUT_MS);

/** The check verdict of `top` for this repo state: from the cache, else from a child run bound by `timeoutMs`; null when there is none (error, timeout). */
function verdictFor(env, session, top, deps, timeoutMs) {
  const fingerprint = fingerprintOf(top);
  if (fingerprint === null) return null;
  const repoState = { top, fingerprint };
  const cached = cachedVerdict(env, session, repoState, deps.now ?? Date.now());
  if (cached !== undefined) return cached;
  if (anyWorktreeNamesFilter(top)) return null; // only the child's `git status` could run a filter, so a cache hit never needs this call
  const run = deps.runCheck ?? runCheckChild;
  const fresh = run(top, timeoutMs, env);
  if (fresh === 'timeout') {
    startRefresh(top, session, env);
    return null;
  }
  if (fresh === undefined) return null;
  storeVerdict(env, session, repoState, fresh);
  return fresh;
}

/** Epoch ms of the first transcript line that has a timestamp (the session's start); null when there is none. */
function sessionStartMs(transcriptPath) {
  if (typeof transcriptPath !== 'string') return null;
  for (const line of (readHead(transcriptPath, TRANSCRIPT_HEAD_BYTES) ?? '').split('\n')) {
    try {
      const at = Date.parse(JSON.parse(line).timestamp);
      if (Number.isFinite(at)) return at;
    } catch {
      // a line cut at the read cap, or not JSON: look at the next one
    }
  }
  return null;
}

async function loadHasPass() {
  try {
    return (await import(TEST_PASS)).hasPass;
  } catch {
    return null; // no test-pass tool here: the base tip cannot be judged
  }
}

/** The base branch's tip as {sha, movedMs} from its reflog (when it last moved), or null. */
function baseTip(top, base) {
  const entry = gitText(top, ['reflog', 'show', '--date=unix', '--format=%gd %H', '-n', '1', `refs/heads/${base}`]);
  const found = /@\{(\d+)\} ([0-9a-f]{40,64})$/.exec(entry);
  return found === null ? null : { sha: found[2], movedMs: Number(found[1]) * 1000 };
}

/** A problem when the base moved during this session and its tip has no full-suite PASS; null otherwise. */
async function baseTipProblem(top, base, transcriptPath, deps) {
  const hasPass = deps.hasPass === undefined ? await loadHasPass() : deps.hasPass;
  const startedMs = sessionStartMs(transcriptPath);
  if (hasPass === null || startedMs === null || typeof base !== 'string') return null;
  const tip = baseTip(top, base);
  if (tip === null || tip.movedMs <= startedMs || hasPass(top, tip.sha, { suite: true })) return null;
  return { key: `base-tip:${tip.sha}`, text: `${base} moved to ${short(tip.sha)} during this session and has no full-suite PASS: run \`test-pass run --suite\` at ${short(tip.sha)}` };
}

/** Open rows of the session's STATUS.md as lower-case text, or null when no STATUS.md is linked. */
function openRowTexts(input, env) {
  const found = statusFileOf(input, { stateDir: join(homeOf(env), '.claude', 'state', 'estimate'), projectDir: env.CLAUDE_PROJECT_DIR });
  if (found?.path === undefined) return null;
  const read = readStatusFile(found.path);
  if (read.text === undefined) return null;
  return parseWorkItems(read.text).items.filter((row) => row.kind !== 'deliver' && row.done === null).map((row) => `${row.id} ${row.item}`.toLowerCase());
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// the whole word: `ui` is not named by "build the docs", while `r4-x` is named by "lane r4-x: implement it"
const namesWord = (row, word) => new RegExp(`(?<![a-z0-9_-])${escapeRegExp(word.toLowerCase())}(?![a-z0-9_-])`).test(row);

// words that a shell reads as one argument stay as they are; any other value is single-quoted
const shellWord = (value) => (/^[A-Za-z0-9._/@%+=:,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`);

/** The unlanded-lane hints that no open row names by the branch or its last path segment. */
function unnamedLanes(hints, input, env) {
  const unlanded = hints.filter(({ kind }) => kind === UNLANDED);
  const rows = unlanded.length === 0 ? null : openRowTexts(input, env);
  if (rows === null) return [];
  return unlanded.filter(({ subject }) => !rows.some((row) => namesWord(row, subject) || namesWord(row, subject.split('/').at(-1))));
}

function verdictProblems(verdict, input, env, top) {
  const problems = verdict.findings.map(({ kind, subject, detail }) => ({
    key: `${kind}:${subject}`,
    text: kind === MERGE_COMMIT ? `${kind} ${subject} ${JSON.stringify(detail)}: rebase it away (git-linear-history skill), never merge` : `${kind} ${subject}: ${detail}`,
  }));
  for (const { subject } of unnamedLanes(verdict.hints, input, env)) {
    problems.push({ key: `${UNLANDED}:${subject}`, text: `${UNLANDED} ${subject} is named by no open row of STATUS.md: land it (\`node ~/.claude/tools/git-tidy/git-tidy.mjs land ${shellWord(subject)}\`) or start its row` });
  }
  const prune = verdict.findings.some(({ kind }) => PRUNE_KINDS.has(kind));
  return { problems, pruneLine: prune ? `node ~/.claude/tools/git-tidy/git-tidy.mjs prune ${shellWord(top)} --apply --include-recent` : null };
}

async function leadReason(input, env, deps, { top, timeoutMs }) {
  const verdict = verdictFor(env, input.session_id, top, deps, timeoutMs);
  if (verdict === null) return null;
  const { problems, pruneLine } = verdictProblems(verdict, input, env, top);
  const baseProblem = await baseTipProblem(top, verdict.base, input.transcript_path, deps);
  if (baseProblem !== null) problems.push(baseProblem);
  if (problems.length === 0) return null;
  const lines = problems.map(({ text }) => `- ${text}`);
  const fix = pruneLine === null ? '' : `\nClean up what prune can remove (only proven patch-equal or merged work): ${pruneLine}`;
  return { state: problems.map(({ key }) => key).join('\0'), reason: `Git hygiene in ${top}:\n${lines.join('\n')}${fix}` };
}

/** The agent's own empty `worktree-agent-<id>` branch that nothing uses any more, as a reason; null when there is none. */
function agentReason(input, top) {
  if (!isSessionId(input.agent_id)) return null;
  const name = `${AGENT_BRANCH_PREFIX}${input.agent_id}`;
  const tip = gitText(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
  if (tip === '' || (gitOut(top, ['worktree', 'list', '--porcelain']) ?? '').includes(`branch refs/heads/${name}`)) return null;
  const holders = gitText(top, ['for-each-ref', '--contains', tip, '--format=%(refname:short)', 'refs/heads']).split('\n');
  if (holders.every((holder) => holder === name || isAgentBranch(holder))) return null; // it holds a commit of its own
  return { state: name, reason: `Your leftover branch ${name} holds no work of its own and no worktree uses it: delete it: \`git branch -d ${name}\`` };
}

/** The tree of this event's gated folder, or null when the gate does not apply (not a git worktree, an unusable session). */
function gatedTree(input, env) {
  if (input === null || typeof input !== 'object' || !isSessionId(input.session_id)) return null;
  const folder = gatedFolder(input, env);
  return folder === null ? null : worktreeOf(folder);
}

/**
 * The trees a lead's stop looks at: its project folder's worktree, then one worktree of each other repository the session edited a file
 * in (a session started in ~ has no project repo of its own). Empty for an unusable session. Finding them stops at `deadlineMs`.
 */
function leadTrees(input, env, deadlineMs) {
  if (input === null || typeof input !== 'object' || !isSessionId(input.session_id)) return [];
  const project = gatedTree(input, env);
  const edited = editedWorktrees(input.session_id, env, { deadlineMs, except: project });
  return project === null ? edited : [project, ...edited];
}

/**
 * Runs `inspect(tree, timeoutMs)` on each of a lead's trees until the one check budget is spent: each call gets only the time left, and
 * no tree after the first is started once none is left. `inspect` returns a stop value to end the loop with, else undefined.
 */
async function inspectWithinBudget(input, env, deps, inspect) {
  const deadlineMs = Date.now() + checkBudgetMs(env, deps);
  for (const [index, tree] of leadTrees(input, env, deadlineMs).entries()) {
    const timeLeftMs = deadlineMs - Date.now();
    if (index > 0 && timeLeftMs <= 0) break; // one stop never waits for several slow repos
    const done = await inspect(tree, Math.max(timeLeftMs, 1));
    if (done !== undefined) return done;
  }
  return undefined;
}

/**
 * The gate decision for one Stop or SubagentStop event.
 * @param {object} input the hook JSON (session_id, agent_id?, agent_type?, agent_transcript_path?, transcript_path?, stop_hook_active?)
 * @param {Record<string, string | undefined>} [env] HOME (the state folder), CLAUDE_PROJECT_DIR and the environment the check child gets
 * @param {object} [deps] see the header
 * @returns {Promise<{block: false} | {block: true, reason: string}>}
 */
export async function decide(input, env = process.env, deps = {}) {
  const agent = typeof input?.agent_id === 'string' && input.agent_id !== '' ? input.agent_id : null;
  if (agent !== null) {
    const tree = gatedTree(input, env);
    return tree === null ? PASS : blockOnce(input, env, agent, tree, agentReason(input, tree.top));
  }
  const blocked = await inspectWithinBudget(input, env, deps, async (tree, timeoutMs) => {
    const result = blockOnce(input, env, agent, tree, await leadReason(input, env, deps, { top: tree.top, timeoutMs }));
    return result.block ? result : undefined;
  });
  return blocked ?? PASS;
}

/** The block for `found` (a reason or null) the first time its state is seen in this session, else PASS. */
function blockOnce(input, env, agent, tree, found) {
  if (found === null) return PASS;
  const state = sha256(`${agent ?? ''}\0${tree.top}\0${found.state}`);
  const allowed = recordOnce(env, input.session_id, { agent: agent ?? '', state, continued: input.stop_hook_active === true });
  return allowed ? { block: true, reason: found.reason } : PASS;
}

/**
 * One line per open lane (an unmerged branch) for the compaction summary; [] for a subagent or when the check cannot be read.
 * @returns {Promise<string[]>}
 */
export async function openLanes(input, env = process.env, deps = {}) {
  if (typeof input?.agent_id === 'string' && input.agent_id !== '') return [];
  const lines = [];
  await inspectWithinBudget(input, env, deps, ({ top }, timeoutMs) => {
    const verdict = verdictFor(env, input.session_id, top, deps, timeoutMs);
    for (const { kind, subject, detail } of verdict?.hints ?? []) if (kind === OPEN_LANE) lines.push(`open lane ${subject}: ${detail}`);
  });
  return lines;
}

/** The detached job: check `top` for as long as it takes and store the verdict for the next stop. */
function refresh(top, session, env) {
  const fingerprint = fingerprintOf(top);
  const verdict = fingerprint === null || !isSessionId(session) || anyWorktreeNamesFilter(top) ? undefined : runCheckChild(top, REFRESH_TIMEOUT_MS, env);
  if (verdict !== undefined && verdict !== 'timeout') storeVerdict(env, session, { top, fingerprint }, verdict);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  if (process.argv[2] === '--refresh') {
    refresh(process.argv[3], process.argv[4], process.env);
    return;
  }
  const input = JSON.parse(await readStdin());
  if (input?.hook_event_name === 'PreCompact') {
    const lines = await openLanes(input);
    if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }
  const result = await decide(input);
  if (result.block) process.stdout.write(`${JSON.stringify({ decision: 'block', reason: result.reason })}\n`);
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`git-tidy-gate: ${error.message}\n`); // never trap a session
  }
}
