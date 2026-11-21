// Stop: blocks once when the lead's final reply is over the size cap the owner's last prompt named
// ("final reply max 25 lines", "report <= 250 words"). Rewriting once is cheaper than a reply the owner cannot skim.
// Exports: replyCapReason(input, entries).
// Invariants: stop_hook_active true always allows (never block twice in a row); only the last real user prompt is read
// (a cap from an older prompt is not assumed); no cap named or no reply text means allow; any internal error is one
// stderr line and exit 0; output is fixed text plus numbers. Parsing shares hooks/lib/reply-cap.mjs and the transcript
// reader of ask-gate.mjs.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { lastAssistantText, lastRealPromptIndex, parseTranscript, promptText, readTranscriptTail } from './ask-gate.mjs';
import { overCap, parseCap } from './lib/reply-cap.mjs';
import { countedGate } from './lib/stop-block-count.mjs';

/**
 * Why the final reply must be rewritten, or null.
 * @param {{stop_hook_active?: boolean, last_assistant_message?: string}} input Stop hook JSON
 * @param {object[]} entries parsed transcript (may be empty)
 * @returns {string | null} the block reason when the reply is over the cap
 */
export function replyCapReason(input, entries) {
  if (input?.stop_hook_active === true) return null;
  const promptIndex = lastRealPromptIndex(entries);
  const cap = promptIndex < 0 ? null : parseCap(promptText(entries[promptIndex]));
  if (!cap) return null;
  const message = typeof input?.last_assistant_message === 'string' && input.last_assistant_message
    ? input.last_assistant_message
    : lastAssistantText(entries);
  const { over, size } = overCap(message, cap);
  if (!over) return null;
  const noTables = cap.unit === 'lines' ? ' No tables when the cap is in lines.' : '';
  return `Your final reply is ${size} ${cap.unit}; the owner's cap is ${cap.limit} ${cap.unit}. Send it again within the cap: verdict first, detail in a file with its path.${noTables}`;
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  await countedGate('final-reply-cap', input, () => { // lib/stop-block-count.mjs: the cap record
    let entries = [];
    if (typeof input?.transcript_path === 'string' && input.transcript_path) entries = parseTranscript(readTranscriptTail(input.transcript_path));
    const reason = replyCapReason(input, entries);
    if (reason) process.stdout.write(`${JSON.stringify({ decision: 'block', reason })}\n`);
    return reason !== null;
  });
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch (err) {
    process.stderr.write(`final-reply-cap: ${err.message}\n`); // never trap a session
  }
}
