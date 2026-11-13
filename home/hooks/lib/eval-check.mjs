// `eval` hides the command it runs when its text comes from a variable or a substitution.
// Exports: checkEval(args, nextWords, reasonsOf) -> string[] reasons.
// A literal `eval rm -rf /x` is checked as if it were written out (the words joined by spaces, as eval does). `eval "$VAR"` or
// `eval "$(cat file)"` cannot be decoded, so it asks. The usual tool-init idiom stays silent: `eval "$(ssh-agent -s)"`,
// `eval "$(fnm env)"`, `eval "$(direnv hook bash)"`, ... (INIT_TOOLS); the command inside `$(...)` is still checked as a nested body.
// Pure, no I/O. Invariant: false positives cost the owner a dialog, so the init-tool list errs on the side of silence.
import { commandName } from './command-of.mjs';

const INIT_TOOLS = new Set(['ssh-agent', 'gpg-agent', 'fnm', 'nvm', 'volta', 'direnv', 'pyenv', 'rbenv', 'jenv', 'nodenv', 'goenv', 'brew', 'starship', 'zoxide',
  'conda', 'mamba', 'micromamba', 'mise', 'rtx', 'asdf', 'minikube', 'docker-machine', 'opam', 'thefuck', 'pipenv', 'poetry', 'register-python-argcomplete',
  'gh', 'kubectl', 'helm', 'oh-my-posh', 'atuin', 'fzf', 'dircolors', 'lesspipe', 'lesspipe.sh', 'op', 'pnpm', 'npm']);
const WHOLE_SUBSTITUTION = /^(?:\$\(\s*([^\s)]+)[^)]*\)|`\s*([^\s`]+)[^`]*`)$/;
const HIDES_COMMAND = /[$`]/;
const HIDDEN_REASON = 'eval of a variable or substitution hides the command that runs; write the command out';

/** True for a word that is exactly one `$(tool ...)` / backtick substitution of a known tool-init command. */
const isInitSubstitution = (word) => {
  const match = WHOLE_SUBSTITUTION.exec(word);
  return match !== null && INIT_TOOLS.has(commandName(match[1] ?? match[2]));
};

/**
 * @param {string[]} args words after `eval`
 * @param {string[]} nextWords the following segment (the body of an unquoted `$(`, which the tokenizer splits off)
 * @param {(text: string) => string[]} reasonsOf the guard's check of a command text
 * @returns {string[]} ask reasons (empty for a harmless eval)
 */
export function checkEval(args, nextWords, reasonsOf) {
  const hidden = args.some((word) => {
    if (word === '$') return !INIT_TOOLS.has(commandName(nextWords[0] ?? ''));
    return HIDES_COMMAND.test(word) && !isInitSubstitution(word);
  });
  if (hidden) return [HIDDEN_REASON];
  // an init substitution is a nested body (or the next segment) and is checked there; only the literal words are re-checked here
  const literal = args.filter((word) => word !== '$' && !isInitSubstitution(word));
  return literal.length === 0 ? [] : reasonsOf(literal.join(' '));
}
