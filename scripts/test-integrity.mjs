#!/usr/bin/env node
// Purpose: the test-integrity gate of this repo's git hooks: a commit may not delete or skip a test (C13, C29), and a reworded test
//   or assertion needs its reason in the commit body.
// Usage: node scripts/test-integrity.mjs --staged            (pre-commit: blocks the kinds in COMMIT_BLOCKING_KINDS)
//        node scripts/test-integrity.mjs --commit-msg <file>  (commit-msg: a reworded test needs a `Test change: <reason>` body line)
// Exit codes: 0 pass, 1 blocked (the lines say what and how to go on), 2 usage or git error.
// Invariants: reads only the staged diff (`git diff --cached`, which the temporary index of `git commit -- <paths>` also holds) and
//   the message file; prints paths, line numbers and kinds, never a line's text. A git that cannot be read blocks (fail closed).
// Why a block and not a rule: removing or editing tests to make them pass is the failure the harness text names ("It is unacceptable
//   to remove or edit tests"), and reward-hack attempts rise on impossible tasks.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parsePatch } from '../home/tools/review-tier/lib/diff.mjs';
import { COMMIT_BLOCKING_KINDS, rewordedChecks, weakenedChecks } from '../home/tools/review-tier/lib/weakened.mjs';

const EXIT_BLOCKED = 1;
const EXIT_USAGE = 2;
const MIN_REASON_CHARS = 10; // a reason, not a placeholder such as "fix"
const REASON_LINE = /^Test change:\s*(.+)$/im;
const COMMENT_LINE = /^#/; // git strips these from the message
const DIFF_FLAGS = ['diff', '--cached', '--no-color', '--no-ext-diff', '--no-renames', '-U0', '--'];

/** The staged changes as parsePatch entries, or null when git cannot be read. */
function stagedFiles() {
  const result = spawnSync('git', DIFF_FLAGS, { encoding: 'utf8', maxBuffer: 256 << 20 });
  return result.status === 0 ? parsePatch(result.stdout) : null;
}

const placeOf = (entry) => `${entry.path}:${entry.line} ${entry.kind}`;

/** pre-commit: block a deleted, skipped, `.only`, todo or ignored check. */
function checkStaged(files) {
  const blocked = weakenedChecks(files).filter((entry) => COMMIT_BLOCKING_KINDS.has(entry.kind));
  if (blocked.length === 0) return 0;
  console.error('test-integrity: this commit removes or skips checks; a deleted, skipped or `.only` test always blocks (C13, C29):');
  for (const entry of blocked) console.error(`  ${placeOf(entry)}`);
  console.error('  Keep the test and fix the code. Only a changed wording passes (with `Test change: <reason>` in the commit body).');
  return EXIT_BLOCKED;
}

/** The message without git's comment lines. */
const messageOf = (file) => readFileSync(file, 'utf8').split('\n').filter((line) => !COMMENT_LINE.test(line)).join('\n');

/** commit-msg: a reworded test or assertion needs `Test change: <reason>` in the body (not the subject). */
function checkMessage(files, messageFile) {
  const reworded = rewordedChecks(files);
  if (reworded.length === 0) return 0;
  const body = messageOf(messageFile).split('\n').slice(1).join('\n');
  const reason = REASON_LINE.exec(body)?.[1].trim() ?? '';
  if (reason.length >= MIN_REASON_CHARS) return 0;
  console.error('test-integrity: this commit rewords tests or assertions and its body gives no reason:');
  for (const entry of reworded) console.error(`  ${placeOf(entry)}`);
  console.error(`  Add a body line \`Test change: <why the spec changed this behaviour>\` (at least ${MIN_REASON_CHARS} characters).`);
  return EXIT_BLOCKED;
}

function main(argv) {
  const files = stagedFiles();
  if (files === null) {
    console.error('test-integrity: git diff --cached failed: blocked (fail closed)');
    return EXIT_USAGE;
  }
  if (argv[0] === '--staged' && argv.length === 1) return checkStaged(files);
  if (argv[0] === '--commit-msg' && argv.length === 2) return checkMessage(files, argv[1]);
  console.error('usage: test-integrity.mjs --staged | --commit-msg <message file>');
  return EXIT_USAGE;
}

process.exitCode = main(process.argv.slice(2));
