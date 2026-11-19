// Compaction notes for the mode hook's SessionStart (source `compact`). Exports: compactNotes(dir, sessionId, transcriptPath).
// Invariants: the count lives in `<dir>/<sessionId>.compacts` (pruned with the mode state files); a failed read or
// write counts as the first compaction and reports to stderr; never throws. The STATUS path comes from the transcript (a tool
// input), so it is shown without control and format characters and at most STATUS_PATH_SHOWN_CHARS long, cut from the left: its end
// names the file, and the whole SessionStart output has to stay under Claude Code's 10,000-character hook output cap.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UNPRINTABLE } from './agent-brief.mjs';
import { findStatusPath } from './transcript.mjs';

const REPEATED_COMPACTIONS = 3; // from this many compactions on, suggest a handoff and a fresh session
const STATUS_REREAD_LINES = 60;
const STATUS_PATH_SHOWN_CHARS = 200; // String length (UTF-16 units), the unit the output cap is measured in
const CUT_MARK = '...';
const LEADING_LOW_SURROGATE = /^[\udc00-\udfff]/; // the second half of a pair the cut went through
const COMPACT_NOTE =
  'Context was compacted: missing detail? Run `recall "<terms>" --session current` (`--deep` on a miss) before asking. Re-read `## Standing rules`; backfill it with `recall --owner --session current`. Reload Monitor, SendMessage and TaskStop in ONE ToolSearch call (`select:Monitor,SendMessage,TaskStop`), plus any other used.';

/** The STATUS path as the note shows it: control and format characters removed, then cut from the left to STATUS_PATH_SHOWN_CHARS. */
function shownStatusPath(path) {
  const clean = path.replace(UNPRINTABLE, '');
  if (clean.length <= STATUS_PATH_SHOWN_CHARS) return clean;
  return `${CUT_MARK}${clean.slice(-(STATUS_PATH_SHOWN_CHARS - CUT_MARK.length)).replace(LEADING_LOW_SURROGATE, '')}`;
}

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
  if (statusPath) lines.push(`Re-read ${shownStatusPath(statusPath)} (first ${STATUS_REREAD_LINES} lines) before continuing: it holds the plan and progress.`);
  if (count >= REPEATED_COMPACTIONS) lines.push(`This session has compacted ${count} times: at the next natural seam, write a handoff (\`handoff\` skill) and suggest a fresh session to the user.`);
  return lines.join('\n');
}
