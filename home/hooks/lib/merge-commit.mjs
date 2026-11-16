// C37 advice for the Bash guard: a `git merge` or `git pull` that can create a merge commit. A quality rule, not a safety rule, so its
// text is advice (lib/bounce-once.mjs: alone, the first send is denied with the fix and the identical retry runs without the owner;
// next to a reason that asks, it is only appended). Exports: MERGE_COMMIT_ADVICE (the text, classed exactly in lib/reason-classes.mjs)
// mergeCommitAdvice(command) -> [] | [MERGE_COMMIT_ADVICE], and withoutSubstitutions(text) (shared with lib/branch-move.mjs).
// Every simple command of the line is checked, through keywords, wrappers (sudo, env, command: lib/command-of.mjs) and git's own options
// (`git -C dir --no-pager merge x`; lib/git-options.mjs, where an option it does not know is read both ways and either reading that
// merges gives the advice). A merge inside `$(...)`, backticks or a heredoc body is not this line's merge: heredoc bodies are
// dropped and substitution bodies cut out before parsing. Flags match git's exact spelling, after the branch too, until `--`. Not looked
// into: alias bodies, `bash -c` and eval scripts, git config (`-c pull.rebase=true`). Pure, no I/O.
import { asGitSubcommand, commandOf } from './command-of.mjs';
import { parseGitArgs } from './git-options.mjs';
import { segments, stripHeredocs } from './shell-words.mjs';

export const MERGE_COMMIT_ADVICE = 'Linear history (C37): rebase the branch onto the base, then git merge --ff-only (for pull: git pull --rebase). '
  + "If this repository's own rules need a merge commit, send the same command again and it runs.";
// merge flags that make no merge commit: fast-forward only, squash, or ending a merge already in progress
const MERGE_WITHOUT_COMMIT = new Set(['--ff-only', '--abort', '--continue', '--quit', '--squash']);
// pull flags that rebase or only fast-forward; `--rebase=<mode>` rebases unless the mode is git's false (false, no, off, 0 or empty)
const PULL_WITHOUT_MERGE = new Set(['--rebase', '-r', '--ff-only']);
const REBASE_OFF = /^--rebase=(?:false|no|off|0)?$/i;
// merge and pull options whose value is the next word: in `git merge -m --ff-only x` the flag is the message
const VALUE_OPTIONS = new Set(['-m', '-F', '-s', '-X', '--file', '--strategy', '--strategy-option', '--into-name']);
// cheap first look: only text that spells merge or pull once quotes, backslashes and blanks are dropped (`git "mer"ge`) is parsed
const MAY_MERGE = /merge|pull/;
const SPELLING_BREAKS = /["'\\\s]/g;
const SUBSTITUTION_STAND_IN = '_';
const COMMENT_START = /[\s;&|()]/; // a `#` after one of these (or at the start) starts a comment

/** Index just past the backtick body that opens at `start` (a backslash escapes the next character); the text's end when it never closes. */
function backtickEnd(text, start) {
  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '`') return i + 1;
  }
  return text.length;
}

/** Index just past the `$(...)` whose `(` is at `open`: nested parens count, quoted ones do not; the text's end when it never closes. */
function parenEnd(text, open) {
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\\' && quote !== "'") i += 1;
    else if (quote !== '') quote = c === quote ? '' : quote;
    else if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/** Text with comments dropped and each `$(...)` or backtick body replaced by SUBSTITUTION_STAND_IN: a command there only fills in a word. */
export function withoutSubstitutions(text) {
  let out = '';
  let quote = ''; // `'` or `"` while the outer text is inside quotes
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\\' && quote !== "'") {
      out += text.slice(i, i + 2);
      i += 1;
    } else if (quote !== "'" && (c === '`' || (c === '$' && text[i + 1] === '('))) {
      out += SUBSTITUTION_STAND_IN;
      i = (c === '`' ? backtickEnd(text, i) : parenEnd(text, i + 1)) - 1;
    } else if (c === '#' && quote === '' && (i === 0 || COMMENT_START.test(text[i - 1]))) {
      const lineEnd = text.indexOf('\n', i);
      i = (lineEnd === -1 ? text.length : lineEnd) - 1;
    } else {
      if ((c === "'" || c === '"') && (quote === '' || quote === c)) quote = quote === c ? '' : c;
      out += c;
    }
  }
  return out;
}

/** Option words of a merge or pull, in order: every word before `--` that starts with `-`, without the values of VALUE_OPTIONS. */
function optionsOf(words) {
  const options = [];
  for (let i = 0; i < words.length && words[i] !== '--'; i += 1) {
    if (!words[i].startsWith('-')) continue;
    options.push(words[i]);
    if (VALUE_OPTIONS.has(words[i])) i += 1;
  }
  return options;
}

const pullAvoidsMerge = (option) => PULL_WITHOUT_MERGE.has(option) || (option.startsWith('--rebase=') && !REBASE_OFF.test(option));

/** True when this reading of a git command (its subcommand and the words after it) is a merge or a pull that can create a merge commit. */
function makesMergeCommit({ sub, rest }) {
  if (sub === 'merge') return !optionsOf(rest).some((option) => MERGE_WITHOUT_COMMIT.has(option));
  if (sub === 'pull') return !optionsOf(rest).some(pullAvoidsMerge);
  return false;
}

/**
 * The C37 advice when a simple command of the line is a git merge or pull that can create a merge commit.
 * Not covered: a merge hidden in a git or shell alias, a shell function, `bash -c` or eval. Acceptable: a quality hint never decides an ask.
 * @param {string} command raw command text (decide() asks for text over MAX_COMMAND_CHARS before this runs)
 * @returns {string[]} [MERGE_COMMIT_ADVICE], or [] when no simple command can create a merge commit
 */
export function mergeCommitAdvice(command) {
  if (!MAY_MERGE.test(command.replace(SPELLING_BREAKS, ''))) return [];
  const merges = segments(withoutSubstitutions(stripHeredocs(command))).some((words) => {
    const { cmd, args } = asGitSubcommand(commandOf(words)); // `git-merge` is git merge
    return cmd === 'git' && parseGitArgs(args).subcommands.some(makesMergeCommit);
  });
  return merges ? [MERGE_COMMIT_ADVICE] : [];
}
