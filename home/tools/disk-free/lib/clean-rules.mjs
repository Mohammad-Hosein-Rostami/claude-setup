// The four clean-up rules of disk-clean. Exports: AGE, rulesFor.
// Each rule is an async generator that yields { path, root, stillRemovable } for one thing to remove: `root` is the real path the rule is
// confined to, `stillRemovable(where)` is asked again right before the removal and once more after the folder was renamed aside to
// `.removing-<pid>-<name>` (a session may have been resumed since the scan); `where` is the path to look at. A `.removing-*` folder left by a
// killed run is found by the rules like the folder it was and removed only when the same checks pass for its original name. Rules only
// look (they remove nothing), stream (nothing holds a whole folder listing) and stop when context.timeUp() says the scan time is over.
//   session-folders  /private/tmp/claude-<uid>/<project>/<session-id>/ of a session that is not running, whose transcript is found in the scanned
//                    projects folder and idle for 3 days, and whose folder is idle for 3 days. With no transcript found the session is unknown:
//                    the scratchpad root is shared by every config dir of the user (CLAUDE_CONFIG_DIR), while the transcripts and the registry
//                    read here are one config dir's, so the folder may be a running session's of another one. It is kept, counted in
//                    context.keptUnknown, until nothing anywhere in it was modified for 30 days. Found or unknown is decided again on every look.
//   test-temp        os.tmpdir() folders named by this repo's test prefixes, idle for 1 day
//   temp-projects    ~/.claude/projects/<slug> folders that Claude Code made for a throwaway temp path, idle for 3 days
//   hook-state       os.tmpdir()/claude-post-edit and /claude-skill-router: per-session counters and markers of the hooks, idle for 3 days
// Never yields the current session (--session, the newest transcript) or a running one (~/.claude/sessions/*.json with a live pid).
// A root that is not safe (see safe-remove.mjs inspectRoot) is refused and noted in context.refused. The session-folders rule also needs the
// transcripts folder and the sessions registry to be absolute, readable folders: without them every session would look finished.
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { entriesOf, lstatOrNull, mtimeOf, touchedSince } from './clean-scan.mjs';
import { liveSessionIds } from './live-sessions.mjs';
import { inspectRoot, originalName, ownedFolder, UnsafeRoot } from './safe-remove.mjs';
import { OLD_TEST_PREFIXES } from './test-temp-prefixes.mjs';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const AGE = {
  sessionFolderMs: 3 * MS_PER_DAY, // the owner's "not modified for 3 days"
  unknownSessionFolderMs: 30 * MS_PER_DAY, // a session folder with no transcript in the scanned projects folder: maybe another config dir's session, so much longer
  testTempMs: 1 * MS_PER_DAY,
  tempProjectMs: 3 * MS_PER_DAY,
  hookStateMs: 3 * MS_PER_DAY,
};
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEMP_PROJECT_SLUG = /^-(?:private-var-folders|private-tmp|tmp)-/;
const RANDOM_SUFFIX_LENGTH = 6; // what mkdtemp appends
// tests/temp-dir-helpers.mjs makes cs-test-<label><6 characters>, with-run-tmp.mjs makes cs-run-<6 characters>.
const NEW_TEST_NAME = new RegExp(`^(?:cs-test-[\\w.-]*|cs-run-)[A-Za-z0-9]{${RANDOM_SUFFIX_LENGTH}}$`);
const HOOK_STATE_FOLDERS = ['claude-post-edit', 'claude-skill-router'];
const TRANSCRIPT_FILE = /^(.+)\.jsonl$/;

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OLD_TEST_NAME = new RegExp(`^(?:${OLD_TEST_PREFIXES.map(escapeRegex).join('|')})[A-Za-z0-9]{${RANDOM_SUFFIX_LENGTH}}$`);

/**
 * The real path and kind of a rule's root, or null when it is missing or refused (the reason goes to context.refused).
 * @param {{ allowShared?: boolean }} options a root shared with others (/tmp) is refused unless allowShared
 */
function trustedRoot(context, folder, { allowShared = false } = {}) {
  try {
    const trusted = inspectRoot(folder, context.home);
    if (trusted?.shared && !allowShared) throw new UnsafeRoot(`root ${folder} is shared with other users; this rule needs a folder of its own`);
    return trusted;
  } catch (error) {
    if (!(error instanceof UnsafeRoot)) throw error;
    context.refused.push(error.message);
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
      const id = TRANSCRIPT_FILE.exec(file.name)?.[1];
      const path = join(context.projects, project.name, file.name);
      const mtimeMs = id !== undefined && SESSION_ID.test(id) ? mtimeOf(path) : null;
      if (mtimeMs === null) continue;
      const known = times.get(id) ?? { mtimeMs: 0, files: [] };
      times.set(id, { mtimeMs: Math.max(known.mtimeMs, mtimeMs), files: [...known.files, path] });
    }
  }
  return times;
}

/** Modification times (ms) of the files that exist; empty when none does. */
const mtimesOf = (files) => files.map(mtimeOf).filter((mtimeMs) => mtimeMs !== null);

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
      const id = originalName(folder.name);
      if (!SESSION_ID.test(id) || id === context.session || id === newest || ownedFolder(path) === null) continue;
      // The transcript of the same project folder is looked at again: a resumed session may have made it since the scan.
      const transcriptFiles = () => [...(times.get(id)?.files ?? []), join(context.projects, project.name, `${id}.jsonl`)];
      // 'idle', 'busy', or 'unknown' for a folder that is kept only because no transcript of its session is found (it may be another config dir's).
      const stateOf = async (liveNow, where) => {
        if (liveNow.has(id)) return 'busy';
        const transcriptMtimes = mtimesOf(transcriptFiles());
        if (transcriptMtimes.length === 0) return (await touchedSince(where, context.nowMs - AGE.unknownSessionFolderMs)) ? 'unknown' : 'idle';
        return Math.max(...transcriptMtimes) >= cutoff || (await touchedSince(where, cutoff)) ? 'busy' : 'idle';
      };
      const state = await stateOf(live, path);
      if (state === 'unknown') context.keptUnknown = (context.keptUnknown ?? 0) + 1;
      if (state === 'idle') yield { path, root, stillRemovable: async (where = path) => (await stateOf(await liveSessionIds(context.sessions), where)) === 'idle' };
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
    if (!(NEW_TEST_NAME.test(name) || (!shared && OLD_TEST_NAME.test(name)))) continue;
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
    if (!TEMP_PROJECT_SLUG.test(originalName(entry.name))) continue;
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

/** @returns {{ name: string, label: string, find: (context: object) => AsyncGenerator<{ path: string, root: string, stillRemovable: (where?: string) => Promise<boolean> | boolean }> }[]} */
export const rulesFor = () => [
  { name: 'session-folders', label: 'finished sessions\' scratchpad folders', find: sessionFolders },
  { name: 'test-temp', label: 'leftover test temp folders', find: testTemp },
  { name: 'temp-projects', label: 'Claude project folders of throwaway temp paths', find: tempProjects },
  { name: 'hook-state', label: 'old hook counters and markers in the temp folder', find: hookState },
];
