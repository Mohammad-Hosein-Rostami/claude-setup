// The four clean-up rules of disk-clean. Exports: AGE, rulesFor.
// Each rule is an async generator that yields { path, root } for one thing to remove, where `root` is the real path the rule is
// confined to. Rules only look (they remove nothing) and stream: nothing holds a whole folder listing.
//   session-folders  /private/tmp/claude-<uid>/<project>/<session-id>/ whose transcript is idle for 3 days (or missing and the folder idle 3 days)
//   test-temp        os.tmpdir() folders named by this repo's test prefixes, idle for 1 day
//   temp-projects    ~/.claude/projects/<slug> folders that Claude Code made for a throwaway temp path, idle for 3 days
//   hook-state       os.tmpdir()/claude-post-edit and /claude-skill-router: per-session counters and markers of the hooks, idle for 3 days
// Never yields the current session: its id (--session) and the session with the newest transcript.
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { entriesOf, mtimeOf, touchedSince } from './clean-scan.mjs';
import { OLD_TEST_PREFIXES } from './test-temp-prefixes.mjs';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const AGE = {
  sessionFolderMs: 3 * MS_PER_DAY, // the owner's "not modified for 3 days"
  testTempMs: 1 * MS_PER_DAY,
  tempProjectMs: 3 * MS_PER_DAY,
  hookStateMs: 3 * MS_PER_DAY,
};
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEMP_PROJECT_SLUG = /^-(?:private-var-folders|private-tmp|tmp)-/;
const NEW_TEST_PREFIX = /^cs-(?:test|run)-/; // tests/temp-dir-helpers.mjs and with-run-tmp.mjs
const RANDOM_SUFFIX_LENGTH = 6; // what mkdtemp appends
const HOOK_STATE_FOLDERS = ['claude-post-edit', 'claude-skill-router'];
const TRANSCRIPT_FILE = /^(.+)\.jsonl$/;

const realRootOf = (folder) => {
  try {
    return realpathSync(folder);
  } catch {
    return null;
  }
};
const isRealFolder = (path) => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Map of session id -> newest transcript mtime, over every project folder (a few dozen folders, one small read each). */
async function transcriptTimes(projectsRoot) {
  const times = new Map();
  for await (const project of entriesOf(projectsRoot)) {
    if (!project.isDirectory()) continue;
    for await (const file of entriesOf(join(projectsRoot, project.name))) {
      const id = TRANSCRIPT_FILE.exec(file.name)?.[1];
      if (id === undefined || !SESSION_ID.test(id)) continue;
      try {
        times.set(id, Math.max(times.get(id) ?? 0, lstatSync(join(projectsRoot, project.name, file.name)).mtimeMs));
      } catch {
        // removed meanwhile
      }
    }
  }
  return times;
}

async function* sessionFolders({ claudeTmp, projects, session, nowMs }) {
  const root = realRootOf(claudeTmp);
  if (root === null) return;
  const times = await transcriptTimes(projects);
  const newest = [...times.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const cutoff = nowMs - AGE.sessionFolderMs;
  for await (const project of entriesOf(root)) {
    if (!project.isDirectory()) continue;
    for await (const folder of entriesOf(join(root, project.name))) {
      const path = join(root, project.name, folder.name);
      if (!folder.isDirectory() || !SESSION_ID.test(folder.name) || folder.name === session || folder.name === newest) continue;
      const transcriptTime = times.get(folder.name);
      const idle = transcriptTime === undefined ? !(await touchedSince(path, cutoff)) : transcriptTime < cutoff;
      if (idle) yield { path, root };
    }
  }
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OLD_TEST_NAME = new RegExp(`^(?:${OLD_TEST_PREFIXES.map(escapeRegex).join('|')})[A-Za-z0-9]{${RANDOM_SUFFIX_LENGTH}}$`);

async function* testTemp({ tmp, nowMs }) {
  const root = realRootOf(tmp);
  if (root === null) return;
  const cutoff = nowMs - AGE.testTempMs;
  for await (const entry of entriesOf(root)) {
    if (!entry.isDirectory() || !(NEW_TEST_PREFIX.test(entry.name) || OLD_TEST_NAME.test(entry.name))) continue;
    const path = join(root, entry.name);
    if ((mtimeOf(path) ?? Infinity) < cutoff) yield { path, root };
  }
}

async function* tempProjects({ projects, session, nowMs }) {
  const root = realRootOf(projects);
  if (root === null) return;
  const cutoff = nowMs - AGE.tempProjectMs;
  for await (const entry of entriesOf(root)) {
    if (!entry.isDirectory() || !TEMP_PROJECT_SLUG.test(entry.name)) continue;
    const path = join(root, entry.name);
    const holdsCurrentSession = session !== undefined && isRealFolder(join(path, session));
    if (!holdsCurrentSession && !(await touchedSince(path, cutoff))) yield { path, root };
  }
}

async function* hookState({ tmp, nowMs }) {
  const root = realRootOf(tmp);
  if (root === null) return;
  const cutoff = nowMs - AGE.hookStateMs;
  for (const folderName of HOOK_STATE_FOLDERS) {
    const folder = join(root, folderName);
    if (!isRealFolder(folder)) continue;
    for await (const kind of entriesOf(folder)) {
      if (!kind.isDirectory()) continue;
      for await (const file of entriesOf(join(folder, kind.name))) {
        const path = join(folder, kind.name, file.name);
        if (file.isFile() && (mtimeOf(path) ?? Infinity) < cutoff) yield { path, root };
      }
    }
  }
}

/** @returns {{ name: string, label: string, find: (context: object) => AsyncGenerator<{ path: string, root: string }> }[]} */
export const rulesFor = () => [
  { name: 'session-folders', label: 'finished sessions\' scratchpad folders', find: sessionFolders },
  { name: 'test-temp', label: 'leftover test temp folders', find: testTemp },
  { name: 'temp-projects', label: 'Claude project folders of throwaway temp paths', find: tempProjects },
  { name: 'hook-state', label: 'old hook counters and markers in the temp folder', find: hookState },
];
