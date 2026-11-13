// Compaction notes for the mode hook's SessionStart (source `compact`). Exports: compactNotes(dir, sessionId).
// Invariants: the count lives in `<dir>/<sessionId>.compacts` (pruned with the mode state files); a failed read or
// write counts as the first compaction and reports to stderr; never throws.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const REPEATED_COMPACTIONS = 3; // from this many compactions on, suggest a handoff and a fresh session
const COMPACT_NOTE =
  'Context was compacted: if a detail is missing, run `recall search "<terms>"` before asking; reload any deferred tools you need in ONE ToolSearch call (e.g. select:Monitor,SendMessage,TaskStop).';

/**
 * Count this compaction and build the lines for the model.
 * @param {string} dir - state directory.
 * @param {string | undefined} sessionId - safe session id; without one only the base line is returned.
 * @returns {Promise<string>} the lines to append after the playbook.
 */
export async function compactNotes(dir, sessionId) {
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
  if (count >= REPEATED_COMPACTIONS) lines.push(`This session has compacted ${count} times: at the next natural seam, write a handoff (\`handoff\` skill) and suggest a fresh session to the user.`);
  return lines.join('\n');
}
