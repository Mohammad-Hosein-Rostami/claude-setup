// SessionStart (every source: startup, resume, clear, compact): prints the lead text `~/.claude/lead.md` to the main session as its own
// hook string. Why a hook of its own: Claude Code caps each hook's plain stdout at 10,000 characters per string, also when several hooks
// run for one event (hooks docs, "capped at 10,000 characters"), and the string of mode.mjs is at its cap; this string has its own room.
// Exports: leadText(input, file) -> Promise<string>.
// Invariants: prints nothing inside a subagent (`agent_id` is a non-empty string), for another event or for input that is not hook JSON;
// a missing lead.md prints nothing, any other read error goes to stderr; never blocks a session (always exit 0).
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const LEAD_FILE = join(homedir(), '.claude', 'lead.md');
const HTML_COMMENT = /<!--[\s\S]*?-->\n?/g; // notes for editors, not for the lead

/**
 * The lead text for one hook input.
 * @param {unknown} input - the parsed hook input.
 * @param {string} [file] - the lead text file (tests pass another one).
 * @returns {Promise<string>} the text without its editor comments, or '' for a subagent, another event or a missing file.
 */
export async function leadText(input, file = LEAD_FILE) {
  if (input?.hook_event_name !== 'SessionStart') return '';
  if (typeof input.agent_id === 'string' && input.agent_id !== '') return '';
  try {
    return (await readFile(file, 'utf8')).replace(HTML_COMMENT, '').trim();
  } catch (error) {
    if (error.code !== 'ENOENT') process.stderr.write(`lead-text hook: cannot read ${file}: ${error.message}\n`);
    return '';
  }
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return; // not hook JSON: stay silent, never block
  }
  const text = await leadText(input);
  if (text) console.log(text);
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`lead-text hook: ${error.message}\n`);
  }
}
