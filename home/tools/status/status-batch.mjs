// Several rows in one `status.mjs add|start|done` call: row edits cost about 250 extra lead turns in 14 days (spec-p5
// `r9-status-cli`). Groups are split by a lone `+` word; `start` also takes plain ids (`start a1 a2 a3`).
// Exports: rowGroups(command, words) -> string[][]; runGroups(groups, editOne) -> outcome; BATCH_COMMANDS, GROUP_SEPARATOR.
// Forms: `add a1 "item one" S + a2 "item two" M`, `start a1 a2`, `done a1 "evidence one" + a2 "evidence two"`.
// Invariants: all or nothing: the groups edit one in-memory copy of the lines and the first refusal or usage error stops the call
// before anything is written (the caller writes only an outcome without error); notes of every group are kept, in order.

export const BATCH_COMMANDS = ['add', 'start', 'done'];
export const GROUP_SEPARATOR = '+';

/**
 * @param {string} command the status command
 * @param {string[]} words its arguments
 * @returns {string[][]} one argument list per row (one list, the words as given, for any other command or a single row)
 */
export function rowGroups(command, words) {
  if (!BATCH_COMMANDS.includes(command)) return [words];
  if (command === 'start' && !words.includes(GROUP_SEPARATOR)) return words.length > 1 ? words.map((id) => [id]) : [words];
  const groups = [[]];
  for (const word of words) {
    if (word === GROUP_SEPARATOR) groups.push([]);
    else groups.at(-1).push(word);
  }
  return groups;
}

/**
 * Runs one edit per group on the same lines.
 * @param {string[][]} groups from rowGroups
 * @param {(words: string[]) => { usage?: string, error?: string, note?: string, skip?: string }} editOne one row's edit
 * @returns {{ usage?: string, error?: string, note?: string, skip?: string }} the first failure (named by its group when there are
 *   several), else the notes joined
 */
export function runGroups(groups, editOne) {
  const notes = [];
  for (const [index, words] of groups.entries()) {
    if (groups.length > 1 && words.length === 0) return { usage: `row ${index + 1} of ${groups.length} is empty (a "+" with nothing after it)` };
    const outcome = editOne(words);
    const named = groups.length > 1 ? `row ${index + 1} of ${groups.length} (${words[0] ?? ''}): ` : '';
    if (outcome.usage) return { usage: `${named}${outcome.usage}` };
    if (outcome.error) return { error: `${named}${outcome.error}` };
    if (outcome.skip) return outcome;
    if (outcome.note) notes.push(outcome.note);
  }
  return notes.length === 0 ? {} : { note: notes.join('; ') };
}
