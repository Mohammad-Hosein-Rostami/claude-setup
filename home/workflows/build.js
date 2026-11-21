// build: implement lanes in parallel worktrees, join, review, land. Per lane: implementer (and a test-writer when acceptanceTests) in isolated worktrees, a runner Join
// (cherry-pick the test commits, run the related tests, close the implement row, start the close row), the `review` child (landing review with fixes), then a serial
// land queue through the `land` child. Lane A lands while lane B is still in review.
// Args: { base, repo, suite, writers, statusFile, scriptsDir, appendOnly?, resume?, lanes: [{ row, closeRow, branch, spec, files, acceptanceTests, implementer: { agentType?, model, effort },
//   matrix?, principles?, checkpoints?, addClasses? }] } (home/skills/wf-build/SKILL.md explains each key). checkArgs throws when two lanes share a file that is not in appendOnly
//   (a folder and a file inside it count), when a checkpoint's files overlap its lane's files, when two checkpoints of a lane share an id, or when a ui-implementer lane has no matrix.
// Returns: { lanes: [{ row, closeRow, status, sha, text, findings?, optional?, audit? }], leadList } with status landed | implementer-stopped | wrong-branch | join-failed |
//   contract-touched | review-<status of the review> | lead-decision | failed (land said so) | audit-findings | audit-error; the lead reads text and decides.
//   lead-decision: a clean review with a security finding ruled not real by a weaker check or the judge: held, never landed, until the lead rules. leadList also holds each `contract-dispute`.
//   contract-touched: the implementer edited a locked file (a checkpoint's files or the test-writer's): not reviewed. audit-findings / audit-error: the lane landed, but its post-land
//   audit found something or could not finish; sync and push stay closed (audit-log gate), except audit-error with "gate holds nothing" in its text: nothing was recorded, run the audit by hand.
// Join: a runner runs commands and reports exit codes; this script judges them. A lane gets `waiverAt` (the review may use its short waived set) only with a test-writer, a red-first
//   checkpoint, every checkpoint met at base and head, nothing vacuous or out of scope and no dispute. A lane with nothing locked is not asked for contractTouched.
//   resume: true on a re-run after a stop that lost the journal (wf-resume): a lane whose close row STATUS.md already shows landed is not built again (status landed, sha from STATUS.md).
// Writers of one lane's fixes run one at a time inside `review`; `writers` bounds the build agents of all lanes. Branch rule: a lane's agent renames its throwaway worktree branch to
// the lane branch; a re-done lane (the branch exists) continues that branch. Scripts cannot import, so checkArgs and the limiter are repeated where needed (home/workflows/README.md).
export const meta = {
  name: 'build',
  description: 'Implement lanes in parallel worktrees, join, review with fixes, land one lane at a time',
  whenToUse: 'A spec or plan split into lanes (files, acceptance) that must be built, reviewed and landed on the base branch',
  phases: [
    { title: 'Build', detail: 'implementer and test-writer per lane, each in its own worktree' },
    { title: 'Join', detail: 'cherry-pick the test commit, related tests, close the implement row' },
    { title: 'Review', detail: 'review child: lenses, verifiers, fixes, delta rounds, landing suite' },
    { title: 'Land', detail: 'land child, one lane at a time; conflicts, a red suite and changed patches go back to review' },
    { title: 'Audit', detail: 'after the land, a waived lane: audit-log record, review child in audit mode on B..T, audit-log done' },
  ],
}
checkArgs(args)

const RUNNER = { agentType: 'runner', model: 'haiku', effort: 'low' }
const TEST_WRITER = { agentType: 'test-writer', model: 'sonnet', effort: 'medium' }
const STATUS = 'node ~/.claude/tools/status/status.mjs'
const [str, num, bool, strings] = [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'array', items: { type: 'string' } }]
const shape = (properties, required) => ({ type: 'object', properties, required })
const IMPLEMENTED = shape({ branch: str, worktree: str, sha: str, tests: { type: 'object' }, tier: { type: 'object' }, disputes: strings }, ['branch', 'worktree', 'sha', 'tests'])
const TESTS_WRITTEN = shape({ branch: str, worktree: str, sha: str }, ['branch', 'worktree', 'sha'])
const CHECKPOINT_RESULT = shape({ id: str, baseExit: num, headExit: num, tail: str }, ['id', 'baseExit', 'headExit', 'tail'])
const JOINED = shape({ red: bool, tail: str, sha: str, worktree: str, vacuous: strings, outOfScope: strings, contractTouched: strings, checkpoints: { type: 'array', items: CHECKPOINT_RESULT } },
  ['red', 'tail', 'sha', 'worktree', 'vacuous', 'outOfScope', 'contractTouched', 'checkpoints'])
const AUDIT_DECISION = shape({ recordExit: num, shouldExit: num, audit: bool, reason: str, tail: str }, ['recordExit', 'shouldExit', 'audit'])
const AUDIT_PREPARED = shape({ ancestor: bool, changedLines: num, worktree: str, tail: str }, ['ancestor', 'changedLines', 'worktree'])
const AUDIT_RECORDED = shape({ exit: num, tail: str }, ['exit'])
const AUDIT_LOG = 'node ~/.claude/tools/review-tier/audit-log.mjs'
const GIT_SHA = /^[0-9a-f]{7,40}$/ // shas go into runner commands: only hex passes
const DISK_CHECKED = shape({ exit: num, tail: str, baseTip: str }, ['exit', 'tail'])
const FULL_SHA = /^[0-9a-f]{40}$/
// The tips of the base branch this build saw itself: the tip when it started and the sha each of its own lands returned. A review child may move a
// lane's start only to one of these (review.js, D7): a base ref moved by anyone else names a commit that no review of this build has read.
const baseTips = []
const recordBaseTip = (sha) => { if (FULL_SHA.test(sha ?? '') && !baseTips.includes(sha)) baseTips.push(sha) }
const LANDED_ROW = shape({ landed: bool, sha: str }, ['landed', 'sha'])
const leadList = []
// Worktree paths agents return go into later shell commands (a worktree remove, a cherry-pick): only a plain absolute path passes (N1): POSIX or a
// Windows drive path (C:/x or C:\x); no spaces, quotes, `$`, `;` or `%`.
const SAFE_PATH = /^(?:[A-Za-z]:[\\/]|\/)[\w@+=.,/\\-]+$/

// At most args.writers writer agents at once, across all lanes (scripts cannot import, so the limiter lives here).
let writersRunning = 0
const writersWaiting = []
const startNextWriter = () => {
  if (writersRunning >= args.writers || writersWaiting.length === 0) return
  const next = writersWaiting.shift()
  writersRunning += 1
  next.task().then(next.resolve, next.reject).finally(() => { writersRunning -= 1; startNextWriter() })
}
const limitedWriter = (task) => new Promise((resolve, reject) => { writersWaiting.push({ task, resolve, reject }); startNextWriter() })

// Lands go through one chain, so two land calls never overlap.
let landChain = Promise.resolve()
const inLandQueue = (task) => {
  const run = landChain.then(task)
  landChain = run.catch(() => {})
  return run
}

// agent-model-guard does not fire for a workflow spawn, so the brief carries its two lines: the UI matrix and the standing rules (S3).
const matrixLine = (lane) => (lane.implementer.agentType === 'ui-implementer' ? `MATRIX: ${lane.matrix}\n` : '')
const standingRulesLine = `Read the \`## Standing rules\` of ${args.statusFile} (if it has any) first and follow them.\n`
const implementerPrompt = (lane) => `${matrixLine(lane)}${standingRulesLine}Implement lane ${lane.row} of the spec ${lane.spec}: touch only ${lane.files.join(', ')}. `
  + `Your worktree starts on a throwaway branch (git branch --show-current, named worktree-...). Branch ${lane.branch} must hold your work, based on ${args.base}: `
  + `if it does not exist yet, rename the throwaway branch with \`git branch -m ${lane.branch}\` (git rebase ${args.base} if it is not based on it); `
  + `if it already exists (a re-done lane) never make a copy: remove the old worktree that holds it (git worktree list, then git worktree remove <path>), run \`git switch ${lane.branch} && git rebase ${args.base}\`, and delete the throwaway branch (\`git branch -d <its name>\`). `
  + `Run only the tests related to your changes while iterating (quiet reporter), commit after each green step, never merge, never push. `
  + contractText(lane)
  + `Last run \`node ~/.claude/tools/review-tier/review-tier.mjs ${args.base}...HEAD --landing --json\` and return IMPLEMENTED: branch (must be ${lane.branch}), worktree (your pwd), sha (HEAD), tests {cmd, exit}, tier (that JSON).`
// The lane contract in the implementer's brief: checkpoints, principle questions, locked files, and the run rules (never the full suite: the review runs it once).
const lockedFiles = (lane) => [...new Set((lane.checkpoints ?? []).flatMap((checkpoint) => checkpoint.files))]
const contractText = (lane) => (lane.checkpoints?.length > 0 ? `Checkpoints (when you are done each \`run\` must exit with its exit code; a red-first one exits differently before your change): ${lane.checkpoints.map((checkpoint) => `${checkpoint.id}: \`${checkpoint.run}\` exit ${checkpoint.exit} (${checkpoint.kind})`).join('; ')}. ` : '')
  + (lane.principles?.length > 0 ? `Principle questions: answer each yes or no with file:line before you finish, a no is a finding: ${lane.principles.map((principle) => `${principle.id} ${principle.question}`).join(' ')} ` : '')
  + `Locked files (${[...lockedFiles(lane), ...(lane.acceptanceTests ? [`the test files of ${testBranch(lane)}`] : [])].join(', ') || 'none'}): never edit them; if one is wrong write \`contract-dispute: <file>: <why>\` in disputes instead. `
  + `Never run the full suite (the review runs it once at the tip); Bash timeout 600000 for a commit, 60000 for a probe. `
  + (lane.acceptanceTests ? `If branch ${testBranch(lane)} exists, cherry-pick ${args.base}..${testBranch(lane)} before the last review-tier run. ` : '')
const testWriterPrompt = (lane) => `${standingRulesLine}Write the acceptance tests of lane ${lane.row} from the spec ${lane.spec} (files: ${lane.files.join(', ')}): test files only, each test fails without the behaviour it checks. `
  + `Your worktree starts on a throwaway branch (named worktree-...): rename it with \`git branch -m ${testBranch(lane)}\`. Commit; never merge, never push. Return branch, worktree (your pwd), sha (HEAD).`
// The join runner only runs commands and reports numbers and file lists; judgeContract below decides from the exit codes (never a model's reading).
const joinPrompt = (lane, built, written) => {
  const checkpoints = lane.checkpoints ?? []
  const baseSide = written ? `the test-writer worktree ${written.worktree} (at ${written.sha})` : 'a detached worktree at `git merge-base ' + args.base + ' HEAD` (git worktree add --detach, removed when you are done)'
  const lockedPathspec = [...lockedFiles(lane), ...(written ? [`<the test files changed by ${written.sha}>`] : [])].join(' ')
  // Nothing locked: no contractTouched (an empty pathspec would list every changed file). A checkpoint with no locked files still needs its base-side run.
  const locked = lockedPathspec !== ''
  return [
    `Join lane ${lane.row} in its worktree ${built.worktree} (branch ${lane.branch}). Bash timeout 600000 for every test or checkpoint command, 60000 for any other.`,
    written ? `Cherry-pick onto the lane only the commits of ${written.branch} (worktree ${written.worktree}, sha ${written.sha}) that \`git cherry ${lane.branch} ${written.branch}\` marks +. Keep the helper branch and worktree until the base-side runs below are done.` : '',
    written || checkpoints.length > 0 ? `Base-side runs, in ${baseSide}: ${written ? `run each test file changed by ${written.sha} (git diff --name-only ${args.base}...${written.sha}) alone with the repo's single-file test command and list in vacuous those that exit 0; ` : ''}${checkpoints.length > 0 ? `run each checkpoint's command and keep its exit as baseExit: ${checkpoints.map((checkpoint) => `${checkpoint.id}: ${checkpoint.run}`).join('; ')}.` : ''}` : '',
    checkpoints.length > 0 ? `Head runs, in ${built.worktree} (the joined HEAD): run the same checkpoint commands, keep each exit as headExit and the last 3 output lines as tail (no secrets). Report every checkpoint as {id, baseExit, headExit, tail}.` : '',
    `Lists (file names, empty when none): outOfScope = files in \`git diff --name-only ${args.base}...HEAD\` that are neither inside ${lane.files.join(', ')} nor test files of the lane${locked ? `; contractTouched = \`git diff ${written ? written.sha : '<the merge-base sha above>'} HEAD --name-only -- ${lockedPathspec}\`` : ''}.`,
    written ? `Then delete the helper branch ${written.branch} and its worktree.` : '',
    `Run the related tests for the lane's changed files with the repo's own command (e.g. node scripts/affected-tests.mjs --base ${args.base} --run, vitest related --run, jest --findRelatedTests) and report red true when any fail, with the failing lines in tail.`,
    `Then update the rows: ${STATUS} --file ${args.statusFile} done ${lane.row} "implemented ${lane.branch}; related tests green or red as you found them" and ${STATUS} --file ${args.statusFile} start ${lane.closeRow}. Return red, tail, sha (HEAD of the lane), worktree, vacuous, outOfScope, contractTouched, checkpoints.`,
  ].filter((line) => line !== '').join('\n')
}
const testBranch = (lane) => `${lane.branch}--tests`
const contractArgs = (lane) => ({ ...(lane.principles ? { principles: lane.principles } : {}), ...(lane.addClasses ? { addClasses: lane.addClasses } : {}) })
const reviewArgs = (lane, worktree, extra = {}) => ({ row: lane.closeRow, repo: args.repo, base: args.base, range: `${args.base}...${lane.branch}`, landing: true, fix: true, branch: lane.branch, worktree, suite: args.suite, ...contractArgs(lane), ...extra })
// What a review child of the land loop is told about the lane start: the start the review before it recorded, and this build's own base tips (N21, D7).
// A result with no recorded start (an older script) gets neither: the child then reads the start through review-tier.
const startRecord = (reviewed) => (FULL_SHA.test(reviewed.laneStart ?? '') ? { laneStart: reviewed.laneStart, baseTips: [...baseTips] } : {})
const finding = (id, file, problem, fix) => ({ id, severity: 'blocking', file, line: 0, problem, fix, security: false })

const outcome = (lane, status, sha = '', text = '', extra = {}) => ({ row: lane.row, closeRow: lane.closeRow, status, sha, text, ...extra })
// The review's own lists travel with the lane's outcome, so a finding of a failed review or an optional one is never lost.
const listsOf = (reviewed) => ({ ...(reviewed.findings?.length > 0 ? { findings: reviewed.findings } : {}), ...(reviewed.optional?.length > 0 ? { optional: reviewed.optional } : {}) })
const heldForLead = (lane, reviewed) => outcome(lane, 'lead-decision', reviewed.tip,
  `security findings ruled not real by a weaker check, so the lane is held: ${reviewed.leadList.map((item) => `${item.id} ${item.file}:${item.line} (${item.reason})`).join('; ')}. Land with the land workflow at tip ${reviewed.tip} only after the lead rules.`, listsOf(reviewed))
// The verdict on the join's numbers. Passing at head means headExit equals the declared exit; red-first must differ at base, keeps-working must match.
// waiverAt is only the joined sha when a test-writer ran, a red-first checkpoint exists, nothing below produced a finding and the implementer disputed nothing.
const judgeContract = (lane, written, built, joined) => {
  const findings = []
  const problem = (id, text) => findings.push(finding(`contract-${lane.row}-${id}`, '(contract)', text, 'fix the change (or add the missing test) so the contract holds; locked files are never edited'))
  const results = new Map(joined.checkpoints.map((result) => [result.id, result]))
  for (const checkpoint of lane.checkpoints ?? []) {
    const result = results.get(checkpoint.id)
    if (result === undefined) { problem(checkpoint.id, `checkpoint ${checkpoint.id} (${checkpoint.run}) has no result from the join`); continue }
    if (result.headExit !== checkpoint.exit) problem(checkpoint.id, `checkpoint ${checkpoint.id} (${checkpoint.run}) exits ${result.headExit} at the joined head, not ${checkpoint.exit}: ${result.tail}`)
    const metAtBase = checkpoint.kind === 'red-first' ? result.baseExit !== checkpoint.exit : result.baseExit === checkpoint.exit
    if (!metAtBase) problem(checkpoint.id, `checkpoint ${checkpoint.id} (${checkpoint.run}) exits ${result.baseExit} before the change: a ${checkpoint.kind} checkpoint ${checkpoint.kind === 'red-first' ? 'must not already pass' : 'must pass'} there`)
  }
  joined.vacuous.forEach((file) => problem(`vacuous-${file}`, `test ${file} passes without the change (vacuous)`))
  joined.outOfScope.forEach((file) => problem(`scope-${file}`, `${file} changed but is outside the lane's files`))
  const redFirst = (lane.checkpoints ?? []).some((checkpoint) => checkpoint.kind === 'red-first')
  return { findings, waiverAt: written !== null && redFirst && findings.length === 0 && (built.disputes ?? []).length === 0 ? joined.sha : undefined }
}
const reviewChild = async (lane, extra) => {
  const reviewed = await workflow({ scriptPath: `${args.scriptsDir}/review.js` }, extra)
  leadList.push(...(reviewed.leadList ?? []))
  return reviewed
}

// resume: the state of the world beats the script's memory. A lane landed before the stop is found in STATUS.md (land.js records `landed <sha>` on the close row).
const landedBeforeStop = async (lane) => {
  const row = await agent(`Read ${args.statusFile} (change nothing): find the Work items row with id ${lane.closeRow}. Report landed true only when its done cell is not empty and its evidence says "landed"; sha = the sha its evidence names after "landed", else "".`,
    { label: `${lane.row}:resumed`, phase: 'Build', schema: LANDED_ROW, ...RUNNER })
  return row?.landed === true ? outcome(lane, 'landed', row.sha, 'already landed: STATUS.md shows the close row done (found on restart)') : null
}

async function buildLane(lane) {
  if (args.resume === true) {
    const already = await landedBeforeStop(lane)
    if (already !== null) return already
  }
  const implement = limitedWriter(() => agent(implementerPrompt(lane), {
    label: `${lane.row}:implement`, phase: 'Build', agentType: lane.implementer.agentType ?? 'implementer', model: lane.implementer.model, effort: lane.implementer.effort, isolation: 'worktree', schema: IMPLEMENTED,
  }))
  const tests = lane.acceptanceTests
    ? limitedWriter(() => agent(testWriterPrompt(lane), { label: `${lane.row}:tests`, phase: 'Build', ...TEST_WRITER, isolation: 'worktree', schema: TESTS_WRITTEN }))
    : Promise.resolve(null)
  const [built, written] = await parallel([() => implement, () => tests])
  if (built === null || (lane.acceptanceTests && written === null)) return outcome(lane, 'implementer-stopped', '', 'a build agent was stopped before it returned')
  // An agent that stays on another branch would have its work reviewed under one name and landed under another (B1).
  if (built.branch !== lane.branch) return outcome(lane, 'wrong-branch', built.sha, `the implementer is on branch ${built.branch}, not ${lane.branch}: the lane was not joined or landed`)
  if (!SAFE_PATH.test(built.worktree) || (written !== null && !SAFE_PATH.test(written.worktree))) return outcome(lane, 'failed', built.sha, `a build agent returned a worktree path that is not a plain absolute path: ${built.worktree}${written ? `, ${written.worktree}` : ''}`)
  if (written !== null && written.branch !== testBranch(lane)) return outcome(lane, 'wrong-branch', written.sha, `the test-writer is on branch ${written.branch}, not ${testBranch(lane)}: the lane was not joined or landed`)
  return { lane, built, written }
}

async function joinLane(step) {
  if (step.status) return step
  const { lane, built, written } = step
  const joined = await agent(joinPrompt(lane, built, written), { label: `${lane.row}:join`, phase: 'Join', schema: JOINED, ...RUNNER })
  if (joined === null) return outcome(lane, 'join-failed', built.sha, 'the join runner was stopped')
  if (!SAFE_PATH.test(joined.worktree)) return outcome(lane, 'join-failed', built.sha, `the join runner returned a worktree path that is not a plain absolute path: ${joined.worktree}`)
  const nothingLocked = written === null && lockedFiles(lane).length === 0 // then the runner was never asked for contractTouched
  if (!nothingLocked && joined.contractTouched.length > 0) {
    return outcome(lane, 'contract-touched', joined.sha, `locked contract files were edited: ${joined.contractTouched.join(', ')}; not reviewed or landed. Disputes: ${(built.disputes ?? []).join('; ') || 'none given'}`)
  }
  return { lane, built, written, joined }
}

async function reviewLane(step) {
  if (step.status) return step
  const { lane, built, written, joined } = step
  const contract = judgeContract(lane, written, built, joined)
  // A dispute asks the lead to rule on a locked file: the fix agent cannot edit it, so it is no finding of the review (the lane's waiver is blocked above).
  leadList.push(...(built.disputes ?? []).map((line, at) => ({ id: `dispute-${lane.row}-${at}`, file: '(contract)', line: 0, reason: `implementer dispute, unresolved: ${line}` })))
  const initialFindings = [...(joined.red ? [finding(`join-${lane.row}`, '(tests)', `related tests are red after the join: ${joined.tail}`, 'make the related tests pass')] : []), ...contract.findings]
  const reviewed = await reviewChild(lane, reviewArgs(lane, joined.worktree, { ...(initialFindings.length > 0 ? { initialFindings } : {}), ...(contract.waiverAt ? { waiverAt: contract.waiverAt } : {}) }))
  if (reviewed.status !== 'clean') return outcome(lane, `review-${reviewed.status}`, reviewed.tip, reviewed.text, listsOf(reviewed))
  if ((reviewed.leadList ?? []).length > 0) return heldForLead(lane, reviewed)
  return { lane, reviewed, waived: reviewed.waived === true && contract.waiverAt !== undefined }
}

// For the audit stage, by lane row: the LAST review's base and tip (the range B..T), the landed sha (the gate key), whether the land loop reviewed again.
const auditInputs = new Map()

async function landLane(step) {
  if (step.status) return step
  const { lane, waived } = step // waived: the FIRST review's verdict, kept even when land-loop delta reviews follow
  let [reviewed, escalated] = [step.reviewed, false] // escalated: the land loop reviewed again
  while (true) {
    const landed = await inLandQueue(() => workflow({ scriptPath: `${args.scriptsDir}/land.js` }, { row: lane.closeRow, closeRow: lane.closeRow, statusFile: args.statusFile, repo: args.repo, base: args.base, branch: lane.branch, worktree: reviewed.worktree, suite: args.suite, tip: reviewed.tip }))
    if (landed.status === 'landed') {
      recordBaseTip(landed.sha)
      if (waived) auditInputs.set(lane.row, { lane, baseSha: reviewed.baseSha, tip: reviewed.tip, landedSha: landed.sha, escalated })
      return outcome(lane, 'landed', landed.sha, '', listsOf(reviewed))
    }
    if (landed.status === 'failed') return outcome(lane, 'failed', landed.sha, landed.tidy)
    // conflict: the conflict is a finding the fix agent resolves while rebasing; red: the suite failed at the rebased tip, the fix agent repairs it; needs-review: the rebase changed patches, so review the delta
    const initialFindings = { conflict: [finding(`conflict-${lane.row}`, landed.tidy, `rebasing ${lane.branch} onto ${args.base} conflicts in ${landed.tidy}`, `resolve the conflicts keeping both intents while rebasing onto ${args.base}`)],
      red: [finding(`red-${lane.row}`, '(suite)', `suite red at the rebased tip: ${landed.tidy}`, `make the full suite pass at the rebased tip of ${lane.branch}`)] }[landed.status]
    escalated = true
    reviewed = await reviewChild(lane, reviewArgs(lane, reviewed.worktree, { deltaOf: reviewed.tip, laneClasses: reviewed.laneClasses, ...startRecord(reviewed), ...(initialFindings ? { initialFindings } : { priorFindings: [] }) })) // needs-review: the lane's last review was clean, so there is no finding to carry; the empty list is on purpose (review.js refuses deltaOf without it)
    if (reviewed.status !== 'clean') return outcome(lane, `review-${reviewed.status}`, reviewed.tip, reviewed.text, listsOf(reviewed))
    if ((reviewed.leadList ?? []).length > 0) return heldForLead(lane, reviewed)
  }
}

// The audit of a landed, waived lane is the last stage of its own pipeline, so it overlaps the lanes still building or reviewing. It logs every step with audit-log
// under the LANDED sha (the key `audit-log gate` matches against main); the range is the recorded B..T, never a branch name. A failure leaves the record
// `pending` or `error` (sync and push stay closed) and the lane reports `audit-error` instead of being lost.
async function auditLane(step) {
  const input = step.status === 'landed' ? auditInputs.get(step.row) : undefined
  if (input === undefined) return step
  try {
    return await auditAfterLand(step, input)
  } catch (error) {
    return { ...step, status: 'audit-error', text: `the audit stopped on an error: ${error.message}`, audit: { status: 'error', findings: [] } }
  }
}

async function auditAfterLand(step, { lane, baseSha, tip, landedSha, escalated }) {
  const failedAudit = (text, findings = []) => ({ ...step, status: 'audit-error', text, audit: { status: 'error', findings } })
  if (![baseSha, tip, landedSha].every((sha) => GIT_SHA.test(sha ?? ''))) return failedAudit(`no usable shas to audit (base ${baseSha}, tip ${tip}, landed ${landedSha}): nothing was recorded, so the audit-log gate holds nothing for this lane: run the audit by hand`)
  const auditStep = (name, schema, prompt) => agent(prompt, { label: `${lane.row}:audit-${name}`, phase: 'Audit', schema, ...RUNNER })
  const record = (state, more = '') => `${AUDIT_LOG} record --repo ${args.repo} --tip ${landedSha} --base ${baseSha} --state ${state}${more}`
  const decision = await auditStep('decide', AUDIT_DECISION, `In ${args.repo} run: ${record('pending')}. Then run: ${AUDIT_LOG} should-audit --tip ${landedSha}${escalated ? ' --escalate' : ''} --json. Do not change anything else. Report recordExit, shouldExit, audit (the JSON's audit), reason, tail.`)
  // A stopped runner (null) audits: the finish record settles the state either way (fail closed).
  if (decision !== null && decision.recordExit !== 0) return failedAudit(`the audit could not be recorded as pending (${decision.tail}), so the audit-log gate holds nothing for this lane: run the audit by hand`)
  if (decision !== null && decision.shouldExit === 0 && decision.audit === false) {
    const marked = await auditStep('sampled', AUDIT_RECORDED, `In ${args.repo} run: ${record('sampled-out')}. Report exit and tail.`)
    if (marked === null || marked.exit !== 0) return failedAudit('sampled-out could not be recorded: the record stays pending, so sync and push stay closed')
    return { ...step, audit: { status: 'sampled-out', findings: [] } }
  }
  const worktreeName = `audit-${lane.row.replace(/[^A-Za-z0-9._-]+/g, '-')}-${tip.slice(0, 8)}`
  const prepared = await auditStep('prepare', AUDIT_PREPARED, `In ${args.repo} run: git merge-base --is-ancestor ${baseSha} ${tip} (ancestor is true when it exits 0) and git diff --numstat ${baseSha} ${tip} (changedLines = the sum of the added and deleted columns). `
    + `Only when ancestor is true and changedLines is above 0: git worktree add --detach <a new folder named ${worktreeName} inside the scratchpad directory your instructions name> ${tip}, and report its absolute path as worktree; otherwise worktree is "". Do not change anything else. Report ancestor, changedLines, worktree, tail.`)
  if (prepared === null || !prepared.ancestor || prepared.changedLines < 1 || !SAFE_PATH.test(prepared.worktree) || !prepared.worktree.endsWith(worktreeName)) {
    const refusedWorktree = prepared !== null && SAFE_PATH.test(prepared.worktree) && prepared.worktree.endsWith(worktreeName) ? `git worktree remove --force ${prepared.worktree}. Then run: ` : ''
    await auditStep('error', AUDIT_RECORDED, `In ${args.repo} run: ${refusedWorktree}${record('error')}. Report exit and tail.`)
    return failedAudit(`the audit range ${baseSha}..${tip} cannot be audited (${prepared === null ? 'the prepare runner was stopped' : JSON.stringify(prepared)}); recorded as error, an empty range is never clean`)
  }
  let audited
  try {
    audited = await reviewChild(lane, { row: lane.closeRow, repo: args.repo, base: baseSha, range: `${baseSha}..${tip}`, landing: false, fix: false, branch: lane.branch, worktree: prepared.worktree, suite: args.suite, audit: { base: baseSha, tip }, ...contractArgs(lane) })
  } catch (error) {
    audited = { status: 'failed', text: `the audit review stopped on an error: ${error.message}`, findings: [], leadList: [] }
  }
  const stopped = audited.status === 'failed' || audited.status === 'incomplete'
  const confirmed = [...(audited.findings ?? []).filter((item) => item.severity !== 'optional'), ...(audited.leadList ?? [])]
  const finished = await auditStep('finish', AUDIT_RECORDED, `In ${args.repo} run: git worktree remove --force ${prepared.worktree}. Then run: ${stopped ? record('error') : record('done', ` --confirmed ${confirmed.length}`)}. Report exit (of the record command) and tail.`)
  if (finished === null || finished.exit !== 0) return failedAudit('the audit result could not be recorded: the record stays pending, so sync and push stay closed', confirmed)
  if (stopped) return failedAudit(`the audit review ${audited.status}: ${audited.text}`, confirmed)
  if (confirmed.length > 0) return { ...step, status: 'audit-findings', text: `the post-land audit confirmed ${confirmed.length} finding(s); sync and push stay closed until they are fixed and audit-log resolve is run`, audit: { status: 'findings', findings: confirmed } }
  return { ...step, audit: { status: 'clean', findings: [] } }
}

// A full disk makes every agent fail with ENOSPC and no clear cause, so the build refuses to start below the fail threshold of tools/disk-free
// (exit 1; a check that could not run, exit 2, also refuses) and every lane's text carries the message that names the caches to clear.
phase('Build')
if (args.lanes.length > 0) {
  const disk = await agent(`Run: node ~/.claude/tools/disk-free/disk-free.mjs check. Then run: git -C ${args.repo} rev-parse --verify ${FULL_SHA.test(args.base) ? args.base : `refs/heads/${args.base}`}. Do not change anything. Report exit (the first command's exit code), tail (its one output line, whole) and baseTip (the full 40-character sha the second command printed, "" when it failed).`, { label: `${args.lanes[0].row}:disk`, phase: 'Build', schema: DISK_CHECKED, ...RUNNER })
  const refusal = disk === null ? 'the disk check runner was stopped' : disk.exit === 0 ? '' : `disk space check refused the build: ${disk.tail}`
  recordBaseTip(disk?.baseTip)
  if (refusal !== '') return { lanes: args.lanes.map((lane) => outcome(lane, 'failed', '', `${refusal}. Nothing was built.`)), leadList }
}
const lanes = await pipeline(args.lanes, buildLane, joinLane, reviewLane, landLane, auditLane)
return { lanes: lanes.map((entry, at) => entry ?? outcome(args.lanes[at], 'failed', '', 'the lane stopped on an error')), leadList }

function checkArgs(given) {
  const name = 'build' // the tool cuts `meta` out of the body, so the script's own name is written here
  const typeName = (type) => (type === 'array' ? 'an array' : `a ${type}`)
  const check = (holder, path, key, type) => {
    const value = holder === undefined || holder === null ? undefined : holder[key]
    if (!(type === 'array' ? Array.isArray(value) : typeof value === type)) throw new Error(`${name}: args.${path}${key} must be ${typeName(type)}`)
  }
  for (const [key, type] of Object.entries({ base: 'string', repo: 'string', suite: 'string', writers: 'number', statusFile: 'string', scriptsDir: 'string', lanes: 'array' })) check(given, '', key, type)
  if (given.resume !== undefined) check(given, '', 'resume', 'boolean')
  given.lanes.forEach((lane, at) => {
    for (const [key, type] of Object.entries({ row: 'string', closeRow: 'string', branch: 'string', spec: 'string', files: 'array', acceptanceTests: 'boolean', implementer: 'object' })) check(lane, `lanes[${at}].`, key, type)
    for (const key of ['model', 'effort']) check(lane.implementer, `lanes[${at}].implementer.`, key, 'string')
    checkContract(lane, at)
    const usable = typeof lane.matrix === 'string' && (lane.matrix.startsWith('none:') ? lane.matrix.slice('none:'.length).trim().length >= 15 : lane.matrix.trim() !== '')
    if (lane.implementer.agentType === 'ui-implementer' && !usable) throw new Error(`${name}: args.lanes[${at}].matrix must be a coverage matrix path or \`none: <reason of 15+ characters>\` for a ui-implementer`)
  })
  if (given.appendOnly !== undefined) check(given, '', 'appendOnly', 'array')
  const owners = [] // {file, row}: a file two lanes share (x and ./x, or a folder and a file in it) must be appendOnly: their edits would conflict at the land
  for (const lane of given.lanes) {
    for (const file of lane.files) {
      const clash = owners.find((owner) => pathsOverlap(owner.file, file))
      if (clash && !(given.appendOnly ?? []).includes(file)) throw new Error(`${name}: lanes ${clash.row} and ${lane.row} both list ${clash.file === file ? file : `${clash.file} and ${file}`}: split the lanes or add it to args.appendOnly`)
      if (!clash) owners.push({ file, row: lane.row })
    }
  }
  function pathsOverlap(first, second) {
    const [a, b] = [first, second].map((path) => path.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, ''))
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
  }

  function checkContract(lane, at) {
    for (const [key, type] of Object.entries({ principles: 'array', checkpoints: 'array', addClasses: 'array' })) if (lane[key] !== undefined) check(lane, `lanes[${at}].`, key, type)
    ;(lane.principles ?? []).forEach((principle, index) => ['id', 'question'].forEach((key) => check(principle, `lanes[${at}].principles[${index}].`, key, 'string')))
    ;(lane.checkpoints ?? []).forEach((checkpoint, index) => {
      const path = `lanes[${at}].checkpoints[${index}].`
      for (const [key, type] of Object.entries({ id: 'string', run: 'string', exit: 'number', files: 'array', kind: 'string' })) check(checkpoint, path, key, type)
      if (checkpoint.kind !== 'red-first' && checkpoint.kind !== 'keeps-working') throw new Error(`${name}: args.${path}kind must be red-first or keeps-working`)
      const shared = checkpoint.files.filter((file) => lane.files.some((own) => pathsOverlap(own, file)))
      if ((lane.checkpoints ?? []).findIndex((other) => other.id === checkpoint.id) !== index) throw new Error(`${name}: args.${path}id ${checkpoint.id} is used twice in the lane: checkpoint ids are unique`)
      if (shared.length > 0) throw new Error(`${name}: args.${path}files lists ${shared.join(', ')} of its own lane: checkpoint ${checkpoint.id} files are locked, a lane never edits them`)
    })
  }
}
