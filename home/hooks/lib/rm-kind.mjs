// Is an `rm` recursive, as far as its option words can be read? Read by lib/rm-paths.mjs (checkRm) and, through RECURSIVE_FLAG, by the other deleters.
// Exports: RECURSIVE_FLAG; UNREAD_OPTIONS_RM; rmKind(args, bare) -> reason name | undefined.
// An rm whose options the guard cannot read counts as recursive: `-$X`, `"$@"`, `"${a[@]}"`, or one variable where the options stand
// (`rm $F ~`, and `rm $F` alone when `$F` is unquoted: bash splits its value into options and targets, N5).
// Invariants: pure, no I/O.
import { flagsOf } from './shell-words.mjs';

const prefixesOf = (word) => Array.from(word, (_, index) => word.slice(0, index + 1));
/**
 * An rm option that deletes recursively: `-r`, `-R`, a cluster holding one (`-rf`, `-fR`), `--recursive`, or a prefix of it (`--rec`, `--r`):
 * GNU rm (Linux, Git Bash) takes any unambiguous prefix of a long option, and no other long option of rm starts with r. A prefix of
 * `--no-preserve-root` counts too (no other starts with n): it is only written for a recursive delete.
 */
export const RECURSIVE_FLAG = new RegExp(`^--(?:${[...prefixesOf('recursive'), ...prefixesOf('no-preserve-root')].join('|')})$|^-[a-zA-Z]*[rR]`);

const EXPANSION = /[$`]/;
const MANY_WORDS = /\$[@*]|\[[@*]\]\}/; // `"$@"`, `$*`, `"${a[@]}"`: any number of words, options among them
const WHOLE_EXPANSION = /^\$(?:\w+|\{[^}]*\})$/; // a word that is one variable and nothing else
export const UNREAD_OPTIONS_RM = 'rm that may be recursive (an expansion can hold its options)'; // how a reason names an rm that is not `-r` as written

/**
 * How a reason names the rm, undefined when it is not judged: `rm -r` when it deletes recursively as written; UNREAD_OPTIONS_RM when it may
 * once the shell has filled in its words: an option word with an expansion in it (`-$X`, `-${X:-r}f`), a word that stands for any number of words
 * (`"$@"`, `"${a[@]}"`), or one variable where the options stand: with more words after it (`rm $F ~` with F=-rf), or alone when it is written
 * unquoted (`rm $F`, F holding `-rf /`). A quoted `"$F"` alone is one word, so it is a target and not judged here.
 * @param {string[]} args the rm's words, those of an unquoted variable's value already split at blanks
 * @param {Set<string>} bare the words of this command with a `$NAME` outside quotes (`.bareWords` of the segment)
 */
export function rmKind(args, bare) {
  if (flagsOf(args).some((flag) => RECURSIVE_FLAG.test(flag))) return 'rm -r';
  const first = args.findIndex((word) => !word.startsWith('-'));
  const optionsEnded = args.slice(0, first).includes('--'); // `rm -- $F ~`: no word after `--` is an option
  const optionHolder = first !== -1 && !optionsEnded && WHOLE_EXPANSION.test(args[first]) && (first < args.length - 1 || bare.has(args[first]));
  const unread = flagsOf(args).some((flag) => EXPANSION.test(flag)) || args.some((word) => MANY_WORDS.test(word)) || optionHolder;
  return unread ? UNREAD_OPTIONS_RM : undefined;
}
