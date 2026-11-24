// Rules for commands whose real command is hidden from the guard: it runs from a variable, from stdin, or from one string.
// Exports: shellHazards({seg, raw, parsed, shellScript, line}) -> string[] ask reasons; IFS_SPLIT_REASON; IFS_EXPANSION_REASON; VARIABLE_COMMAND_REASON, SPLIT_VARIABLE_REASON (the two
// variable-command reasons, which lib/bounce-once.mjs sends back once for a rewrite); CONVENTIONAL_COMMAND_VARS (the names that
// conventionally hold an editor, pager or compiler; lib/git-runs.mjs reads them too); commandReadings(words, splitWords) -> the ways the
// shell may read one command's words. Pure, no I/O.
// - the command word is a variable, `"$@"` or `$(...)` (`$X`, `X="git push"; $X`): the guard cannot see what runs. Names that conventionally
//   hold an editor, pager or compiler (`$EDITOR file`) are fine, and so is a variable assigned earlier in the line to one plain word. The
//   first word of an array's element list (`files+=("$f")`, a segment marked `.arrayList`) is data, not a command word, and so is the
//   first word of an arithmetic body (`echo $(( N + 1 ))`): bash computes it, never runs it, on a line whose every `((` is arithmetic as
//   bash reads it (lib/runtime-values.mjs: `( ($X) )`, `$(($X) )` and `\(` escapes still ask). Arithmetic on text read at run time asks
//   there (ARITHMETIC_REASON), with its own reason; a `$(...)` inside it is a segment of its own, judged as a command.
// - a word after the command word filled in at run time (`read X; git $X`, `git "$@"`, `git "${A[@]}"`) in a command a rule reads
//   (RUNTIME_VALUE_REASON, lib/runtime-values.mjs).
// - a value with blanks filled in for an unquoted `$X` (`X="push --force"; git $X`) is one word to zsh and several to bash:
//   commandReadings gives both readings, and the guard judges each one with every rule (an rm reads both itself: lib/rm-paths.mjs).
// - a shell reads its commands from stdin: `curl x | bash`, `bash <<EOF`, `bash < file`, `sh -s`; an interpreter (python, node, perl,
//   ruby, deno, bun, php) reads its code from a pipe or a file: `base64 -d | python3`, `node < x.js` (from a heredoc its code is judged).
// - a variable inside the command word (`git$IFS'push'`, `git${IFS}push`), and `$IFS` anywhere in the line (IFS_EXPANSION_REASON).
// - `env -S "cmd"` and `su -c "cmd"` take the command as ONE string.
// - a brace word the guard cannot list (`{-c,"$X"}`, more than 64 words; lib/braces.mjs) at or before the command word, or in a command
//   whose words a rule reads (UNLISTED_BRACES_REASON); `echo {$a,b}` stays quiet.
// - a line that names IFS (`IFS=,`, `read IFS`, `export IFS=...`) and an unquoted expansion (`$F`, `$(...)`) in a command whose words a
//   rule reads (IFS_SPLIT_REASON): bash splits the value at the new IFS characters, so `IFS=,; F=-rf,/x; rm $F` is `rm -rf /x`, which the
//   guard, splitting at blanks only, would read as one option word (N5).
// A false positive only costs a dialog, so each rule is as narrow as the bypass it closes.
import { asGitSubcommand, commandName, commandOf } from './command-of.mjs';
import { SCAN_STOP, SCAN_VERBS } from './dangerous-scan.mjs';
import { bashReadings } from './rm-paths.mjs';
import { INLINE_COMMAND_REASON, INTERPRETERS, buildsCommand, interpreterCode } from './inline-code.mjs';
import { RUNTIME_VALUE_REASON, everyDoubleParenIsArithmetic, readsRuntimeValue } from './runtime-values.mjs';

const SHELLS = new Set(['bash', 'sh', 'zsh', 'ksh', 'dash']);
// `$X`, `${X}`, `${X:-default}`, `$@`, `${A[@]}`, or a bare `$` (the start of `$(...)` in a command position)
const VARIABLE_WORD = /^\$(?:\{(\w+|[@*])[^}]*\}|(\w+|[@*]))?$/;
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
  // a variable inside the name (`git$IFS'push'`, `git${IFS}push`, `tool-$V`): the shell fills it in, so the name the rules read is not what runs
  if (!variable && (raw.cmd ?? '').includes('$') && !resolved) return VARIABLE_COMMAND_REASON;
  if (/\s/.test(parsed.cmd ?? '')) return SPLIT_VARIABLE_REASON;
  return undefined;
}

/** A positional word that is not the target of a redirect (`bash < file` has no script; `bash run.sh <<EOF` does, and the heredoc is its input). */
function hasScriptFile(args) {
  return args.some((a, i) => !a.startsWith('-') && !STDIN_REDIRECT.test(a) && !STDIN_PATH.test(a) && !(i > 0 && /^\d*<<?<?$/.test(args[i - 1])));
}
// a "script file" that is stdin itself: `curl x | bash /dev/stdin`, `cat x | python3 /dev/fd/0`
const STDIN_PATH = /^\/(?:dev\/stdin|dev\/fd\/0|proc\/self\/fd\/0)$/;

// interpreter options whose value is the next word, so it is not taken for a script file (`node -r dotenv/config`, `python3 -W ignore`)
const INTERPRETER_VALUE_OPTIONS = new Set(['-W', '-X', '-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '-I', '-M']);
const DENO_RUN = 'run'; // deno's subcommand before the script word
const PYTHON_MODULE = '-m'; // `python3 -m pytest`: runs a module, reads no code from stdin
const HEREDOC_OR_STRING = /^\d*<<(?!\()/; // `<<EOF`, `<<-EOF`, `<<<text`: the code is in the command text itself

/** True when the interpreter is given a script file or a module: a positional word that is no option value, `-` or redirect target. */
function hasInterpreterScript(args) {
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word === PYTHON_MODULE) return true;
    if (INTERPRETER_VALUE_OPTIONS.has(word) || /^\d*<<?<?$/.test(word)) i++;
    else if (word !== '-' && !word.startsWith('-') && !STDIN_REDIRECT.test(word) && !STDIN_PATH.test(word)) return true;
  }
  return false;
}

/**
 * `curl x | python3`, `base64 -d | node`, `node < x.js`, `perl -`: an interpreter reads its code from a pipe or a file, so the guard
 * cannot see it (like `| sh`). From a heredoc or here-string (`python3 - <<'EOF'`) the code is in the command text: it is judged like
 * `-c` code (lib/inline-code.mjs buildsCommand on the line's text), so the common inline script runs unasked.
 */
function interpreterFromStdin(seg, parsed, line) {
  const { cmd, args: written } = parsed;
  const args = cmd?.startsWith('deno') && written[0] === DENO_RUN ? written.slice(1) : written; // `deno run -` reads stdin too
  if (!INTERPRETERS.test(cmd ?? '') || interpreterCode(cmd, args) !== undefined || hasInterpreterScript(args)) return undefined;
  if (args.some((word) => HEREDOC_OR_STRING.test(word)) && seg.piped !== true) return buildsCommand(line) ? INLINE_COMMAND_REASON : undefined;
  const fed = seg.piped === true || args.some((word) => STDIN_REDIRECT.test(word));
  return fed ? `${cmd} reads its code from stdin (a pipe or a file), so what runs is hidden; write the code out or run a script file` : undefined;
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
 * @param {{seg: string[], raw: {cmd?: string, at: number}, parsed: {cmd?: string, args: string[]}, shellScript: (args: string[]) => string | undefined,
 *   line?: string}} input seg: the segment's words as written (`.piped` when a `|` fed it); raw: commandOf(seg); parsed: commandOf of the words
 *   after variable substitution; line: the command text the segment came from
 * @returns {string[]} ask reasons
 */
export function shellHazards({ seg, raw, parsed, shellScript, line = '' }) {
  const data = seg.arrayList === true || isArithmeticBody(seg, line); // `files+=("$f")`: its elements are words; `$((..))` computes a number
  const commandWord = data ? undefined : hiddenCommandWord(raw, parsed);
  return [commandWord, shellFromStdin(seg, parsed, shellScript), interpreterFromStdin(seg, parsed, line), oneStringCommand(seg, raw, parsed),
    unlistedBraces(seg, raw, parsed), ifsSplit(seg, raw, parsed, line), ifsExpansion(line),
    data ? undefined : runtimeValueWord(seg, raw, parsed, line)].filter((reason) => reason !== undefined);
}

export const UNLISTED_BRACES_REASON = 'a brace expansion this guard cannot list (an alternative with $ or a backtick, too many words or '
  + 'nested too deep) in a command it checks; write the words out';
// the commands whose words a rule reads (flags, targets, options), beyond the verbs the position-independent scan tries
const RULE_COMMANDS = new Set([...SCAN_VERBS, 'find', 'eval', 'su', 'env', 'xargs', 'parallel', 'security', 'alias', 'cp', 'mv', 'tee']);

/** True when a rule reads this command's words: a rule command, or a verb the position-independent scan tries among its words. */
const rulesRead = (seg, raw, parsed) => RULE_COMMANDS.has(parsed.cmd) || (!SCAN_STOP.has(parsed.cmd) && seg.some((word, i) => i > raw.at && SCAN_VERBS.has(commandName(word))));

/** A brace word the tokenizer could not list (`.unlistedBraces`) asks where it may hide what runs: at or before the command word, or in a command a rule reads. */
function unlistedBraces(seg, raw, parsed) {
  const at = seg.unlistedBraces ?? [];
  return at.length > 0 && (at.some((i) => i <= raw.at) || rulesRead(seg, raw, parsed)) ? UNLISTED_BRACES_REASON : undefined;
}

export const IFS_SPLIT_REASON = 'command too complex to check: an unquoted variable or substitution on a line that changes IFS, so the guard cannot '
  + 'tell how the shell splits it into options and targets; quote it, or write the words out';
const NAMES_IFS = /\bIFS\b/; // any mention: an assignment can take many forms (`IFS=`, `read IFS`, `printf -v IFS`, `${IFS:=,}`)
const SUBSTITUTION_WORD = '$'; // what an unquoted `$(...)` or backtick leaves in the segment (lib/shell-words.mjs)

/** An unquoted expansion (`.bareWords`, or an unquoted `$(...)`) in a command a rule reads, on a line that names IFS (N5). */
function ifsSplit(seg, raw, parsed, line) {
  if (!NAMES_IFS.test(line)) return undefined;
  const expands = (seg.bareWords?.size ?? 0) > 0 || seg.includes(SUBSTITUTION_WORD);
  return expands && rulesRead(seg, raw, parsed) ? IFS_SPLIT_REASON : undefined;
}

export const IFS_EXPANSION_REASON = 'the line expands $IFS, which can join words into a command the guard reads as one word '
  + "(`git$IFS'push'` is git and push); write the words out with spaces";
const IFS_EXPANSION = /\$\{?IFS\b/; // `$IFS`, `${IFS}`, `${IFS:0:1}`, anywhere in the text: rarely needed, and an easy way to hide a word break

/** `$IFS` anywhere in the line: a separator filled in at run time hides where one word ends (audit H1). */
const ifsExpansion = (line) => (IFS_EXPANSION.test(line) ? IFS_EXPANSION_REASON : undefined);

const RM = 'rm'; // the one command that judges both readings of its words itself
const ARITHMETIC_JOIN = '((';// the operators in front of the first word of a `$((..))` or `((..))` body (lib/shell-words.mjs `.joinedBy`)

/** True when the segment is an arithmetic body (`$(( $X - 1 ))`, `(( $N > 2 ))`) of a line bash reads that way (lib/runtime-values.mjs). */
const isArithmeticBody = (seg, line) => (seg.joinedBy ?? '').endsWith(ARITHMETIC_JOIN) && everyDoubleParenIsArithmetic(line);

/** A word after the command word filled in at run time (`read X; git $X`, `git "$@"`, `git "${A[@]}"`) in a command a rule reads. */
function runtimeValueWord(seg, raw, parsed, line) {
  if (!rulesRead(seg, raw, parsed)) return undefined;
  const after = raw.at + 1;
  const unquoted = new Set([...(seg.bareWords ?? [])].filter((at) => at >= after).map((at) => at - after)); // `$NAME` outside quotes
  return readsRuntimeValue(seg.slice(after), line, unquoted) ? RUNTIME_VALUE_REASON : undefined;
}

/**
 * The ways the shell may read one command's words, each with its command: as filled in (zsh keeps an unquoted `$X` as one word), then,
 * when a value with blanks was filled in for an unquoted `$X`, as bash splits it (`X="push --force"; git $X` is `git push --force`).
 * Every rule judges each reading, so a command hidden in a variable's value asks whichever shell runs the line. An rm gets one reading:
 * checkRm already judges both itself (lib/rm-paths.mjs bashReadings), on the line's one work budget, which a second reading would spend twice.
 * @param {string[]} words the segment's words after lib/rm-paths.mjs substituteKnownWords
 * @param {Set<string>} splitWords the words substituteKnownWords filled in for an unquoted `$X` with a value that holds blanks
 * @returns {{words: string[], parsed: ReturnType<typeof asGitSubcommand>}[]} one reading, or two when bash splits a word
 */
export function commandReadings(words, splitWords) {
  const reading = (list) => ({ words: list, parsed: asGitSubcommand(commandOf(list)) });
  const asFilledIn = reading(words);
  if (asFilledIn.parsed.cmd === RM || !words.some((word) => splitWords.has(word))) return [asFilledIn];
  const pieces = (word) => bashReadings(word, splitWords).slice(splitWords.has(word) ? 1 : 0); // bashReadings: the word, then its pieces
  return [asFilledIn, reading(words.flatMap(pieces))];
}
