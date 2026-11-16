// The owner's own words in a prompt. Exports: ownerWords(prompt) -> string.
// Invariants: pure (no I/O); never throws for a string. A block other sessions, the harness or a paste put in the prompt
// (cross-session messages, task notifications, system reminders, `<pasted_content>` logs) is cut out, and a prompt that is
// a compaction summary (the continuation message or the summary request) has no owner words at all, so keyword hooks
// (skill-router, big-context) never match inside pasted logs or summaries.

// A block runs to its closing tag, or to the end when unclosed.
const WRAPPED_BLOCK = /<(cross-session-message|task-notification|system-reminder|pasted_content)\b[\s\S]*?(?:<\/\1>|$)/gi;
const COMPACTION_PROMPT = /^\s*(?:This session is being continued from a previous conversation|Your task is to create a detailed summary of the conversation)/i;

/**
 * @param {string} prompt - the submitted prompt text.
 * @returns {string} the prompt without wrapped blocks (each replaced by a space), or '' for a compaction prompt.
 */
export function ownerWords(prompt) {
  return COMPACTION_PROMPT.test(prompt) ? '' : prompt.replace(WRAPPED_BLOCK, ' ');
}
