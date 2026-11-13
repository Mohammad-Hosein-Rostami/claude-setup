// Compaction notes for the mode hook's SessionStart (source `compact`). Exports: compactNotes(dir, sessionId, transcriptPath).
// Invariants: the count lives in `<dir>/<sessionId>.compacts` (pruned with the mode state files); a failed read or
// write counts as the first compaction and reports to stderr; never throws.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findStatusPath } from './transcript.mjs';

const REPEATED_COMPACTIONS = 3; // from this many compactions on, suggest a handoff and a fresh session
const STATUS_REREAD_LINES = 60;
const COMPACT_NOTE =
  'Context was compacted: if a detail is missing, run `recall search "<terms>"` before asking; reload the deferred tools Monitor, SendMessage and TaskStop in ONE ToolSearch call (`select:Monitor,SendMessage,TaskStop`), plus any other you used.';

/**
 * Count this compaction and build the lines for the model.
 * @param {string} dir - state directory.
 * @param {string | undefined} sessionId - safe session id; without one only the base line is returned.
 * @param {string | undefined} transcriptPath - `transcript_path` from the hook input; searched for the status file the session wrote.
 * @returns {Promise<string>} the lines to append after the playbook.
 */
export async function compactNotes(dir, sessionId, transcriptPath) {
  const statusPath = await findStatusPath(transcriptPath);
  let count = 1;
  if (sessionId) {
    const file = join(dir, `${sessionId}.compacts`);
    try {
      count = (Number.parseInt(await readFile(file, 'utf8'), 10) || 0) + 1;
    } catch (error) {
      if (error.code !== 'ENOENT') process.stderr.write(`mode hook: cannot read compaction count: ${error.message}\n`);
    }
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(file, `${count}\n`);
    } catch (error) {
      process.stderr.write(`mode hook: cannot save compaction count: ${error.message}\n`);
    }
  }
  const lines = [COMPACT_NOTE];
  if (statusPath) lines.push(`Re-read ${statusPath} (first ${STATUS_REREAD_LINES} lines) before continuing: it holds the plan and progress.`);
  if (count >= REPEATED_COMPACTIONS) lines.push(`This session has compacted ${count} times: at the next natural seam, write a handoff (\`handoff\` skill) and suggest a fresh session to the user.`);
  return lines.join('\n');
}
