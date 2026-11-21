// Stop and SubagentStop: blocks a stop once when files this session (for a subagent: this agent) changed are still uncommitted in its
// own git worktree, so a run never ends with edits left lying around (C16), and once when it added new files over 5 MB that its brief
// does not list (lib/new-file-size.mjs). Every tool and stop event also writes the call-window log (lib/call-windows.mjs): PreToolUse,
// PostToolUse (any tool), PostToolUseFailure, PostToolBatch, and Stop/SubagentStop before the decision. PostToolUse of Edit/Write/
// MultiEdit/NotebookEdit records the changed file (lib/own-edits.mjs); PreToolUse takes the dirty baseline at the first call of a session
// or agent (lib/dirty-baseline.mjs). Exports: decide(input, env) -> {block: false} | {block: true, reason}, takeBaseline(input, env).
// Invariants:
// - Counted files: (1) recorded ones: each PostToolUse of a file tool adds [agent id ('' for the lead), real path] to
//   ~/.claude/state/commit-gate/edits/<session>.json (lib/own-edits.mjs); (2) files a Bash command made or changed: dirty now and clean,
//   or different, at the baseline of the session or agent taken at its first tool call (path + content hash), in the same worktree.
//   A subagent's stop counts its own files, the lead's stop every file of the session (its agents' too). A file in another agent's
//   record never counts for an agent, dirt from before the first tool call never counts, nor another session's recorded files. A
//   Bash-made file is left out only when lib/change-owner.mjs shows it foreign: changed outside every own call window and claimed by a
//   closed window of another, older session (or, at an agent's stop, of another agent); anything else counts. A record or baseline that
//   failed is lost (fail open: fewer files count). The baseline runs the same hardened git as the stop.
// - Only the session's own worktree is gated: for the main session the one holding CLAUDE_PROJECT_DIR, for a subagent the one
//   holding the folder it started in (the first `cwd` of its transcript). Never the hook input's cwd: a folder the session only
//   cd'd into may be someone else's repo, and its git config is not trusted.
// - git never runs a program the repository names: every call has core.fsmonitor off, core.hooksPath empty and bare-repo discovery
//   off (a package laid out like a bare repo is not a repository here); a worktree whose repo-level config (includes followed)
//   defines a filter is passed without a word, since `git status` would run its clean command. Submodules are not looked into.
// - Blocks at most once per dirty state of each agent: the state is the agent id, the worktree path and the hash of the recorded
//   files' entries in `git status --porcelain=v1 -z`, kept in ~/.claude/state/commit-gate/<session>.json (lib/session-store.mjs). A continued stop
//   (stop_hook_active, another gate blocked first) is checked too, but gets at most MAX_CHAINED_BLOCKS blocks in a row, so the gate
//   can never loop. A state that cannot be stored is not blocked.
// - A subagent whose definition cannot write files (built-in Explore and Plan, or an agent file whose `tools:` line has no Write or
//   Edit) is never told to commit: the edits it sees are someone else's.
// - Read-only hold (lib/read-only-hold.mjs): a subagent whose brief has a `read-only:` or `scratchpad-only:` line (or, brief unreadable,
//   whose launch was recorded read-only) is blocked once per set of changed files with the read-only reason instead of "commit them":
//   its recorded files outside the temp and scratchpad roots (committed or not, any folder) plus its own Bash-made files in its worktree.
// - Passes without a word: not a git worktree, a branch with no commit yet, a rebase/merge/cherry-pick/revert in progress, and
//   files git ignores (.gitignore, .git/info/exclude: STATUS.md and other work notes).
// - When the branch was moved under the folder (its index equals an earlier reflog position behind the tip), the staged-only entries
//   are that gap, not work, and never count: the reason gives the sync command instead of "commit them", when own entries exist and
//   also when none do but a gap file changed since the baseline and the move is not another session's (lib/base-moves.mjs). When the dirty worktree has the base branch
//   (main, master, develop) checked out and other worktrees exist, the reason adds that edits belong in a lane worktree.
// - Any internal error is one stderr line and exit 0: a session is never trapped. A few git calls, well under 300 ms.
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { moveContext, moveVerdict } from './lib/base-moves.mjs';
import { FILE_TOOLS, recordCallEdge, reflogPathOf } from './lib/call-windows.mjs';
import { ownBashEntries } from './lib/change-owner.mjs';
import { withSessionLock } from './lib/session-lock.mjs';
import { readSessionFile, writeSessionFile } from './lib/session-store.mjs';
import { baselineOf, changedSinceBaseline, hasBaseline, saveBaseline } from './lib/dirty-baseline.mjs';
import { oversizeNewFiles, sizeReason, unlistedFiles } from './lib/new-file-size.mjs';
import { changedOutsideScratch, isHeldReadOnly, readOnlyReason } from './lib/read-only-hold.mjs';
import { countedGate } from './lib/stop-block-count.mjs';
import { LEAD, isRecordedEntry, realPathOf, recordEditedFile, recordedPaths, statusEntries } from './lib/own-edits.mjs';
import { gatedFolder, gitOut, gitSucceeds, gitText, namesFilterProgram, readHead, worktreeOf } from './lib/gated-folder.mjs';
import { statusFileOf } from './lib/status-file-of.mjs';
import { parseWorkItems } from '../tools/estimate/lib/items.mjs';
import { readStatusFile } from '../tools/status/status-file.mjs';

const PASS = Object.freeze({ block: false });
const BASE_BRANCHES = new Set(['main', 'master', 'develop']);
// files git keeps in the worktree's git folder while an operation waits for the user
const IN_PROGRESS_MARKERS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];
const STATES_KEPT = 50; // dirty states remembered per session; older ones may block once more, which is harmless
const MAX_STORE_BYTES = 64 * 1024; // one cap for writer and reader (P6): the states and up to MAX_LISTED_KEPT listed paths
const MAX_LISTED_KEPT = 200;
const BRIEF_HEAD_BYTES = 1024 * 1024; // the first line of an agent transcript holds its brief
const MAX_CHAINED_BLOCKS = 2; // blocks given to continued stops in a row, a hard bound on how long a stop can be held
const BRANCH_POSITIONS_CHECKED = 50; // reflog entries searched for the index (as git-tidy's stale-checkout)

const homeOf = (env) => env.HOME || env.USERPROFILE || homedir();
const stateDir = (env) => join(homeOf(env), '.claude', 'state', 'commit-gate');
const hashOf = (...parts) => createHash('sha256').update(parts.join('\0')).digest('hex');

function hasLanes(top) {
  const list = gitOut(top, ['worktree', 'list', '--porcelain']);
  return list !== null && list.split('\n').filter((line) => line.startsWith('worktree ')).length > 1;
}

/** The gap when `branch` moved forward under the folder (index = an earlier reflog position behind the tip): {indexAt, tip}, else null. */
function staleGap({ top, branch }) {
  if (gitSucceeds(top, ['diff-index', '--cached', '--quiet', 'HEAD'])) return null;
  const tip = gitText(top, ['rev-parse', 'HEAD']);
  const positions = gitText(top, ['rev-list', '--walk-reflogs', `--max-count=${BRANCH_POSITIONS_CHECKED}`, `refs/heads/${branch}`]);
  const indexAt = [...new Set(positions.split('\n'))].filter((hash) => hash !== '' && hash !== tip)
    .find((hash) => gitSucceeds(top, ['diff-index', '--cached', '--quiet', hash]) && gitSucceeds(top, ['merge-base', '--is-ancestor', hash, tip]));
  return indexAt === undefined ? null : { indexAt, tip };
}

/** The sync advice for a gap. */
function staleText({ top, branch }, { indexAt, tip }) {
  const [from, to] = [indexAt, tip].map((hash) => gitText(top, ['rev-parse', '--short', hash]));
  const behind = gitText(top, ['rev-list', '--count', `${indexAt}..${tip}`]);
  return `Branch ${branch} moved to ${to} under ${top} while its index stayed at ${from} (${behind} commits): its staged changes `
    + 'undo landed work, so never commit or stash them. '
    + `Sync the folder: git -C ${top} reset --soft ${from} && git -C ${top} merge --ff-only ${to} (unstaged edits stay; it refuses rather than overwrite one).`;
}

function dirtyText({ top, branch }, count) {
  const reason = `Uncommitted changes in ${top} (${count} files): commit them as small Conventional Commits `
    + '(`git commit -m ... -- <paths>`), or say in your reply why they must stay uncommitted.';
  if (!BASE_BRANCHES.has(branch) || !hasLanes(top)) return reason;
  return `${reason} This is the base folder (${branch}) and lane worktrees exist: edits belong in a lane worktree, never in the base folder.`;
}

/** Parses the store; a corrupt or odd file reads as empty (this state may then block once more). */
function parseRecord(text) {
  try {
    const record = text === null ? {} : JSON.parse(text);
    const states = Array.isArray(record?.states) ? record.states : [];
    const chained = record?.chained !== null && typeof record?.chained === 'object' ? record.chained : {};
    const listed = Array.isArray(record?.listed) ? record.listed.filter((path) => typeof path === 'string') : [];
    return { states, chained, listed };
  } catch {
    return { states: [], chained: {}, listed: [] };
  }
}

/** Changes the session record under its lock; `change` returns the new record or null (no write). True only when written. */
function updateRecord(env, session, change) {
  const dir = stateDir(env);
  return withSessionLock(dir, session, () => {
    const text = readSessionFile(dir, session, MAX_STORE_BYTES);
    if (text === undefined) return false;
    const next = change(parseRecord(text));
    const nextText = next === null ? null : JSON.stringify(next);
    return nextText !== null && Buffer.byteLength(nextText) <= MAX_STORE_BYTES && writeSessionFile(dir, session, nextText);
  }) === true;
}

/** Records `state` for the session; true only when this stop may block (a new state, within the chain bound, and stored). */
const recordOnce = (env, session, { agent, state, continued }) => updateRecord(env, session, (record) => {
  if (record.states.includes(state)) return null;
  const inChain = continued ? Number(record.chained[agent]) || 0 : 0; // a fresh stop that blocks starts a new chain
  if (inChain >= MAX_CHAINED_BLOCKS) return null;
  return { ...record, states: [...record.states, state].slice(-STATES_KEPT), chained: { ...record.chained, [agent]: continued ? inChain + 1 : 0 } };
});

/** Adds the real paths of big files an agent's brief listed, for the lead's stop. */
const addListed = (env, session, paths) => paths.length > 0 && updateRecord(env, session, (record) => (
  { ...record, listed: [...new Set([...record.listed, ...paths])].slice(-MAX_LISTED_KEPT) }));

/** The first user message of the agent's transcript (its brief); null when it cannot be read. */
function briefOf(input) {
  if (typeof input.agent_transcript_path !== 'string') return null;
  for (const line of (readHead(input.agent_transcript_path, BRIEF_HEAD_BYTES) ?? '').split('\n')) {
    try {
      const content = JSON.parse(line)?.message?.role === 'user' ? JSON.parse(line).message.content : undefined;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) return content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n');
    } catch {
      return null; // a first line cut at the cap or not JSON: nothing is listed
    }
  }
  return null;
}

/** The open `## Work items` rows of the session's STATUS.md as `id item` texts; [] when none is linked. */
function openRows(input, env) {
  const found = statusFileOf(input, { stateDir: join(homeOf(env), '.claude', 'state', 'estimate'), projectDir: env.CLAUDE_PROJECT_DIR });
  const read = found?.path === undefined ? {} : readStatusFile(found.path);
  if (read.text === undefined) return [];
  return parseWorkItems(read.text).items.filter((row) => row.kind !== 'deliver' && row.done === null).map((row) => `${row.id} ${row.item}`);
}

/** True when the checked-out branch's moves since `fromSha` are all another session's (the watch began there). */
function branchForeign(stop, fromSha) {
  const reflog = reflogPathOf(stop.tree.top, stop.tree.branch);
  if (reflog === null) return false;
  const move = moveVerdict(reflog, gitText(stop.tree.top, ['rev-parse', 'HEAD']), stop.ctx);
  return move.verdict === 'foreign' && move.watch?.tip === fromSha;
}

const isStagedOnly = ({ field }) => field[0] !== ' ' && field[0] !== '?' && field[1] === ' ';

/** The stop's own entries (2.4 steps 1-2): recorded ones and own Bash-made ones; gap entries never count. */
function ownChanges(stop, status) {
  const { env, input, agent, top, recorded } = stop;
  const entries = statusEntries(status, top);
  const gap = staleGap(stop.tree);
  const gapEntries = gap === null ? [] : entries.filter(isStagedOnly);
  const rest = entries.filter((entry) => !gapEntries.includes(entry));
  const others = agent === LEAD ? new Set() : recordedPaths(env, input.session_id, LEAD); // every agent's; own ones are matched first
  const recordedHere = rest.filter((entry) => isRecordedEntry(entry, recorded));
  const unrecorded = rest.filter((entry) => !isRecordedEntry(entry, recorded) && !isRecordedEntry(entry, others));
  const bashMade = ownBashEntries(stop.ctx, changedSinceBaseline(env, input.session_id, agent, top, unrecorded));
  const gapChanged = gapEntries.length > 0 && changedSinceBaseline(env, input.session_id, agent, top, gapEntries).length > 0;
  return { own: [...recordedHere, ...bashMade], bashMade, gap, gapChanged };
}

const blockOnce = (stop, state, reason) => (recordOnce(stop.env, stop.input.session_id, { agent: stop.agent, state, continued: stop.continued })
  ? { block: true, reason } : null);

/** The read-only hold: blocks once per set of changed files (recorded outside the scratch roots, own Bash-made ones) with its reason. */
function holdBlock(stop, bashMade, where) {
  const files = [...new Set([...changedOutsideScratch(stop.recorded, stop.env), ...bashMade.map(({ path }) => path)])].sort();
  if (files.length === 0) return PASS;
  return blockOnce(stop, hashOf(stop.agent, 'read-only', ...files), readOnlyReason(files.length, where)) ?? PASS;
}

/** 2.4 step 3: today's text for own entries, the sync advice with a gap (also with no own entry, unless the move is foreign). */
function changeBlock(stop, { own, gap, gapChanged }) {
  const fields = own.map(({ field }) => field);
  if (gap === null) return own.length === 0 ? null : blockOnce(stop, hashOf(stop.agent, stop.tree.top, ...fields), dirtyText(stop.tree, own.length));
  if (own.length > 0) return blockOnce(stop, hashOf(stop.agent, stop.tree.top, ...fields), staleText(stop.tree, gap));
  if (!gapChanged || branchForeign(stop, gap.indexAt)) return null;
  return blockOnce(stop, hashOf(stop.agent, stop.tree.top, `stale:${gap.indexAt}..${gap.tip}`), staleText(stop.tree, gap));
}

/** 2.5: new files over the limit that no brief, listed record or open row names. */
function sizeBlock(stop, own) {
  const { env, input, agent, tree } = stop;
  const baseline = baselineOf(env, input.session_id, agent);
  const moved = typeof baseline?.head === 'string' && baseline.head !== gitText(tree.top, ['rev-parse', 'HEAD']);
  const head = moved && !branchForeign(stop, baseline.head) ? baseline.head : null;
  const files = oversizeNewFiles({ top: stop.top, gitTop: tree.top }, { head }, own);
  if (files === null || files.length === 0) return null;
  const sources = agent === LEAD
    ? { listed: new Set(parseRecord(readSessionFile(stateDir(env), input.session_id, MAX_STORE_BYTES) ?? null).listed), rows: openRows(input, env) }
    : { brief: briefOf(input) };
  const unlisted = unlistedFiles(files, sources);
  if (agent !== LEAD) addListed(env, input.session_id, files.filter((file) => !unlisted.includes(file)).map(({ real }) => real));
  return unlisted.length === 0 ? null : blockOnce(stop, hashOf(agent, tree.top, 'size', ...unlisted.map(({ real }) => real)), sizeReason(unlisted));
}

/**
 * The gate decision for one Stop or SubagentStop event.
 * @param {{session_id?: string, agent_id?: string, agent_type?: string, agent_transcript_path?: string, transcript_path?: string, stop_hook_active?: boolean}} input hook JSON
 * @param {Record<string, string | undefined>} [env] HOME (the state folder, user agent files) and CLAUDE_PROJECT_DIR
 * @returns {{block: false} | {block: true, reason: string}}
 */
export function decide(input, env = process.env) {
  if (input === null || typeof input !== 'object') return PASS;
  const agent = typeof input.agent_id === 'string' ? input.agent_id : LEAD;
  const recorded = recordedPaths(env, input.session_id, agent);
  if (recorded.size === 0 && !hasBaseline(env, input.session_id, agent)) return PASS; // nothing changed by this session or agent: no git call
  const held = isHeldReadOnly(input, briefOf(input), env); // before the folder checks: an agent started in ~ has no worktree
  const base = { input, env, agent, recorded, continued: input.stop_hook_active === true };
  const folder = gatedFolder(input, env);
  const tree = folder === null ? null : worktreeOf(folder);
  const unusable = tree === null || IN_PROGRESS_MARKERS.some((marker) => existsSync(join(tree.gitDir, marker))) || namesFilterProgram(tree.top);
  const status = unusable ? null : dirtyStatus(tree.top);
  if (status === null) return held ? holdBlock(base, [], null) : PASS;
  const top = realPathOf(tree.top);
  const ctx = { ...moveContext(input, env, top, agent === LEAD ? null : agent), takenMs: baselineOf(env, input.session_id, agent)?.takenMs ?? null };
  const stop = { ...base, tree, top, ctx };
  const changes = ownChanges(stop, status);
  if (held) return holdBlock(stop, changes.bashMade, tree.top);
  return changeBlock(stop, changes) ?? sizeBlock(stop, changes.own) ?? PASS;
}

const dirtyStatus = (top) => gitOut(top, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all']);

/**
 * At the first tool call of the session or agent: stores which files of its worktree are dirty, and how (lib/dirty-baseline.mjs), with
 * the HEAD sha and the time, so a stop can tell files Bash made from dirt that was there before. Later calls only check that a baseline exists.
 * @param {{session_id?: string, agent_id?: string, cwd?: string}} input PreToolUse hook JSON (an agent's cwd is the folder it works in)
 * @param {Record<string, string | undefined>} [env] HOME and CLAUDE_PROJECT_DIR (the lead's worktree)
 */
export function takeBaseline(input, env = process.env) {
  const agent = typeof input?.agent_id === 'string' ? input.agent_id : LEAD;
  if (hasBaseline(env, input?.session_id, agent)) return;
  const folder = agent === LEAD ? env.CLAUDE_PROJECT_DIR : input.cwd;
  const tree = typeof folder === 'string' && isAbsolute(folder) ? worktreeOf(folder) : null;
  if (tree === null || namesFilterProgram(tree.top)) {
    saveBaseline(env, input.session_id, agent, null, []); // nothing to gate here: later calls skip git
    return;
  }
  const top = realPathOf(tree.top);
  const status = dirtyStatus(tree.top);
  const head = gitText(tree.top, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (status !== null) saveBaseline(env, input.session_id, agent, top, statusEntries(status, top), head);
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const input = JSON.parse(await readStdin());
  const event = input?.hook_event_name;
  if (event === 'PreToolUse') takeBaseline(input);
  recordCallEdge(input); // the call-window log; a Stop or SubagentStop writes its `quiet` line before the decision
  if (event === 'PostToolUse' && FILE_TOOLS.has(input.tool_name)) recordEditedFile(input); // the settings matcher did this until round 9
  if (event !== 'Stop' && event !== 'SubagentStop') return;
  const result = await countedGate('commit-gate', input, () => decide(input)); // lib/stop-block-count.mjs: the cap record
  if (result.block) process.stdout.write(`${JSON.stringify({ decision: 'block', reason: result.reason })}\n`);
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`commit-gate: ${error.message}\n`); // never trap a session
  }
}
