// C37 advice for the Bash guard: a command that moves a branch ref by plumbing instead of landing with `git merge --ff-only`.
// `git update-ref refs/heads/main <sha>` run from a lane moves main, but the folder where main is checked out keeps its old files and
// index, so it falls behind its own branch with phantom changes. A quality rule, not a safety rule (lib/bounce-once.mjs: alone, the
// first send is denied with the advice and the identical retry runs). Exports: BRANCH_MOVE_ADVICE (the text, classed exactly in
// lib/reason-classes.mjs) and branchMoveAdvice(command) -> [] | [BRANCH_MOVE_ADVICE].
// Gives the advice for: `git update-ref <refs/heads/x | HEAD> <new>` (behind -C, --git-dir, -m, --create-reflog; HEAD only without
// --no-deref, since HEAD then means the checked-out branch), `git update-ref --stdin` when the line's text holds an `update` or `create`
// of refs/heads/ (a pipe or heredoc; input from a file is not seen), `git branch -f|--force <x> [<sha>]`, and `git fetch|push . a:b`
// whose destination is a branch. Silent on purpose: `update-ref -d` and stdin `delete`/`verify` (cleanup; this pure check cannot tell
// whether the ref is checked out, and deleting it moves no files), refs outside refs/heads/ (refs/backup, refs/tags, refs/stash,
// refs/remotes), `update-ref --no-deref HEAD` (detaches, moves no branch), branch -f next to delete, move, copy or list.
// Commands inside `$(...)`, backticks or a heredoc body are not looked into (as lib/merge-commit.mjs). Pure, no I/O.
import { asGitSubcommand, commandOf } from './command-of.mjs';
import { parseGitArgs } from './git-options.mjs';
import { withoutSubstitutions } from './merge-commit.mjs';
import { segments, stripHeredocs } from './shell-words.mjs';

export const BRANCH_MOVE_ADVICE = 'Land with git -C <folder where the branch is checked out> merge --ff-only <lane> (C37): update-ref, '
  + "branch -f and push/fetch to . move the branch but leave that folder's files and index behind. "
  + 'If no folder has the branch checked out, send the same command again and it runs.';

const BRANCHES = 'refs/heads/';
const MAY_MOVE = /update-ref|branch|fetch|push/; // cheap first look, after quotes, backslashes and blanks are dropped
const SPELLING_BREAKS = /["'\\\s]/g;
// a --stdin instruction that sets a branch: `update refs/heads/x <new>` or `create refs/heads/x <new>` (-z keeps the space after the verb)
const STDIN_BRANCH_SET = /(?:update|create)[ \t]+refs\/heads\//;
const UPDATE_REF_VALUE_OPTIONS = new Set(['-m']); // the message is the next word
const BRANCH_FORCE = new Set(['-f', '--force']);
// branch modes where -f forces something other than moving an existing branch to a commit
const BRANCH_OTHER_MODES = new Set(['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-l', '--list']);
const THIS_REPOSITORY = new Set(['.', './']);

/** Option words and positional words of a subcommand's arguments (all words after `--` are positional). */
function splitWords(rest, valueOptions = new Set()) {
  const options = [];
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--') {
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (rest[i].startsWith('-')) {
      options.push(rest[i]);
      if (valueOptions.has(rest[i])) i += 1;
    } else positional.push(rest[i]);
  }
  return { options, positional };
}

function updateRefMoves(rest, rawText) {
  const { options, positional } = splitWords(rest, UPDATE_REF_VALUE_OPTIONS);
  if (options.includes('-d')) return false;
  if (options.includes('--stdin')) return STDIN_BRANCH_SET.test(rawText);
  const [ref = ''] = positional;
  return ref.startsWith(BRANCHES) || (ref === 'HEAD' && !options.includes('--no-deref'));
}

function branchForceMoves(rest) {
  const { options, positional } = splitWords(rest);
  return options.some((option) => BRANCH_FORCE.has(option)) && !options.some((option) => BRANCH_OTHER_MODES.has(option)) && positional.length > 0;
}

/** True for a refspec whose destination is a local branch: `a:main`, `+a:refs/heads/main` (not `a:refs/backup/x`, not `a`). */
function setsBranch(refspec) {
  const colon = refspec.indexOf(':');
  if (colon === -1) return false;
  const destination = refspec.slice(colon + 1);
  return destination.startsWith(BRANCHES) || (destination !== '' && !destination.startsWith('refs/'));
}

function localTransferMoves(rest) {
  const { positional } = splitWords(rest);
  const repository = positional.findIndex((word) => THIS_REPOSITORY.has(word));
  return repository !== -1 && positional.slice(repository + 1).some(setsBranch);
}

/** True when this reading of a git command (its subcommand and the words after it) moves a branch ref without touching its folder. */
function movesBranch({ sub, rest }, rawText) {
  if (sub === 'update-ref') return updateRefMoves(rest, rawText);
  if (sub === 'branch') return branchForceMoves(rest);
  if (sub === 'fetch' || sub === 'push') return localTransferMoves(rest);
  return false;
}

/**
 * The C37 landing advice when a simple command of the line moves a branch by plumbing.
 * Not covered: a move hidden in an alias, a shell function, `bash -c` or eval, or --stdin input read from a file.
 * @param {string} command raw command text (decide() asks for text over MAX_COMMAND_CHARS before this runs)
 * @returns {string[]} [BRANCH_MOVE_ADVICE], or [] when no simple command moves a branch ref
 */
export function branchMoveAdvice(command) {
  if (!MAY_MOVE.test(command.replace(SPELLING_BREAKS, ''))) return [];
  const moves = segments(withoutSubstitutions(stripHeredocs(command))).some((words) => {
    const { cmd, args } = asGitSubcommand(commandOf(words));
    return cmd === 'git' && parseGitArgs(args).subcommands.some((reading) => movesBranch(reading, command));
  });
  return moves ? [BRANCH_MOVE_ADVICE] : [];
}
