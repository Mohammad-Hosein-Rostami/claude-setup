// land: put one reviewed lane on the base branch: rebase check, a suite PASS at the tip, then a fast-forward land that also removes the lane's
// worktree, branch and copies (git-tidy land). Every step is a Haiku runner that runs one tool and reports its exit, so a failure is read from
// the exit code, never guessed.
// Args: { row, closeRow, statusFile, repo, base, branch, worktree, suite, tip }  (suite: the repo's declared full-suite command, run by test-pass as
//   `run --suite` from the repo's own declaration; tip: the sha the review cleared. Land refuses a branch that is not at it, so a branch the
//   review never read cannot land.)
// Returns: { status: 'landed'|'conflict'|'red'|'needs-review'|'failed', sha, patchesChanged, tidy: 'clean'|text } (spec section 9, LANDED).
//   conflict: the caller sends an implementer, then a review of the delta; red: the suite failed at the rebased tip (tidy is the failing test files and their first error lines, else its output tail),
//   the caller treats it like a conflict: an implementer fixes it, then a review of the delta; needs-review: the rebase changed patches, review
//   the delta again; failed: the base folder is not ready or a runner stopped; the text says which.
// The first step is the disk check (tools/disk-free): below the fail threshold (default 5 GB) or a check that could not run is `failed` before any git step.
// Exit codes of git-tidy land: 0 landed clean, 1 landed with findings, 2 not ready, 3 conflict, 4 no suite PASS at the tip, 5 base moved.
// Restart: a killed run may have landed and pruned the branch before it stopped. A branch that is gone is then looked up on the base (`git cherry`
// shows no patch of the reviewed tip missing there): that is `landed` with the base tip, and the close row is recorded; anything else stays `failed`.
// A moved base is retried from the rebase check with no cap: each retry follows a real landing by someone else. From the second exit 5 on, the
// base must differ from the base seen at the last exit 5, else the exit was misreported and the run fails instead of looping.
// Scripts cannot import, so checkArgs is repeated in each script (home/workflows/README.md).
export const meta = {
  name: 'land',
  description: 'Land one reviewed lane: rebase check, suite PASS at the tip, fast-forward land, prune its leftovers',
  whenToUse: 'A lane that passed its last review and must reach the base branch on one straight line of history',
  phases: [
    { title: 'Rebase', detail: 'git-tidy land --rebase-only: conflicts and changed patches' },
    { title: 'Suite', detail: 'full-suite PASS recorded for the exact tip' },
    { title: 'Land', detail: 'git-tidy land: ff-only, worktree and branch removed, copies checked' },
  ],
}
checkArgs(args)

const RUNNER = { agentType: 'runner', model: 'haiku', effort: 'low' }
const STEP_SCHEMA = {
  type: 'object',
  properties: {
    exit: { type: 'number' },
    tip: { type: 'string' },
    patchesChanged: { type: 'number' },
    files: { type: 'array', items: { type: 'string' } },
    tail: { type: 'string' },
  },
  required: ['exit', 'tip', 'patchesChanged', 'files', 'tail'],
}
const TIDY = 'node ~/.claude/tools/git-tidy/git-tidy.mjs'
const TEST_PASS = 'node ~/.claude/tools/test-pass/test-pass.mjs'
const STATUS = 'node ~/.claude/tools/status/status.mjs'
const DISK_FREE = 'node ~/.claude/tools/disk-free/disk-free.mjs'
const FIELDS = 'Return exit (the command\'s exit code), tip (the sha it printed after `tip`, else ""), patchesChanged (the number after `patches-changed`, else 0), files (file names it listed for a conflict, else []), tail (its last 3 output lines, no secrets).'
// The suite step reports failing tests, so it gets its own text: FIELDS would tell it files are for conflicts and tail is the last 3 lines.
const SUITE_FIELDS = 'Return exit (the command\'s exit code), tip (the sha it printed after `tip`, else ""), patchesChanged (0), files (the failing test files when the suite exits non-zero, else []), tail (each failing file\'s first error line when the suite exits non-zero, else the last 3 lines of output; no secrets).'

const runner = (step, phase, prompt, fields = FIELDS) => agent(`${prompt}\nDo not change anything else. ${fields}`, { label: `${args.row}:${step}`, phase, schema: STEP_SCHEMA, ...RUNNER })
const failed = (sha, text) => ({ status: 'failed', sha, patchesChanged: 0, tidy: text })
const sameSha = (a, b) => a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a))

// A full disk makes every later step fail with ENOSPC and no clear cause, so the first step refuses below the fail threshold (exit 1) and says what to clear.
phase('Rebase')
const disk = await runner('disk', 'Rebase', `In ${args.repo} run: ${DISK_FREE} check. Report exit and tail (its one output line, whole).`)
if (disk === null) return failed('', 'the disk check runner was stopped: nothing was landed')
if (disk.exit !== 0) return failed('', `disk space check refused the landing, nothing was landed: ${disk.tail}`)

const reviewedTip = await runner('tip', 'Rebase', `In ${args.repo} run: git rev-parse --verify refs/heads/${args.branch}. Report exit and tip (the full sha it printed).`)
if (reviewedTip === null) return failed('', 'the tip runner was stopped')
if (reviewedTip.exit !== 0) {
  const notFound = failed('', `branch ${args.branch} not found in ${args.repo}: ${reviewedTip.tail}`)
  const onBase = await runner('onbase', 'Rebase', `In ${args.repo} run: git cherry ${args.base} ${args.tip}. Report its exit, and patchesChanged = the number of its output lines that start with "+" (patches the base does not have). tip is "".`)
  if (onBase === null || onBase.exit !== 0 || onBase.patchesChanged > 0) return notFound
  const baseNow = await runner('base', 'Rebase', `In ${args.repo} run: git rev-parse --verify refs/heads/${args.base}. Report exit and tip (the full sha it printed).`)
  if (baseNow === null || baseNow.exit !== 0) return notFound
  await runner('status', 'Rebase', `Record the landing: ${STATUS} --file ${args.statusFile} done ${args.closeRow} "landed ${args.tip} on ${args.base} (found already on ${args.base} after a restart; base ${baseNow.tip})".`)
  return { status: 'landed', sha: baseNow.tip, patchesChanged: 0, tidy: `already on ${args.base} (found on restart)` }
}
if (!sameSha(reviewedTip.tip, args.tip)) return failed(reviewedTip.tip, `branch ${args.branch} is at ${reviewedTip.tip}, not at the reviewed ${args.tip}: nothing was landed`)

let baseAtLastMove = null

while (true) {
  phase('Rebase')
  const rebase = await runner('rebase', 'Rebase', `In ${args.repo} run: ${TIDY} land ${args.branch} ${args.repo} --base ${args.base} --rebase-only --json`)
  if (rebase === null) return failed('', 'the rebase runner was stopped')
  if (rebase.exit === 3) return { status: 'conflict', sha: rebase.tip, patchesChanged: 0, tidy: rebase.files.join(', ') }
  if (rebase.exit !== 0) return failed(rebase.tip, `rebase check exit ${rebase.exit}: ${rebase.tail}`)
  if (rebase.patchesChanged > 0) return { status: 'needs-review', sha: rebase.tip, patchesChanged: rebase.patchesChanged, tidy: rebase.tail }

  phase('Suite')
  const suite = await runner('suite', 'Suite', `Check for a full-suite PASS at the tip: ${TEST_PASS} check ${rebase.tip} --repo ${args.repo} --suite. If it exits 0 you are done (report exit 0). Otherwise run the suite on the tip: in ${args.worktree} when its HEAD is ${rebase.tip} and it has no changes, else in a detached worktree of ${rebase.tip} that you remove afterwards: ${TEST_PASS} run --repo <that folder> --suite (no command after it: test-pass runs the repo's declared suite) and report its exit. When the suite exits non-zero, report in files the failing test files and in tail each one's first error line (for node --test, its first "not ok" line and the first error message under it): the last output lines never name the failing test.`, SUITE_FIELDS)
  if (suite === null) return failed(rebase.tip, 'the suite runner was stopped')
  if (suite.exit !== 0) return { status: 'red', sha: rebase.tip, patchesChanged: 0, tidy: suite.files.length > 0 ? `${suite.files.join(', ')}: ${suite.tail}` : suite.tail }

  phase('Land')
  const land = await runner('land', 'Land', `In ${args.repo} run: ${TIDY} land ${args.branch} ${args.repo} --base ${args.base} --json`)
  if (land === null) return failed(rebase.tip, 'the land runner was stopped')
  if (land.exit === 5) {
    const base = await runner('base', 'Land', `In ${args.repo} run: git rev-parse --verify refs/heads/${args.base}. Report exit and tip (the full sha it printed).`)
    if (base === null || base.exit !== 0) return failed(rebase.tip, `the base ${args.base} could not be read after "base moved"`)
    if (base.tip === baseAtLastMove) return failed(rebase.tip, `git-tidy land said the base moved twice but ${args.base} is still at ${base.tip}`)
    baseAtLastMove = base.tip
    continue
  }
  if (land.exit === 3) return { status: 'conflict', sha: land.tip, patchesChanged: 0, tidy: land.files.join(', ') }
  if (land.exit > 1) return failed(land.tip, `git-tidy land exit ${land.exit}: ${land.tail}`)

  await runner('status', 'Land', `Record the landing: ${STATUS} --file ${args.statusFile} done ${args.closeRow} "landed ${land.tip} on ${args.base}".`)
  return { status: 'landed', sha: land.tip, patchesChanged: 0, tidy: land.exit === 0 ? 'clean' : land.tail }
}

function checkArgs(given) {
  const name = 'land' // the tool cuts `meta` out of the body, so the script's own name is written here
  const required = { row: 'string', closeRow: 'string', statusFile: 'string', repo: 'string', base: 'string', branch: 'string', worktree: 'string', suite: 'string', tip: 'string' }
  for (const [key, type] of Object.entries(required)) {
    const value = given === undefined || given === null ? undefined : given[key]
    if (typeof value !== type) throw new Error(`${name}: args.${key} must be a ${type}`)
  }
}
