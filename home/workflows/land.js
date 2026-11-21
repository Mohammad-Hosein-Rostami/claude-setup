// land: put one reviewed lane on the base branch: rebase check, a suite PASS at the tip, then a fast-forward land that also removes the lane's
// worktree, branch and copies (git-tidy land). Every step is a Haiku runner that runs one tool and reports its exit, so a failure is read from
// the exit code, never guessed.
// Args: { row, closeRow, statusFile, repo, base, branch, worktree, suite, tip, brief?, auditPending?, auditBase? }  (brief: the lane's brief file, whose named paths may
//   add files over the size limit; suite: the repo's declared full-suite command, run by test-pass as
//   `run --suite` from the repo's own declaration; tip: the sha the review cleared. Land refuses a branch that is not at it, so a branch the
//   review never read cannot land. auditPending: the lane lands without its Opus-max pair (a waived lane from build.js, or any lane the lead
//   lands without it: a hand land, a land by hand, a land after a usage limit); auditBase: the full sha the reviewed range starts at (B of B..T). Right
//   after the ff-only land a runner records `audit-log record --tip <landed sha> --base B --reviewed <tip> --state pending`, so sync and push
//   stay closed until the audit records done; a record that fails makes the land `failed` with "audit not recorded: gate holds nothing".)
// Returns: { status: 'landed'|'conflict'|'red'|'needs-review'|'ui-proof'|'new-file-size'|'failed', sha, from, patchesChanged, tidy: 'clean'|text }
//   (spec section 9, LANDED; `from` is the base tip just before the fast-forward, '' when the reflog no longer shows it).
//   ui-proof: the UI files changed and the rebased tip has no visual-qa PASS (the caller runs visual-qa on it, then land again; never `red`);
//   new-file-size: the lane adds a file over the size limit its brief does not name.
//   conflict: the caller sends an implementer, then a review of the delta; red: the suite failed at the rebased tip (tidy is the failing test files and their first error lines, else its output tail),
//   the caller treats it like a conflict: an implementer fixes it, then a review of the delta; needs-review: the rebase changed patches, review
//   the delta again; failed: the base folder is not ready or a runner stopped; the text says which.
// The first step is the disk check (tools/disk-free): below the fail threshold (default 5 GB) or a check that could not run is `failed` before any git step.
// Exit codes of git-tidy land: 0 landed clean, 1 landed with findings, 2 not ready, 3 conflict, 4 no suite PASS at the tip, 5 base moved,
//   6 ui-proof, 7 new-file-size (any other exit above 1 fails the land). A runner reply that is null or has no numeric `exit` is `failed`.
// Close row evidence on every path: `landed <to> on <base> from <from>` (spec-stages section 5, the road gate's line 2); without a `from`
//   (the reflog no longer holds the step) the row says `landed <to> on <base>` and the road gate FAILs it.
// Restart: a killed run may have landed and pruned the branch before it stopped. A branch that is gone is then looked up on the base (`git cherry`
// shows no patch of the reviewed tip missing there): that is `landed`, with the range from the base's reflog (`git-tidy range`), and the close row
// is recorded. A branch that is still there but not at the reviewed tip is `landed` only when `git-tidy range <tip> --landed <branch tip>` finds
// the reflog step that holds both (the run was killed between the fast-forward and the prune); the prune then runs. Anything else stays `failed`.
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

const RUNNER = { agentType: 'runner', model: 'haiku', effort: 'medium' }
const STEP_SCHEMA = {
  type: 'object',
  properties: {
    exit: { type: 'number' },
    tip: { type: 'string' },
    patchesChanged: { type: 'number' },
    files: { type: 'array', items: { type: 'string' } },
    tail: { type: 'string' },
    from: { type: 'string' },
  },
  required: ['exit', 'tip', 'patchesChanged', 'files', 'tail', 'from'],
}
const TIDY = 'node ~/.claude/tools/git-tidy/git-tidy.mjs'
const TEST_PASS = 'node ~/.claude/tools/test-pass/test-pass.mjs'
const STATUS = 'node ~/.claude/tools/status/status.mjs'
const DISK_FREE = 'node ~/.claude/tools/disk-free/disk-free.mjs'
const AUDIT_LOG = 'node ~/.claude/tools/review-tier/audit-log.mjs'
const SHA = /^[0-9a-f]{7,40}$/i // what audit-log record takes; anything else never reaches the command line
const AUDIT_NOT_RECORDED = 'audit not recorded: gate holds nothing' // build.js reads this prefix: the lane landed, its audit must be run and recorded by hand
const FIELDS = 'Return exit (the command\'s exit code), tip (the sha it printed after `tip`, else ""), patchesChanged (the number after `patches-changed`, else 0), files (file names it listed for a conflict, else []), tail (its last 3 output lines, no secrets), from (the sha after `from` in its output, else "").'
// The suite step reports failing tests, so it gets its own text: FIELDS would tell it files are for conflicts and tail is the last 3 lines.
const SUITE_FIELDS = 'Return exit (the command\'s exit code), tip (the sha it printed after `tip`, else ""), patchesChanged (0), files (the failing test files when the suite exits non-zero, else []), tail (each failing file\'s first error line when the suite exits non-zero, else the last 3 lines of output; no secrets), from ("").'

// A stopped runner (null) and a reply without a numeric exit are the same: no result, so every caller's null check makes it `failed`, never `landed`.
const runner = async (step, phase, prompt, fields = FIELDS) => {
  const reply = await agent(`${prompt}\nDo not change anything else. ${fields}`, { label: `${args.row}:${step}`, phase, schema: STEP_SCHEMA, ...RUNNER })
  return reply !== null && typeof reply === 'object' && typeof reply.exit === 'number' ? reply : null
}
const failed = (sha, text) => ({ status: 'failed', sha, patchesChanged: 0, tidy: text })
const evidence = (to, from) => `landed ${to} on ${args.base}${from ? ` from ${from}` : ''}`
const BRIEF = typeof args.brief === 'string' ? ` --brief ${args.brief}` : ''
const rangeOf = async (phase, landedFlag) => {
  const found = await runner('range', phase, `In ${args.repo} run: ${TIDY} range ${args.tip} ${args.repo} --base ${args.base}${landedFlag} --json. Report exit, tip (the "to" sha of its JSON, else "") and from (the "from" sha of its JSON, else "").`)
  return found !== null && found.exit === 0 && found.tip !== '' ? found : null
}
const sameSha = (a, b) => a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a))

/**
 * With auditPending, records the landed sha as `pending` in audit-log, so the gate holds sync and push until the audit ran.
 * @param {string} landedSha the sha now on the base branch (the gate's key)
 * @returns {Promise<string | null>} null when recorded (or not asked for), else the failure text of a `failed` land
 */
async function recordPendingAudit(landedSha) {
  if (args.auditPending !== true) return null
  if (!SHA.test(args.auditBase) || !SHA.test(landedSha)) return `${AUDIT_NOT_RECORDED}: the lane landed at ${landedSha}, but nothing was recorded: the audit base ${JSON.stringify(String(args.auditBase).slice(0, 80))} or the landed sha is not a git sha; record it by hand (audit-log record ... --state pending), then run the audit`
  const recorded = await runner('audit-pending', 'Land', `In ${args.repo} run: ${AUDIT_LOG} record --repo ${args.repo} --tip ${landedSha} --base ${args.auditBase} --reviewed ${args.tip} --state pending. Report exit and tail.`)
  if (recorded !== null && recorded.exit === 0) return null
  return `${AUDIT_NOT_RECORDED}: the lane landed at ${landedSha}, but its pending audit could not be recorded (${recorded === null ? 'the runner was stopped' : `exit ${recorded.exit}: ${recorded.tail}`}); record it by hand (audit-log record ... --state pending), then run the audit`
}

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
  const range = await rangeOf('Rebase', '')
  const to = range === null ? baseNow.tip : range.tip
  // The landed sha is `to` (the base tip when the reflog no longer shows the step); a pending record there keeps the gate closed (fail closed).
  const notRecordedAfterRestart = await recordPendingAudit(to)
  if (notRecordedAfterRestart !== null) return failed(to, notRecordedAfterRestart)
  await runner('status', 'Rebase', `Record the landing: ${STATUS} --file ${args.statusFile} done ${args.closeRow} "${evidence(to, range?.from)} (found already on ${args.base} after a restart)".`)
  return { status: 'landed', sha: to, from: range?.from ?? '', patchesChanged: 0, tidy: `already on ${args.base} (found on restart)` }
}
if (!sameSha(reviewedTip.tip, args.tip)) {
  // Killed between the fast-forward and the prune: the branch holds the rebased tip, which is on the base with the reviewed patches.
  const range = /^[0-9a-f]{7,40}$/.test(reviewedTip.tip) ? await rangeOf('Rebase', ` --landed ${reviewedTip.tip}`) : null
  if (range === null) return failed(reviewedTip.tip, `branch ${args.branch} is at ${reviewedTip.tip}, not at the reviewed ${args.tip}: nothing was landed`)
  const notRecordedAfterKill = await recordPendingAudit(range.tip)
  if (notRecordedAfterKill !== null) return failed(range.tip, notRecordedAfterKill)
  await runner('status', 'Rebase', `Record the landing: ${STATUS} --file ${args.statusFile} done ${args.closeRow} "${evidence(range.tip, range.from)} (found already on ${args.base} after a restart)".`)
  const prune = await runner('prune', 'Land', `In ${args.repo} run: ${TIDY} prune ${args.repo} --base ${args.base} --apply. Report exit and tail.`)
  return { status: 'landed', sha: range.tip, from: range.from, patchesChanged: 0, tidy: prune === null ? 'landed before a restart; the prune runner was stopped' : `landed before a restart; prune: ${prune.tail}` }
}

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
  const land = await runner('land', 'Land', `In ${args.repo} run: ${TIDY} land ${args.branch} ${args.repo} --base ${args.base}${BRIEF} --json`)
  if (land === null) return failed(rebase.tip, 'the land runner was stopped')
  if (land.exit === 5) {
    const base = await runner('base', 'Land', `In ${args.repo} run: git rev-parse --verify refs/heads/${args.base}. Report exit and tip (the full sha it printed).`)
    if (base === null || base.exit !== 0) return failed(rebase.tip, `the base ${args.base} could not be read after "base moved"`)
    if (base.tip === baseAtLastMove) return failed(rebase.tip, `git-tidy land said the base moved twice but ${args.base} is still at ${base.tip}`)
    baseAtLastMove = base.tip
    continue
  }
  if (land.exit === 3) return { status: 'conflict', sha: land.tip, patchesChanged: 0, tidy: land.files.join(', ') }
  if (land.exit === 6) return { status: 'ui-proof', sha: land.tip, patchesChanged: 0, tidy: land.tail }
  if (land.exit === 7) return { status: 'new-file-size', sha: land.tip, patchesChanged: 0, tidy: land.files.length > 0 ? land.files.join(', ') : land.tail }
  if (land.exit > 1) return failed(land.tip, `git-tidy land exit ${land.exit}: ${land.tail}`)
  const notRecorded = await recordPendingAudit(land.tip)
  if (notRecorded !== null) return failed(land.tip, notRecorded)

  await runner('status', 'Land', `Record the landing: ${STATUS} --file ${args.statusFile} done ${args.closeRow} "${evidence(land.tip, land.from)}".`)
  return { status: 'landed', sha: land.tip, from: land.from, patchesChanged: 0, tidy: land.exit === 0 ? 'clean' : land.tail }
}

function checkArgs(given) {
  const name = 'land' // the tool cuts `meta` out of the body, so the script's own name is written here
  const required = { row: 'string', closeRow: 'string', statusFile: 'string', repo: 'string', base: 'string', branch: 'string', worktree: 'string', suite: 'string', tip: 'string' }
  for (const [key, type] of Object.entries(required)) {
    const value = given === undefined || given === null ? undefined : given[key]
    if (typeof value !== type) throw new Error(`${name}: args.${key} must be a ${type}`)
  }
  if (given.brief !== undefined && (typeof given.brief !== 'string' || given.brief === '' || /\s/.test(given.brief))) throw new Error(`${name}: args.brief must be a file path with no spaces`)
  if (given.auditPending !== undefined && typeof given.auditPending !== 'boolean') throw new Error(`${name}: args.auditPending must be a boolean`)
  if (given.auditPending === true && typeof given.auditBase !== 'string') throw new Error(`${name}: args.auditPending needs args.auditBase (a string: the sha the reviewed range starts at)`)
}
