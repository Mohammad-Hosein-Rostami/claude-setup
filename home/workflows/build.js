// build: implement lanes in parallel worktrees, join, review, land. Per lane: the `implement` child (implementer, with a hand-over to a fresh agent
// from the branch tip when it ends early; a test-writer when acceptanceTests), the `join` child (test commits, checkpoints, related tests, rows,
// contract verdict), the `review` child (landing review with fixes), the `visual-qa` child for a lane whose UI files changed (a FAIL goes to a fix
// round with ui-implementer, then the gate again; also after `land` returns `ui-proof`), then a serial land queue through the `land` child.
// Args: { base, repo, suite, writers, statusFile, scriptsDir, appendOnly?, resume?, probeC?: 'pass'|'fail', lanes: [{ row, closeRow, branch, spec, files,
//   acceptanceTests, implementer: { agentType?, model, effort }, matrix?, principles?, checkpoints?, addClasses? }], checks? } (workflows skill, section build). checkArgs throws,
//   naming the key and the shape, on a file two lanes share outside appendOnly, a checkpoint over its own lane's files, a repeated checkpoint id, or a
//   ui-implementer lane with no matrix. probeC 'fail' (phase 0 Probe C) refuses a lane whose UI files change (UI_REFUSAL).
// Returns: { lanes: [{ row, closeRow, status, sha, text, findings?, optional?, audit? }], leadList }, status landed | implementer-stopped | wrong-branch |
//   join-failed | contract-touched | review-<status> | lead-decision (a security finding held for the lead) | ui-refused | visual-qa-failed | failed |
//   audit-findings | audit-error (landed; the audit-log gate keeps sync and push closed, unless the text says "gate holds nothing").
//   resume: true after a stop that lost the journal: a lane whose close row STATUS.md shows landed is not built again.
// `writers` bounds the build agents of all lanes; the start refuses a session off the base checkout, a writer's wrongBase fails its lane. Scripts cannot import, so checkArgs and the limiter are repeated (home/workflows/README.md, which
// describes every stage).
export const meta = {
  name: 'build',
  description: 'Implement lanes in parallel worktrees, join, review with fixes, land one lane at a time',
  whenToUse: 'A spec or plan split into lanes (files, acceptance) that must be built, reviewed and landed on the base branch',
  phases: [
    { title: 'Build', detail: 'implementer and test-writer per lane, each in its own worktree' },
    { title: 'Join', detail: 'join child: cherry-pick the test commit, checkpoints, related tests, close the implement row' },
    { title: 'Review', detail: 'review child: lenses, verifiers, fixes, delta rounds, landing suite' },
    { title: 'Visual QA', detail: 'visual-qa child on a lane whose UI files changed; a FAIL goes to a ui-implementer fix round' },
    { title: 'Land', detail: 'land child, one lane at a time; conflicts, a red suite and changed patches go back to review' },
    { title: 'Audit', detail: 'after the land, a waived lane: audit-log record, review child in audit mode on B..T, audit-log done' },
  ],
}
checkArgs(args)

// The owner's /check categories (args.checks, set by workflow-script-check; none = every check off, spec r9-checks-off): the test-writer runs
// only with `test`, the Review stage and the post-land audit only with `review`, the Visual QA stage only with `ui`; children get the list.
// Off, a lane goes build -> join -> land (rebase, ff-only, prune) and its text says "not checked: <categories>".
const CHECKS = Array.isArray(args.checks) ? args.checks.filter((name) => /^[a-z]+$/.test(name)) : []
const checkOn = (category) => CHECKS.includes(category)
const NOT_CHECKED = ['test', 'review', 'ui'].filter((category) => !checkOn(category))

const RUNNER = { agentType: 'runner', model: 'haiku', effort: 'medium' }
const STATUS = 'node ~/.claude/tools/status/status.mjs'
const [str, num, bool, strings] = [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'array', items: { type: 'string' } }]
const shape = (properties, required) => ({ type: 'object', properties, required })
const AUDIT_DECISION = shape({ recordExit: num, shouldExit: num, audit: bool, reason: str, tail: str }, ['recordExit', 'shouldExit', 'audit'])
const AUDIT_PREPARED = shape({ ancestor: bool, changedLines: num, worktree: str, tail: str }, ['ancestor', 'changedLines', 'worktree'])
const AUDIT_RECORDED = shape({ exit: num, tail: str }, ['exit'])
const AUDIT_LOG = 'node ~/.claude/tools/review-tier/audit-log.mjs'
const AUDIT_NOT_RECORDED = 'audit not recorded: gate holds nothing' // the prefix of land.js's failure text when its pending audit record failed
const GIT_SHA = /^[0-9a-f]{7,40}$/ // shas go into runner commands: only hex passes
const DISK_CHECKED = shape({ exit: num, tail: str, baseTip: str, sessionBranch: str, sessionHead: str }, ['exit', 'tail', 'sessionBranch', 'sessionHead'])
const FULL_SHA = /^[0-9a-f]{40}$/
// The tips of the base branch this build saw itself: the tip when it started and the sha each of its own lands returned. A review child may move a
// lane's start only to one of these (review.js, D7): a base ref moved by anyone else names a commit that no review of this build has read.
const baseTips = []
const recordBaseTip = (sha) => { if (FULL_SHA.test(sha ?? '') && !baseTips.includes(sha)) baseTips.push(sha) }
const LANDED_ROW = shape({ landed: bool, sha: str }, ['landed', 'sha'])
const UI_REFUSAL = 'Probe C failed (hooks do not fire in workflow agents), so this lane, whose UI files change, is refused: UI lanes run as plain agents (spec-stages section 1)'
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

const testBranch = (lane) => `${lane.branch}--tests`
const contractArgs = (lane) => ({ spec: lane.spec, ...(lane.checkpoints ? { checkpoints: lane.checkpoints } : {}), ...(lane.principles ? { principles: lane.principles } : {}), ...(lane.addClasses ? { addClasses: lane.addClasses } : {}) })
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
// A review result that stops the lane: not clean, or clean with a security finding held for the lead. Null when the lane goes on.
const reviewStop = (lane, reviewed) => {
  if (reviewed.status !== 'clean') return outcome(lane, `review-${reviewed.status}`, reviewed.tip, reviewed.text, listsOf(reviewed))
  return (reviewed.leadList ?? []).length > 0 ? heldForLead(lane, reviewed) : null
}
const reviewChild = async (lane, extra) => {
  const reviewed = await workflow({ scriptPath: `${args.scriptsDir}/review.js` }, { checks: CHECKS, ...extra })
  leadList.push(...(reviewed.leadList ?? []))
  return reviewed
}

// resume: the state of the world beats the script's memory. A lane landed before the stop is found in STATUS.md (land.js records `landed <sha>` on the close row).
const landedBeforeStop = async (lane) => {
  const row = await agent(`Read ${args.statusFile} (change nothing): find the Work items row with id ${lane.closeRow}. Report landed true only when its done cell is not empty and its evidence says "landed"; sha = the sha its evidence names after "landed", else "".`,
    { label: `${lane.row}:resumed`, phase: 'Build', schema: LANDED_ROW, ...RUNNER })
  return row?.landed === true ? outcome(lane, 'landed', row.sha, 'already landed: STATUS.md shows the close row done (found on restart)') : null
}

// The `implement` child writes one lane's code (with the hand-over to a fresh agent when it ends early) or its acceptance tests: one writer slot each.
const writerChild = (lane, role) => workflow({ scriptPath: `${args.scriptsDir}/implement.js` }, { checks: CHECKS, role, row: lane.row, branch: lane.branch, base: args.base, spec: lane.spec, files: lane.files, statusFile: args.statusFile,
  acceptanceTests: lane.acceptanceTests, model: lane.implementer.model, effort: lane.implementer.effort, ...Object.fromEntries(['matrix', 'checkpoints', 'principles'].filter((key) => lane[key] !== undefined).map((key) => [key, lane[key]])),
  ...(lane.implementer.agentType ? { agentType: lane.implementer.agentType } : {}), ...(baseTips[0] ? { baseSha: baseTips[0] } : {}) })

async function buildLane(lane) {
  if (args.resume === true) {
    const already = await landedBeforeStop(lane)
    if (already !== null) return already
  }
  const implement = limitedWriter(() => writerChild(lane, 'implement'))
  const withTests = lane.acceptanceTests && checkOn('test') // the acceptance test-writer is a `test` check
  const tests = withTests ? limitedWriter(() => writerChild(lane, 'tests')) : Promise.resolve(null)
  const [built, written] = await parallel([() => implement, () => tests])
  if (built === null || (withTests && written === null)) return outcome(lane, 'implementer-stopped', '', 'a build agent was stopped before it returned')
  const wrong = [built, written].find((report) => report?.wrongBase)
  if (wrong) return outcome(lane, 'failed', '', `${wrong.wrongBase}: the agent's worktree started on another commit, so its work is not counted (keep the session on the base checkout for the whole run)`)
  // An agent that stays on another branch would have its work reviewed under one name and landed under another (B1).
  if (built.branch !== lane.branch) return outcome(lane, 'wrong-branch', built.sha, `the implementer is on branch ${built.branch}, not ${lane.branch}: the lane was not joined or landed`)
  if (!SAFE_PATH.test(built.worktree) || (written !== null && !SAFE_PATH.test(written.worktree))) return outcome(lane, 'failed', built.sha, `a build agent returned a worktree path that is not a plain absolute path: ${built.worktree}${written ? `, ${written.worktree}` : ''}`)
  if (written !== null && written.branch !== testBranch(lane)) return outcome(lane, 'wrong-branch', written.sha, `the test-writer is on branch ${written.branch}, not ${testBranch(lane)}: the lane was not joined or landed`)
  return { lane, built, written }
}

async function joinLane(step) {
  if (step.status) return step
  const { lane, built, written } = step
  const result = await workflow({ scriptPath: `${args.scriptsDir}/join.js` }, { checks: CHECKS, row: lane.row, closeRow: lane.closeRow, branch: lane.branch, base: args.base, files: lane.files, statusFile: args.statusFile,
    worktree: built.worktree, sha: built.sha, disputes: built.disputes ?? [], ...(lane.checkpoints ? { checkpoints: lane.checkpoints } : {}), ...(written ? { written: { branch: written.branch, worktree: written.worktree, sha: written.sha } } : {}) })
  if (result === null || result.status !== 'joined') return outcome(lane, result?.status ?? 'join-failed', result?.sha ?? built.sha, result?.text ?? 'the join child returned nothing')
  return { lane, built, written, joined: result.joined, contract: { findings: result.findings, waiverAt: result.waiverAt } }
}

async function reviewLane(step) {
  if (step.status) return step
  const { lane, built, joined, contract } = step
  // A dispute asks the lead to rule on a locked file: the fix agent cannot edit it, so it is no finding of the review (the lane's waiver is blocked above).
  leadList.push(...(built.disputes ?? []).map((line, at) => ({ id: `dispute-${lane.row}-${at}`, file: '(contract)', line: 0, reason: `implementer dispute, unresolved: ${line}` })))
  if (!checkOn('review')) return notReviewed(step)
  const initialFindings = [...(joined.red ? [finding(`join-${lane.row}`, '(tests)', `related tests are red after the join: ${joined.tail}`, 'make the related tests pass')] : []), ...contract.findings]
  const reviewed = await reviewChild(lane, reviewArgs(lane, joined.worktree, { ...(initialFindings.length > 0 ? { initialFindings } : {}), ...(contract.waiverAt ? { waiverAt: contract.waiverAt } : {}) }))
  if (args.probeC === 'fail' && joined.uiFiles.length > 0) return outcome(lane, 'ui-refused', reviewed.tip, UI_REFUSAL)
  return reviewStop(lane, reviewed) ?? { lane, reviewed, uiFiles: joined.uiFiles, waived: reviewed.waived === true && contract.waiverAt !== undefined }
}

/** The Review stage with `review` off: the joined tip goes on as it is (no waiver, so no audit); the UI gate runs only with `ui` on. */
function notReviewed({ lane, joined }) {
  const tip = joined.sha ?? ''
  if (args.probeC === 'fail' && joined.uiFiles.length > 0 && checkOn('ui')) return outcome(lane, 'ui-refused', tip, UI_REFUSAL)
  return { lane, reviewed: { status: 'clean', tip, worktree: joined.worktree, baseSha: '', laneClasses: [], findings: [], optional: [], leadList: [] }, uiFiles: checkOn('ui') ? joined.uiFiles : [], waived: false }
}

// For the audit stage, by lane row: the LAST review's base and tip (the range B..T), the landed sha (the gate key), whether the land loop reviewed again.
const auditInputs = new Map()

async function landLane(step) {
  if (step.status) return step
  const { lane, waived, uiFiles } = step // waived: the FIRST review's verdict, kept even when land-loop delta reviews follow
  let [reviewed, escalated, gate] = [step.reviewed, false, uiFiles.length > 0] // escalated: the land loop reviewed again; gate: visual-qa before this land
  while (true) {
    if (gate) {
      const gated = await visualGate(lane, reviewed, uiFiles)
      if (gated.stop) return gated.stop
      escalated = escalated || gated.reviewed !== reviewed
      reviewed = gated.reviewed
    }
    // A waived lane lands without its Opus pair: land.js records it `pending` right after the ff-only land, so a stopped audit runner cannot leave the gate open.
    // A base that is not a sha cannot be recorded: land.js then lands and says "audit not recorded" (audit-error below), never silently.
    const pending = waived ? { auditPending: true, auditBase: String(reviewed.baseSha ?? '') } : {}
    const landed = await inLandQueue(() => workflow({ scriptPath: `${args.scriptsDir}/land.js` }, { checks: CHECKS, row: lane.closeRow, closeRow: lane.closeRow, statusFile: args.statusFile, repo: args.repo, base: args.base, branch: lane.branch, worktree: reviewed.worktree, suite: args.suite, tip: reviewed.tip, ...pending }))
    if (landed.status === 'landed') {
      recordBaseTip(landed.sha)
      if (waived) auditInputs.set(lane.row, { lane, baseSha: reviewed.baseSha, tip: reviewed.tip, landedSha: landed.sha, escalated })
      return outcome(lane, 'landed', landed.sha, NOT_CHECKED.length > 0 ? `not checked: ${NOT_CHECKED.join(', ')}` : '', listsOf(reviewed))
    }
    // With `review` off there is no fix round: a conflict or a red suite goes back to the lead as it is.
    if (!checkOn('review') && ['conflict', 'red', 'needs-review'].includes(landed.status)) return outcome(lane, landed.status, landed.sha, `${landed.tidy} (review is off, so no fix round ran)`)
    // "audit not recorded" (land.js): the lane landed, but the gate holds nothing for it; audit-error with "gate holds nothing" says to audit by hand.
    if (landed.status === 'failed') return outcome(lane, waived && String(landed.tidy).startsWith(AUDIT_NOT_RECORDED) ? 'audit-error' : 'failed', landed.sha, landed.tidy)
    // ui-proof: the rebased tip has no visual-qa PASS: the gate judges that tip, never a review alone, then the lane lands again
    gate = landed.status === 'ui-proof'
    if (gate) { reviewed = { ...reviewed, tip: landed.sha }; continue }
    // conflict: the conflict is a finding the fix agent resolves while rebasing; red: the suite failed at the rebased tip, the fix agent repairs it; needs-review: the rebase changed patches, so review the delta
    const initialFindings = { conflict: [finding(`conflict-${lane.row}`, landed.tidy, `rebasing ${lane.branch} onto ${args.base} conflicts in ${landed.tidy}`, `resolve the conflicts keeping both intents while rebasing onto ${args.base}`)],
      red: [finding(`red-${lane.row}`, '(suite)', `suite red at the rebased tip: ${landed.tidy}`, `make the full suite pass at the rebased tip of ${lane.branch}`)] }[landed.status]
    escalated = true
    reviewed = await reviewChild(lane, reviewArgs(lane, reviewed.worktree, { deltaOf: reviewed.tip, laneClasses: reviewed.laneClasses, ...startRecord(reviewed), ...(initialFindings ? { initialFindings } : { priorFindings: [] }), ...(uiFiles.length > 0 ? { fixer: uiFixer(lane) } : {}) })) // needs-review: the lane's last review was clean, so there is no finding to carry; the empty list is on purpose (review.js refuses deltaOf without it)
    const stop = reviewStop(lane, reviewed)
    if (stop) return stop
    gate = uiFiles.length > 0 // the fixes changed the tree, so it is judged again
  }
}

// The fix agent of a lane with UI files is the UI writer (it runs the ui-check loop), not review.js's default implementer.
const uiFixer = (lane) => ({ agentType: 'ui-implementer', matrix: lane.matrix ?? 'none: visual-qa made the matrix for this lane' })

/** Runs the visual-qa child on reviewed.tip until it passes; a FAIL is a delta fix round of the lane's UI writer. Returns { reviewed } or { stop: outcome }. */
async function visualGate(lane, reviewed, uiFiles) {
  if (args.probeC === 'fail') return { stop: outcome(lane, 'ui-refused', reviewed.tip, UI_REFUSAL) }
  let current = reviewed
  for (;;) {
    const checked = await workflow({ scriptPath: `${args.scriptsDir}/visual-qa.js` }, { checks: CHECKS, row: lane.row, repo: args.repo, worktree: current.worktree, tip: current.tip, base: args.base, uiFiles, ...(lane.matrix ? { matrix: lane.matrix } : {}) })
    if (checked?.status === 'pass') return { reviewed: current }
    if (checked?.status !== 'fail') return { stop: outcome(lane, 'visual-qa-failed', current.tip, checked?.text ?? 'the visual-qa child returned nothing', listsOf(current)) }
    const initialFindings = checked.findings.map((item, at) => finding(`vqa-${lane.row}-${at}`, item.file, item.problem, item.fix))
    current = await reviewChild(lane, reviewArgs(lane, current.worktree, { deltaOf: current.tip, laneClasses: current.laneClasses, ...startRecord(current), initialFindings, fixer: uiFixer(lane) }))
    const stop = reviewStop(lane, current)
    if (stop) return { stop }
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
  const record = (state, more = '') => `${AUDIT_LOG} record --repo ${args.repo} --tip ${landedSha} --base ${baseSha} --reviewed ${tip} --state ${state}${more}`
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
    const errorRecord = await auditStep('error', AUDIT_RECORDED, `In ${args.repo} run: ${refusedWorktree}${record('error')}. Report exit and tail.`)
    const recordedAs = errorRecord !== null && errorRecord.exit === 0 ? 'recorded as error' : 'the error record could not be written, so the record stays pending (land.js wrote it) and sync and push stay closed'
    return failedAudit(`the audit range ${baseSha}..${tip} cannot be audited (${prepared === null ? 'the prepare runner was stopped' : JSON.stringify(prepared)}); ${recordedAs}, an empty range is never clean`)
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
  const disk = await agent(`Run: node ~/.claude/tools/disk-free/disk-free.mjs check. Then run: git -C ${args.repo} rev-parse --verify ${FULL_SHA.test(args.base) ? args.base : `refs/heads/${args.base}`}. Then, in your own working folder (the session's checkout), run git rev-parse --abbrev-ref HEAD and git rev-parse HEAD. Do not change anything. Report exit (the first command's exit code), tail (its one output line, whole), baseTip (the full 40-character sha the second command printed, "" when it failed), sessionBranch and sessionHead (the last two outputs, "" when they failed).`, { label: `${args.lanes[0].row}:disk`, phase: 'Build', schema: DISK_CHECKED, ...RUNNER })
  const offBase = disk !== null && (disk.sessionHead !== disk.baseTip || (!FULL_SHA.test(args.base) && disk.sessionBranch !== args.base)) // isolated agents start at the session's HEAD
  const refusal = disk === null ? 'the disk check runner was stopped' : disk.exit !== 0 ? `disk space check refused the build: ${disk.tail}` : offBase ? `the session's checkout is on ${disk.sessionBranch || '(no git folder)'} at ${disk.sessionHead || '-'}, not on ${args.base} at ${disk.baseTip || '-'}: start the build from the base checkout and keep it there for the whole run` : ''
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
  if (given.probeC !== undefined && given.probeC !== 'pass' && given.probeC !== 'fail') throw new Error(`${name}: args.probeC must be 'pass' or 'fail' (the phase 0 Probe C result)`)
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
