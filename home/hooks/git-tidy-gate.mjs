// Stop, SubagentStop and PreCompact: keeps git on one line (C37). A lead's Stop is blocked once per repository state while the repo holds
// leftovers `git-tidy check` finds (an unpublished merge commit, an older copy of a re-done lane, a workflow agent's leftover branch, a
// merged branch or worktree), while a base branch moved during this session has no full-suite PASS, or while an old unmerged lane is named
// by no open row of the session's STATUS.md. A SubagentStop is blocked once when the agent left its own empty `worktree-agent-<id>` branch.
// PreCompact prints one line per open lane so the summary keeps them. SessionStart (`r9-git-line`) names the lanes of the session's repo
// not yet landed; PostToolUse(Bash) after a `git worktree add` locks the new lane worktree (lib/lane-lock.mjs), and after `git worktree add`,
// `merge` or `branch` reuses the cached check and, above 5
// unlanded lanes or prunable items, says to run `git-tidy prune`; both put `additionalContext` inside `hookSpecificOutput`.
// Exports: decide(input, env, deps) -> Promise<{block: false, info?} | {block: true, reason}>, openLanes(input, env, deps) -> Promise<string[]>,
//   contextFor(event, input, env, deps) -> Promise<string> (SessionStart / PostToolUse additionalContext, '' for none).
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
// - A base move another, older session's call-window record claims (lib/base-moves.mjs) does not block: the stop prints one
//   `systemMessage` info line per sha instead (never with a block, never on PreCompact). Every own move blocks as before.
// - Any internal error is one stderr line and exit 0: a session is never trapped.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { baseTipProblem } from './lib/base-moves.mjs';
import { editedWorktrees, gatedFolder, gitOut, gitText, namesFilterProgram, worktreeOf } from './lib/gated-folder.mjs';
import { isSessionId } from './lib/session-store.mjs';
import { statusFileOf } from './lib/status-file-of.mjs';
import { cachedVerdict, recordOnce, storeVerdict } from './lib/tidy-gate-store.mjs';
import { pruneNoteText, unlandedText, wantsPruneNote } from './lib/tidy-gate-notes.mjs';
import { lockNewLaneWorktrees } from './lib/lane-lock.mjs';
import { MERGE_COMMIT, OPEN_LANE, PRUNE_KINDS, runCheckChild, UNLANDED } from './lib/tidy-check-child.mjs';
import { parseWorkItems } from '../tools/estimate/lib/items.mjs';
import { isAgentBranch } from '../tools/git-tidy/lib/copies.mjs';
import { readStatusFile } from '../tools/status/status-file.mjs';
import { countedGate } from './lib/stop-block-count.mjs';

const PASS = Object.freeze({ block: false });
const CHECK_TIMEOUT_MS = 4000; // a Stop hook must answer fast; a slower check is finished by the detached refresh
const REFRESH_TIMEOUT_MS = 60_000;
const AGENT_BRANCH_PREFIX = 'worktree-agent-';
const homeOf = (env) => env.HOME || env.USERPROFILE || homedir();
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** A hash of every ref and the worktree list: equal while nothing a check looks at changed; null when git cannot be read. */
function fingerprintOf(top) {
  const refs = gitOut(top, ['for-each-ref', '--format=%(objectname) %(refname)']);
  const trees = gitOut(top, ['worktree', 'list', '--porcelain']);
  return refs === null || trees === null ? null : sha256(`${refs}\0${trees}`);
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
    problems.push({ key: `${UNLANDED}:${subject}`, text: `${UNLANDED} ${subject} is named by no open row of STATUS.md: land it with land-lane (\`node ~/.claude/tools/land-lane/land-lane.mjs --branch ${shellWord(subject)} ...\`, the other flags are in tools/land-lane/README.md) or start its row` });
  }
  const prune = verdict.findings.some(({ kind }) => PRUNE_KINDS.has(kind));
  return { problems, pruneLine: prune ? `node ~/.claude/tools/git-tidy/git-tidy.mjs prune ${shellWord(top)} --apply --include-recent` : null };
}

/** The hygiene reason for one tree, or null; an info line of a foreign base move goes to `infos` instead (spec 2.3, K9). */
async function leadReason(input, env, deps, { top, timeoutMs, infos }) {
  const verdict = verdictFor(env, input.session_id, top, deps, timeoutMs);
  if (verdict === null) return null;
  const { problems, pruneLine } = verdictProblems(verdict, input, env, top);
  const baseProblem = await baseTipProblem(top, verdict.base, input, deps, env);
  if (baseProblem?.info !== undefined) infos.push(baseProblem);
  else if (baseProblem !== null) problems.push(baseProblem);
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
 * @returns {Promise<{block: false, info?: string} | {block: true, reason: string}>} info: a foreign base move without a PASS (printed once)
 */
export async function decide(input, env = process.env, deps = {}) {
  const agent = typeof input?.agent_id === 'string' && input.agent_id !== '' ? input.agent_id : null;
  if (agent !== null) {
    const tree = gatedTree(input, env);
    return tree === null ? PASS : blockOnce(input, env, agent, tree, agentReason(input, tree.top));
  }
  const infos = [];
  const blocked = await inspectWithinBudget(input, env, deps, async (tree, timeoutMs) => {
    const result = blockOnce(input, env, agent, tree, await leadReason(input, env, deps, { top: tree.top, timeoutMs, infos }));
    return result.block ? result : undefined;
  });
  return blocked ?? infoOnce(input, env, infos);
}

/** PASS with the info lines not shown before in this session (once per sha: the agent key `info` of the block store). */
function infoOnce(input, env, infos) {
  const fresh = infos.filter(({ key }) => recordOnce(env, input.session_id, { agent: 'info', state: sha256(`info\0${key}`), continued: false }));
  return fresh.length === 0 ? PASS : { block: false, info: fresh.map(({ info }) => info).join('\n') };
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

/** SessionStart and PostToolUse(Bash): the additionalContext text of `event` (lib/tidy-gate-notes.mjs), '' when there is none. */
export async function contextFor(event, input, env = process.env, deps = {}) {
  if (event === 'PostToolUse' && !wantsPruneNote(input)) return '';
  const tree = gatedTree(input, env);
  if (tree === null) return '';
  if (event === 'PostToolUse') lockNewLaneWorktrees(tree.top, input) // a new lane worktree is locked first (r9-wt-lock); land unlocks it
  const verdict = verdictFor(env, input.session_id, tree.top, deps, checkBudgetMs(env, deps));
  return event === 'SessionStart' ? unlandedText(tree.top, verdict) : pruneNoteText(tree.top, verdict);
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
  const event = input?.hook_event_name;
  if (event === 'SessionStart' || event === 'PostToolUse') {
    const context = await contextFor(event, input);
    // A top-level additionalContext is dropped (hooks docs, #96193): it goes inside hookSpecificOutput.
    if (context !== '') process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } })}\n`);
    return;
  }
  if (input?.hook_event_name === 'PreCompact') {
    const lines = await openLanes(input);
    if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }
  const result = await countedGate('git-tidy-gate', input, () => decide(input)); // lib/stop-block-count.mjs: the cap record
  if (result.block) process.stdout.write(`${JSON.stringify({ decision: 'block', reason: result.reason })}\n`);
  else if (result.info !== undefined) process.stdout.write(`${JSON.stringify({ systemMessage: result.info })}\n`);
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`git-tidy-gate: ${error.message}\n`); // never trap a session
  }
}
