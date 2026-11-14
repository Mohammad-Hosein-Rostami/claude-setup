// Purpose: the one error type for "the caller used the tool wrongly or the project cannot be read as asked".
// Exports: UsageError, GitError.
// Invariants: the CLI turns a UsageError (and so a GitError) into exit code 2; any other error is a crash (exit 3).

/** A bad flag, a missing folder, a broken allow-list file, or no git for `--changed`. */
export class UsageError extends Error {}

/** git could not answer (not a work tree, unknown base, a failed command). */
export class GitError extends UsageError {}
