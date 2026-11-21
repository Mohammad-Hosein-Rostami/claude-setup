// The owner's own words in a prompt, and the text the owner pasted. Exports: ownerWords(prompt) -> string, pastedText(prompt) -> string.
// Invariants: pure (no I/O); never throws for a string. A block other sessions, the harness or a paste put in the prompt
// (cross-session messages, task notifications, system reminders, `<pasted_content>` logs) is cut out, and a prompt that is
// a compaction summary (the continuation message or the summary request) has no owner words at all, so keyword hooks
// (skill-router, big-context) never match inside pasted logs or summaries. pastedText gives only the `<pasted_content>` blocks
// (never another wrapped block, never a compaction prompt), so the skill router can still see a Figma link inside a large paste.

// A block runs to its own closing tag, or to the end when unclosed. Claude Code (2.1.325) opens a paste with `<pasted_content id="x">` and
// closes it with `</pasted_content id="x">`: when the opener has an id first, only a closer with that same id ends the block; else `</name>`.
const WRAPPED_BLOCK = /<(cross-session-message|task-notification|system-reminder|pasted_content)(\s+id="[^"<>\n]{1,64}")?(?=[\s>])[^>]*>[\s\S]*?(?:<\/\1\2\s*>|$)/gi;
const COMPACTION_PROMPT = /^\s*(?:This session is being continued from a previous conversation|Your task is to create a detailed summary of the conversation)/i;
const PASTED_BLOCK = 'pasted_content';

/**
 * @param {string} prompt - the submitted prompt text.
 * @returns {string} the prompt without wrapped blocks (each replaced by a space), or '' for a compaction prompt.
 */
export function ownerWords(prompt) {
  return COMPACTION_PROMPT.test(prompt) ? '' : prompt.replace(WRAPPED_BLOCK, ' ');
}

/**
 * The text of the prompt's `<pasted_content>` blocks, cut by the same rule as ownerWords (a block ends at its own closing tag).
 * @param {string} prompt - the submitted prompt text.
 * @returns {string} the pasted blocks joined by newlines; '' when there is none and for a compaction prompt.
 */
export function pastedText(prompt) {
  if (COMPACTION_PROMPT.test(prompt)) return '';
  return [...prompt.matchAll(WRAPPED_BLOCK)].filter((match) => match[1].toLowerCase() === PASTED_BLOCK).map((match) => match[0]).join('\n');
}
