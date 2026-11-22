// UserPromptExpansion(check): the owner's `/check <categories> [for <scope>]`, `/check off [<categories>]`, `/check default` and `/check`
// (show) turn categories on or off over their defaults (home/checks/categories.json), reset them, or print this session's switch (lib/checks-on.mjs). The event fires only when a person types the command (hooks docs, UserPromptExpansion: "when
// a user-typed command expands into a prompt"), and the skill sets `disable-model-invocation: true`, so an agent or a tool call
// cannot turn a category on; the Bash guard asks for any other write to ~/.claude/state/checks.
// Exports: switchText(input) -> string (the context line the skill relays).
// Invariants: never blocks the prompt; any error is one stderr line, exit 0, and the switch stays as it was.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { categories, clearChecks, offCategories, onCategories, parseCheckArgs, saveChecks, sessionIdOf } from './lib/checks-on.mjs';

const usage = () => `Usage: /check ${categories().join('|')}|all [for <scope>], /check off [<categories>], /check default, /check (show).`;
const listed = (names) => (names.length > 0 ? names.join(', ') : 'none');

/** The line shown for the current state of one session. */
function stateLine(sessionId) {
  return `Checks on: ${listed(onCategories(sessionId))}; off: ${listed(offCategories(sessionId))}.`;
}

/**
 * What the hook adds to the expanded `/check` prompt: the result of the owner's command, or '' for any other command.
 * @param {object} input the hook input (command_name, command_args, session_id)
 * @returns {string}
 */
export function switchText(input) {
  if (input?.hook_event_name !== 'UserPromptExpansion' || input.command_name !== 'check') return '';
  const sessionId = sessionIdOf(input);
  if (sessionId === undefined) return 'Checks NOT changed: no session id in the hook input. Tell the owner.';
  const choice = parseCheckArgs(input.command_args);
  if (choice.action === 'show') return stateLine(sessionId);
  if (choice.action === 'default') {
    clearChecks(sessionId);
    return `Checks back to their defaults for this session. ${stateLine(sessionId)}`;
  }
  if (choice.on.length + choice.off.length === 0) return `Checks NOT changed: no known category in "${String(input.command_args).slice(0, 80)}". ${usage()}`;
  saveChecks(sessionId, choice);
  const unknown = choice.unknown.length > 0 ? ` Ignored unknown words: ${choice.unknown.slice(0, 5).join(', ')}.` : '';
  return `Checks changed by the owner${choice.scope ? ` for ${choice.scope}` : ''}. ${stateLine(sessionId)}${unknown}`;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const text = switchText(JSON.parse(raw));
  if (text) console.log(text);
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => process.stderr.write(`checks-switch: ${error.message}\n`));
}
