// Git's own options, the ones before the subcommand (`git -C dir -c k=v --no-pager push`), read the way git reads them.
// Exports: parseGitArgs(args) -> {options, subcommands}. Used by lib/command-checks.mjs (push, --no-verify, core.hooksPath, alias.*),
// lib/merge-commit.mjs (C37 advice) and lib/remote.mjs (git on a production host), so all three read the same options.
// The lists follow git 2.54 (`git help git`, and its git.c, which also takes `--shallow-file <file>`), plus `--super-prefix` of older
// gits. Git stops with "unknown option" at any other option word, but a later git may add one that takes a value (as it added
// `--config-env` and `--attr-source`), and that value would then pose as the subcommand. So an option word not listed here is read both
// ways, as a flag and as taking the next word, and every reading is returned: the caller lets the most dangerous one decide. `-h`,
// `--help`, `-v` and `--version` make git run help or version; they are read as flags, so the word after them is still checked.
// Pure, no I/O. Each word is read at most once as the start of an option or of the subcommand.

// options that take no value; --exec-path, --html-path, --man-path and --info-path print a path and exit
const FLAG_OPTIONS = new Set([
  '-p', '--paginate', '-P', '--no-pager', '--bare', '--no-replace-objects', '--no-lazy-fetch', '--no-optional-locks', '--no-advice',
  '--literal-pathspecs', '--no-literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs',
  '--exec-path', '--html-path', '--man-path', '--info-path', '-h', '--help', '-v', '--version',
]);
// options whose value is the next word (`-C <path>`, `--config-env <name>=<envvar>`)
const VALUE_OPTIONS = new Set([
  '-C', '-c', '--config-env', '--git-dir', '--work-tree', '--namespace', '--attr-source', '--shallow-file', '--super-prefix',
]);
// options that also take their value in the same word (`--git-dir=<path>`); --list-cmds only this way
const ATTACHED_OPTIONS = new Set([
  '--config-env', '--git-dir', '--work-tree', '--namespace', '--attr-source', '--exec-path', '--list-cmds', '--super-prefix',
]);

/** @returns {'flag' | 'value' | 'unknown'} how git reads one option word: alone, with the next word, or (not listed) either way */
function optionKind(word) {
  if (FLAG_OPTIONS.has(word)) return 'flag';
  if (VALUE_OPTIONS.has(word)) return 'value';
  return word.includes('=') && ATTACHED_OPTIONS.has(word.slice(0, word.indexOf('='))) ? 'flag' : 'unknown';
}

/**
 * Every way git may read the words after `git`: its option words with their values, and where the subcommand starts.
 * @param {string[]} args words after `git`
 * @returns {{options: (string | undefined)[][], subcommands: {sub: string | undefined, rest: string[]}[]}} options: each option word,
 *   with its value when it takes one (`['-c', 'k=v']`, `['--no-pager']`), from every reading; subcommands: each possible subcommand with
 *   the words after it (sub undefined when only options are given). With no unknown option there is exactly one subcommand; the
 *   reading that takes an unknown option as a flag comes first.
 */
export function parseGitArgs(args) {
  const options = [];
  const subcommands = [];
  const visited = new Set();
  const starts = [0]; // where an option or the subcommand may start; each start is read once
  while (starts.length > 0) {
    const at = Math.min(starts.pop(), args.length);
    if (visited.has(at)) continue;
    visited.add(at);
    const word = args[at];
    if (word === undefined || !word.startsWith('-')) {
      subcommands.push({ sub: word, rest: args.slice(at + 1) });
      continue;
    }
    const kind = optionKind(word);
    if (kind !== 'flag') {
      options.push([word, args[at + 1]]);
      starts.push(at + 2);
    }
    if (kind !== 'value') {
      options.push([word]);
      starts.push(at + 1); // pushed last, so the flag reading is read first
    }
  }
  return { options, subcommands };
}
