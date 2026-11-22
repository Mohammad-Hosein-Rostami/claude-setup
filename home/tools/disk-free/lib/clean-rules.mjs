// The six clean-up rules of disk-clean. Exports: AGE, rulesFor.
// Each rule is an async generator that yields { path, root, stillRemovable } for one thing to remove: `root` is the real path the rule is
// confined to, `stillRemovable(where)` is asked again right before the removal and once more after the folder was renamed aside to
// `.removing-<pid>-<name>` (a session may have been resumed since the scan); `where` is the path to look at. A `.removing-*` folder left by a
// killed run is found by the rules like the folder it was and removed only when the same checks pass for its original name; one with this
// process's own pid is this run's (a folder whose rename back failed) and is skipped, so a run never handles its own renames. Rules only
// look (they remove nothing), stream (nothing holds a whole folder listing) and stop when context.timeUp() says the scan time is over.
//   session-folders  /private/tmp/claude-<uid>/<project>/<session-id>/ of a session that is not running, whose transcript is found in the scanned
//                    projects folder and idle for 3 days, and whose folder is idle for 3 days. With no transcript found the session is unknown:
//                    the scratchpad root is shared by every config dir of the user (CLAUDE_CONFIG_DIR), while the transcripts and the registry
//                    read here are one config dir's, so the folder may be a running session's of another one. It is kept, counted in
//                    context.keptUnknown, until nothing anywhere in it was modified for 30 days. Found or unknown is decided again on every look.
//                    An empty folder (what a `claude -p` call such as recall's checkpoint leaves) keeps the 3-day rule. Only a regular
//                    `<id>.jsonl` file counts as a transcript, and ids are compared in lower case (APFS names are case-insensitive).
//   session-scratch  in every session folder the rule above keeps (the current one, running ones, ones not idle long enough), the
//                    entries of <session-id>/scratchpad/ that are a real folder named cs-test-* or a git clone (a folder holding a `.git`
//                    folder; a linked worktree's `.git` file does not count, its repository lives elsewhere), when nothing anywhere in it
//                    was modified for 2 days (owner FR5: a session that runs for days keeps only its newest 2 days). The session's
//                    liveness does not matter here: the whole-tree age is the test, so a folder a running lane still writes stays. Any
//                    other name, a link and a session folder the rule above took in this run (listed or removed) are never looked at.
//                    Crash case: a `.removing-<pid>-<name>` entry a killed run left is judged by its original name, like in the rules below.
//   test-temp        os.tmpdir() folders named by this repo's test prefixes, idle for 1 day
//   temp-projects    ~/.claude/projects/<slug> folders that Claude Code made for a throwaway temp path, idle for 3 days
//   hook-state       os.tmpdir()/claude-post-edit and /claude-skill-router: per-session counters and markers of the hooks, idle for 3 days
//   figma-pulls      ~/.cache/figma/<file>/<node> folders of figma-pull (ui-check), nothing in them modified for 30 days
// Never yields the folder of the current session (--session, the newest transcript) or a running one (~/.claude/sessions/*.json with a
// live pid); only session-scratch looks inside them, at the old cs-test-* and clone folders.
// A root that is not safe (see safe-remove.mjs inspectRoot) is refused and noted in context.refused. The session-folders rule also needs the
// transcripts folder and the sessions registry to be absolute, readable folders: without them every session would look finished.
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { entriesOf, lstatOrNull, mtimeOf, touchedSince } from './clean-scan.mjs';
import { liveSessionIds } from './live-sessions.mjs';
import { inspectRoot, isOwnAside, originalName, ownedFolder, UnsafeRoot } from './safe-remove.mjs';
import { OLD_TEST_PREFIXES } from './test-temp-prefixes.mjs';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const AGE = {
  sessionFolderMs: 3 * MS_PER_DAY, // the owner's "not modified for 3 days"
  unknownSessionFolderMs: 30 * MS_PER_DAY, // a session folder with no transcript in the scanned projects folder: maybe another config dir's session, so much longer
  sessionScratchMs: 2 * MS_PER_DAY, // owner FR5 (2026-11-22): a long-running session's cs-test-* and clone folders; the newest 2 days stay
  testTempMs: 1 * MS_PER_DAY,
  tempProjectMs: 3 * MS_PER_DAY,
  hookStateMs: 3 * MS_PER_DAY,
  // A pull is reused for the whole UI job (days, not weeks); after a month idle the design has likely moved on and is pulled again.
  figmaPullMs: 30 * MS_PER_DAY,
};
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEMP_PROJECT_SLUG = /^-(?:private-var-folders|private-tmp|tmp)-/;
const RANDOM_SUFFIX_LENGTH = 6; // what mkdtemp appends
// tests/temp-dir-helpers.mjs makes cs-test-<label><6 characters>, with-run-tmp.mjs makes cs-run-<6 characters>.
const NEW_TEST_NAME = new RegExp(`^(?:cs-test-[\\w.-]*|cs-run-)[A-Za-z0-9]{${RANDOM_SUFFIX_LENGTH}}$`);
const HOOK_STATE_FOLDERS = ['claude-post-edit', 'claude-skill-router'];
const SCRATCHPAD = 'scratchpad'; // Claude Code's temp folder of one session: <claude tmp>/<project>/<session id>/scratchpad
const SCRATCH_TEST_PREFIX = 'cs-test-'; // the name agents and probes give their throwaway folders (CLAUDE.md "Probes")
const GIT_FOLDER = '.git';
const TRANSCRIPT_FILE = /^(.+)\.jsonl$/;

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OLD_TEST_NAME = new RegExp(`^(?:${OLD_TEST_PREFIXES.map(escapeRegex).join('|')})[A-Za-z0-9]{${RANDOM_SUFFIX_LENGTH}}$`);

/**
 * The real path and kind of a rule's root, or null when it is missing or refused (the reason goes to context.refused).
 * @param {{ allowShared?: boolean, saidBefore?: boolean }} options a root shared with others (/tmp) is refused unless allowShared;
 *   saidBefore: an earlier rule reads the same root, so a reason already in context.refused is not listed a second time
 */
function trustedRoot(context, folder, { allowShared = false, saidBefore = false } = {}) {
  try {
    const trusted = inspectRoot(folder, context.home);
    if (trusted?.shared && !allowShared) throw new UnsafeRoot(`root ${folder} is shared with other users; this rule needs a folder of its own`);
    return trusted;
  } catch (error) {
    if (!(error instanceof UnsafeRoot)) throw error;
    if (!(saidBefore && context.refused.includes(error.message))) context.refused.push(error.message);
    return null;
  }
}

/** True when `folder` is an absolute path to a folder this process can read; otherwise the reason goes to context.refused. */
function isReadableFolder(context, folder, what) {
  try {
    if (typeof folder === 'string' && isAbsolute(folder) && statSync(folder).isDirectory()) {
      accessSync(folder, constants.R_OK);
      return true;
    }
  } catch {
    // falls through to the refusal below: an unreadable folder is reported, not guessed at
  }
  context.refused.push(`${what} ${JSON.stringify(folder)} is not an absolute path to a readable folder; session folders are kept`);
  return false;
}

/** Map of session id -> { mtimeMs, files } of its transcripts, over every project folder (a few dozen folders, one small read each). */
async function transcriptTimes(context) {
  const times = new Map();
  for await (const project of entriesOf(context.projects)) {
    if (!project.isDirectory()) continue;
    for await (const file of entriesOf(join(context.projects, project.name))) {
      if (context.timeUp()) return times;
      const id = TRANSCRIPT_FILE.exec(file.name)?.[1]?.toLowerCase();
      const path = join(context.projects, project.name, file.name);
      // Only a regular file is a transcript: a planted link, folder or FIFO of that name does not shorten the 30-day rule (security F1).
      const mtimeMs = id !== undefined && SESSION_ID.test(id) && file.isFile() ? mtimeOf(path) : null;
      if (mtimeMs === null) continue;
      const known = times.get(id) ?? { mtimeMs: 0, files: [] };
      times.set(id, { mtimeMs: Math.max(known.mtimeMs, mtimeMs), files: [...known.files, path] });
    }
  }
  return times;
}

/** Modification times (ms) of the regular files that exist; empty when none does. */
const mtimesOf = (files) => files.map(lstatOrNull).filter((info) => info?.isFile()).map((info) => info.mtimeMs);

/** True when the folder has no entry at all. */
async function isEmptyFolder(path) {
  const entries = entriesOf(path);
  const first = await entries.next();
  await entries.return();
  return first.done === true;
}

async function* sessionFolders(context) {
  const trusted = trustedRoot(context, context.claudeTmp);
  if (trusted === null || !isReadableFolder(context, context.projects, 'the transcripts folder') || !isReadableFolder(context, context.sessions, 'the sessions registry')) return;
  const root = trusted.real;
  const times = await transcriptTimes(context);
  const newest = [...times.entries()].sort((a, b) => b[1].mtimeMs - a[1].mtimeMs)[0]?.[0];
  const cutoff = context.nowMs - AGE.sessionFolderMs;
  const live = await liveSessionIds(context.sessions);
  for await (const project of entriesOf(root)) {
    const projectPath = join(root, project.name);
    if (context.timeUp()) return;
    if (ownedFolder(projectPath) === null) continue;
    for await (const folder of entriesOf(projectPath)) {
      if (context.timeUp()) return;
      const path = join(projectPath, folder.name);
      const id = originalName(folder.name).toLowerCase();
      if (isOwnAside(folder.name) || !SESSION_ID.test(id) || id === context.session?.toLowerCase() || id === newest || ownedFolder(path) === null) continue;
      // The transcript of the same project folder is looked at again: a resumed session may have made it since the scan.
      const transcriptFiles = () => [...(times.get(id)?.files ?? []), join(context.projects, project.name, `${id}.jsonl`)];
      // 'idle', 'busy', or 'unknown' for a folder that is kept only because no transcript of its session is found (it may be another config dir's).
      const stateOf = async (liveNow, where) => {
        if (liveNow.has(id) || [...liveNow].some((liveId) => String(liveId).toLowerCase() === id)) return 'busy';
        const transcriptMtimes = mtimesOf(transcriptFiles());
        if (transcriptMtimes.length === 0 && (await isEmptyFolder(where))) return (await touchedSince(where, cutoff)) ? 'busy' : 'idle';
        if (transcriptMtimes.length === 0) return (await touchedSince(where, context.nowMs - AGE.unknownSessionFolderMs)) ? 'unknown' : 'idle';
        return Math.max(...transcriptMtimes) >= cutoff || (await touchedSince(where, cutoff)) ? 'busy' : 'idle';
      };
      const state = await stateOf(live, path);
      if (state === 'unknown') context.keptUnknown = (context.keptUnknown ?? 0) + 1;
      if (state === 'idle') yield { path, root, stillRemovable: async (where = path) => (await stateOf(await liveSessionIds(context.sessions), where)) === 'idle' };
    }
  }
}

/** True for a scratchpad entry the session-scratch rule may take: a real folder (never a link) named cs-test-*, or one that holds a `.git` folder. */
function isScratchLeftover(path, name) {
  if (ownedFolder(path) === null) return false;
  return name.startsWith(SCRATCH_TEST_PREFIX) || lstatOrNull(join(path, GIT_FOLDER))?.isDirectory() === true;
}

/** The cs-test-* and clone folders of one scratchpad in which nothing was modified since `cutoff`. */
async function* scratchLeftovers(context, root, scratchpad, cutoff) {
  if (ownedFolder(scratchpad) === null) return;
  for await (const entry of entriesOf(scratchpad)) {
    if (context.timeUp()) return;
    if (isOwnAside(entry.name)) continue;
    const name = originalName(entry.name);
    const path = join(scratchpad, entry.name);
    const isOld = async (where = path) => isScratchLeftover(where, name) && !(await touchedSince(where, cutoff));
    if (await isOld()) yield { path, root, stillRemovable: isOld };
  }
}

async function* sessionScratch(context) {
  const trusted = trustedRoot(context, context.claudeTmp, { saidBefore: true });
  if (trusted === null) return;
  const root = trusted.real;
  const cutoff = context.nowMs - AGE.sessionScratchMs;
  for await (const project of entriesOf(root)) {
    const projectPath = join(root, project.name);
    if (context.timeUp()) return;
    if (ownedFolder(projectPath) === null) continue;
    for await (const session of entriesOf(projectPath)) {
      if (context.timeUp()) return;
      const sessionPath = join(projectPath, session.name);
      // A `.removing-*` session folder is the session-folders rule's; one that rule listed or removed in this run is not counted twice.
      if (!SESSION_ID.test(session.name) || context.handled?.has(sessionPath) || ownedFolder(sessionPath) === null) continue;
      yield* scratchLeftovers(context, root, join(sessionPath, SCRATCHPAD), cutoff);
    }
  }
}

async function* testTemp(context) {
  const trusted = trustedRoot(context, context.tmp, { allowShared: true });
  if (trusted === null) return;
  const { real: root, shared } = trusted;
  const cutoff = context.nowMs - AGE.testTempMs;
  for await (const entry of entriesOf(root)) {
    if (context.timeUp()) return;
    // In a shared /tmp only the names this repo makes now: an old prefix plus 6 characters could be anyone's folder.
    const name = originalName(entry.name);
    if (isOwnAside(entry.name) || !(NEW_TEST_NAME.test(name) || (!shared && OLD_TEST_NAME.test(name)))) continue;
    const path = join(root, entry.name);
    const isOld = (where = path) => (ownedFolder(where)?.mtimeMs ?? Infinity) < cutoff;
    if (isOld()) yield { path, root, stillRemovable: isOld };
  }
}

const holdsSession = (folder, ids) => ids.some((id) => ownedFolder(join(folder, id)) !== null || lstatOrNull(join(folder, `${id}.jsonl`)) !== null);

async function* tempProjects(context) {
  const trusted = trustedRoot(context, context.projects);
  if (trusted === null) return;
  const root = trusted.real;
  const cutoff = context.nowMs - AGE.tempProjectMs;
  const sessionsIn = async () => [context.session, ...(await liveSessionIds(context.sessions))].filter((id) => id !== undefined);
  for await (const entry of entriesOf(root)) {
    if (context.timeUp()) return;
    if (isOwnAside(entry.name) || !TEMP_PROJECT_SLUG.test(originalName(entry.name))) continue;
    const path = join(root, entry.name);
    const isIdle = async (where = path) => ownedFolder(where) !== null && !holdsSession(where, await sessionsIn()) && !(await touchedSince(where, cutoff));
    if (await isIdle()) yield { path, root, stillRemovable: isIdle };
  }
}

async function* hookState(context) {
  const trusted = trustedRoot(context, context.tmp, { allowShared: true });
  if (trusted === null) return;
  const root = trusted.real;
  const cutoff = context.nowMs - AGE.hookStateMs;
  for (const folderName of HOOK_STATE_FOLDERS) {
    const folder = join(root, folderName);
    if (ownedFolder(folder) === null) continue;
    for await (const kind of entriesOf(folder)) {
      const kindPath = join(folder, kind.name);
      if (ownedFolder(kindPath) === null) continue;
      for await (const file of entriesOf(kindPath)) {
        if (context.timeUp()) return;
        const path = join(kindPath, file.name);
        const isOld = () => {
          const info = lstatOrNull(path);
          return info !== null && info.isFile() && info.mtimeMs < cutoff;
        };
        if (isOld()) yield { path, root, stillRemovable: isOld };
      }
    }
  }
}

async function* figmaPulls(context) {
  if (context.figmaCache === undefined || lstatOrNull(context.figmaCache) === null) return; // no pull was ever made
  const trusted = trustedRoot(context, context.figmaCache);
  if (trusted === null) return;
  const root = trusted.real;
  const cutoff = context.nowMs - AGE.figmaPullMs;
  for await (const file of entriesOf(root)) {
    const filePath = join(root, file.name);
    if (isOwnAside(file.name) || ownedFolder(filePath) === null) continue;
    for await (const node of entriesOf(filePath)) {
      if (context.timeUp()) return;
      const path = join(filePath, node.name);
      if (isOwnAside(node.name)) continue;
      const isIdle = async (where = path) => ownedFolder(where) !== null && !(await touchedSince(where, cutoff));
      if (await isIdle()) yield { path, root, stillRemovable: isIdle };
    }
  }
}

/** @returns {{ name: string, label: string, find: (context: object) => AsyncGenerator<{ path: string, root: string, stillRemovable: (where?: string) => Promise<boolean> | boolean }> }[]} */
export const rulesFor = () => [
  { name: 'session-folders', label: 'finished sessions\' scratchpad folders', find: sessionFolders },
  { name: 'session-scratch', label: 'cs-test and clone folders idle 2 days in kept sessions\' scratchpads', find: sessionScratch },
  { name: 'test-temp', label: 'leftover test temp folders', find: testTemp },
  { name: 'temp-projects', label: 'Claude project folders of throwaway temp paths', find: tempProjects },
  { name: 'hook-state', label: 'old hook counters and markers in the temp folder', find: hookState },
  { name: 'figma-pulls', label: 'Figma pulls not used for 30 days', find: figmaPulls },
];
