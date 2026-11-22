// Size test for the lead text home/lead.md as home/hooks/lead-text.mjs prints it (HTML comments removed).
// Why: Claude Code caps a hook's plain stdout at 10,000 characters per string (hooks reference, "capped at 10,000 characters");
// over the cap the lead gets a file path and a short preview instead of the rules. The test keeps 500 characters of headroom.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LEAD_TEXT = fileURLToPath(new URL('../home/lead.md', import.meta.url));
const HOOK_CAP_CHARS = 10_000;
const HEADROOM_CHARS = 500; // room for a longer line later without crossing the hook cap
const HTML_COMMENT = /<!--[\s\S]*?-->\n?/g; // the same pattern lead-text.mjs strips

test('the printed lead text stays within the hook cap with headroom', () => {
  const printed = readFileSync(LEAD_TEXT, 'utf8').replace(HTML_COMMENT, '').trim();
  assert.ok(printed.length <= HOOK_CAP_CHARS - HEADROOM_CHARS, `lead.md prints ${printed.length} characters; the limit is ${HOOK_CAP_CHARS - HEADROOM_CHARS}`);
});
