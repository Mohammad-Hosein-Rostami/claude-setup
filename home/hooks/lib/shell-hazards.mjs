// Rules for commands whose real command is hidden from the guard: it runs from a variable, from stdin, or from one string.
// Exports: shellHazards({seg, raw, parsed, shellScript}) -> string[] ask reasons; VARIABLE_COMMAND_REASON, SPLIT_VARIABLE_REASON (the two
// variable-command reasons, which lib/bounce-once.mjs sends back once for a rewrite); CONVENTIONAL_COMMAND_VARS (the names that
// conventionally hold an editor, pager or compiler; lib/git-runs.mjs reads them too). Pure, no I/O.
// - the command word is a variable or `$(...)` (`$X`, `X="git push"; $X`): the guard cannot see what runs. Names that conventionally hold
//   an editor, pager or compiler (`$EDITOR file`) are fine, and so is a variable assigned earlier in the line to one plain word. The
//   first word of an array's element list (`files+=("$f")`, a segment marked `.arrayList`) is data, not a command word.
// - a shell reads its commands from stdin: `curl x | bash`, `bash <<EOF`, `bash < file`, `sh -s`.
// - `env -S "cmd"` and `su -c "cmd"` take the command as ONE string.
// - a brace word the guard cannot list (`{-c,"$X"}`, more than 64 words; lib/braces.mjs) at or before the command word, or in a command
//   whose words a rule reads (UNLISTED_BRACES_REASON); `echo {$a,b}` stays quiet.
// A false positive only costs a dialog, so each rule is as narrow as the bypass it closes.
import { commandName } from './command-of.mjs';
import { SCAN_STOP, SCAN_VERBS } from './dangerous-scan.mjs';

const SHELLS = new Set(['bash', 'sh', 'zsh', 'ksh', 'dash']);
const VARIABLE_WORD = /^\$(?:\{(\w+)[^}]*\}|(\w+))?$/; // `$X`, `${X}`, `${X:-default}`, or a bare `$` (the start of `$(...)` in a command position)
export const CONVENTIONAL_COMMAND_VARS = new Set(['EDITOR', 'VISUAL', 'PAGER', 'BROWSER', 'SHELL', 'CC', 'CXX', 'MAKE', 'GIT_EDITOR']);
const STDIN_REDIRECT = /^\d*<(?!\()/; // `<file`, `<<EOF`, `<<<text`
const STDIN_FLAG = /^-[a-zA-Z]*s[a-zA-Z]*$/;
const ENV_SPLIT_STRING = /^--split-string|^-[a-zA-Z]*S/;
const SU_COMMAND_FLAG = /^--command|^-[a-zA-Z]*c/;
export const VARIABLE_COMMAND_REASON = 'the command word is a variable or substitution, so what runs is hidden; write the command out';
export const SPLIT_VARIABLE_REASON = 'a variable holding several words is run as the command; write the command out';

function hiddenCommandWord(raw, parsed) {
  const variable = VARIABLE_WORD.exec(raw.cmd ?? '');
  const resolved = parsed.cmd !== raw.cmd && !/[\s$]/.test(parsed.cmd ?? '');
  const conventional = CONVENTIONAL_COMMAND_VARS.has(variable?.[1] ?? variable?.[2]);
  if (variable && !conventional && !resolved) return VARIABLE_COMMAND_REASON;
  if (/\s/.test(parsed.cmd ?? '')) return SPLIT_VARIABLE_REASON;
  return undefined;
}

/** A positional word that is not the target of a redirect (`bash < file` has no script; `bash run.sh <<EOF` does, and the heredoc is its input). */
function hasScriptFile(args) {
  return args.some((a, i) => !a.startsWith('-') && !STDIN_REDIRECT.test(a) && !(i > 0 && /^\d*<<?<?$/.test(args[i - 1])));
}

function shellFromStdin(seg, parsed, shellScript) {
  if (!SHELLS.has(parsed.cmd) || shellScript(parsed.args) !== undefined) return undefined;
  const scriptFile = hasScriptFile(parsed.args);
  const stdin = parsed.args.some((a) => STDIN_FLAG.test(a)) || (!scriptFile && (parsed.args.some((a) => STDIN_REDIRECT.test(a)) || seg.piped === true));
  return stdin ? `${parsed.cmd} reads its commands from stdin (pipe, heredoc, -s), so what runs is hidden; write the commands out or run a script file` : undefined;
}

function oneStringCommand(seg, raw, parsed) {
  const wrappers = seg.slice(0, raw.at);
  const envAt = wrappers.findIndex((w) => commandName(w) === 'env');
  if (envAt !== -1 && wrappers.slice(envAt + 1).some((w) => ENV_SPLIT_STRING.test(w))) return 'env -S runs a command given as one string; write the command out';
  if (parsed.cmd === 'su' && parsed.args.some((a) => SU_COMMAND_FLAG.test(a))) return 'su -c runs a command string as another user; confirm it';
  return undefined;
}

/**
 * @param {{seg: string[], raw: {cmd?: string, at: number}, parsed: {cmd?: string, args: string[]}, shellScript: (args: string[]) => string | undefined}} input
 *   seg: the segment's words as written (`.piped` when a `|` fed it); raw: commandOf(seg); parsed: commandOf of the words after variable substitution
 * @returns {string[]} ask reasons
 */
export function shellHazards({ seg, raw, parsed, shellScript }) {
  const commandWord = seg.arrayList === true ? undefined : hiddenCommandWord(raw, parsed); // `files+=("$f")`: its elements are words
  return [commandWord, shellFromStdin(seg, parsed, shellScript), oneStringCommand(seg, raw, parsed), unlistedBraces(seg, raw, parsed)]
    .filter((reason) => reason !== undefined);
}

export const UNLISTED_BRACES_REASON = 'a brace expansion this guard cannot list (an alternative with $ or a backtick, too many words or '
  + 'nested too deep) in a command it checks; write the words out';
// the commands whose words a rule reads (flags, targets, options), beyond the verbs the position-independent scan tries
const RULE_COMMANDS = new Set([...SCAN_VERBS, 'find', 'eval', 'su', 'env', 'xargs', 'parallel', 'security', 'alias', 'cp', 'mv', 'tee']);

/** A brace word the tokenizer could not list (`.unlistedBraces`) asks where it may hide what runs: at or before the command word, or in a command a rule reads. */
function unlistedBraces(seg, raw, parsed) {
  const at = seg.unlistedBraces ?? [];
  const rulesRead = RULE_COMMANDS.has(parsed.cmd) || (!SCAN_STOP.has(parsed.cmd) && seg.some((word, i) => i > raw.at && SCAN_VERBS.has(commandName(word))));
  return at.length > 0 && (at.some((i) => i <= raw.at) || rulesRead) ? UNLISTED_BRACES_REASON : undefined;
}
