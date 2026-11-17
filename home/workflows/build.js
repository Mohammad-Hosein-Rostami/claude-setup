// build: implement lanes in parallel worktrees, join, review, land. Per lane: implementer (and a test-writer when acceptanceTests) in
// isolated worktrees, a runner Join (cherry-pick the test commits, run the related tests, close the implement row, start the close row),
// the `review` child (landing review with fixes), then a serial land queue through the `land` child. Lane A lands while lane B is still in review.
// Args: { base, repo, suite, writers, statusFile, scriptsDir, lanes: [{ row, closeRow, branch, spec, files, acceptanceTests, implementer:
//   { agentType?, model, effort }, matrix? }] }  (matrix: the coverage matrix path, or `none: <reason of 15+ characters>`, required when the implementer is a
//   ui-implementer: the UI brief gate of agent-model-guard does not fire for a workflow spawn; scriptsDir: the folder holding review.js and land.js; writers: writer agents at once, across lanes).
// Returns: { lanes: [{ row, closeRow, status, sha, text, findings?, optional? }], leadList } with status landed | implementer-stopped | wrong-branch |
//   join-failed | review-<status of the review> | lead-decision | failed (land said so); the lead reads text and decides.
//   lead-decision: the review is clean but a security finding was ruled not real by a weaker check or the judge: the lane is held, never landed, until
//   the lead rules (sha is the reviewed tip to land with wf-land). findings and optional (kept only when not empty) are the review's own lists.
// Landing: land gets the reviewed tip and refuses a branch that is not at it. wrong-branch: an agent returned a branch other than the lane's.
// Writers of one lane's fixes run one at a time inside `review`; `writers` bounds the build agents of all lanes, so fix agents (one per lane at
// most) are not counted in it. Branch rule: a lane's agent renames its throwaway worktree branch to the lane branch; a re-done lane (the branch exists) continues
// that branch instead (remove the old worktree, switch, rebase, delete the throwaway branch).
// Scripts cannot import, so checkArgs and the limiter are repeated where needed (home/workflows/README.md).
export const meta = {
  name: 'build',
  description: 'Implement lanes in parallel worktrees, join, review with fixes, land one lane at a time',
  whenToUse: 'A spec or plan split into lanes (files, acceptance) that must be built, reviewed and landed on the base branch',
  phases: [
    { title: 'Build', detail: 'implementer and test-writer per lane, each in its own worktree' },
    { title: 'Join', detail: 'cherry-pick the test commit, related tests, close the implement row' },
    { title: 'Review', detail: 'review child: lenses, verifiers, fixes, delta rounds, landing suite' },
    { title: 'Land', detail: 'land child, one lane at a time; conflicts and changed patches go back to review' },
  ],
}
checkArgs(args)

const RUNNER = { agentType: 'runner', model: 'haiku', effort: 'low' }
const TEST_WRITER = { agentType: 'test-writer', model: 'sonnet', effort: 'medium' }
const STATUS = 'node ~/.claude/tools/status/status.mjs'
const str = { type: 'string' }
const IMPLEMENTED = {
  type: 'object',
  properties: { branch: str, worktree: str, sha: str, tests: { type: 'object' }, tier: { type: 'object' } },
  required: ['branch', 'worktree', 'sha', 'tests'],
}
const TESTS_WRITTEN = { type: 'object', properties: { branch: str, worktree: str, sha: str }, required: ['branch', 'worktree', 'sha'] }
const JOINED = { type: 'object', properties: { red: { type: 'boolean' }, tail: str, sha: str, worktree: str }, required: ['red', 'tail', 'sha', 'worktree'] }
const leadList = []
// Worktree paths agents return go into later shell commands (a worktree remove, a cherry-pick): only a plain absolute path passes (N1).
// An absolute POSIX path or a Windows drive path (C:/x or C:\x); no spaces, quotes, `$`, `;` or `%`.
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
  + `Last run \`node ~/.claude/tools/review-tier/review-tier.mjs ${args.base}...HEAD --landing --json\` and return IMPLEMENTED: branch (must be ${lane.branch}), worktree (your pwd), sha (HEAD), tests {cmd, exit}, tier (that JSON).`
const testWriterPrompt = (lane) => `${standingRulesLine}Write the acceptance tests of lane ${lane.row} from the spec ${lane.spec} (files: ${lane.files.join(', ')}): test files only, each test fails without the behaviour it checks. `
  + `Your worktree starts on a throwaway branch (named worktree-...): rename it with \`git branch -m ${testBranch(lane)}\`. Commit; never merge, never push. Return branch, worktree (your pwd), sha (HEAD).`
const joinPrompt = (lane, built, written) => `Join lane ${lane.row} in its worktree ${built.worktree} (branch ${lane.branch}).\n`
  + `${written ? `Cherry-pick the test commit(s) of ${written.branch} (worktree ${written.worktree}, sha ${written.sha}) onto the lane, then delete the helper branch ${written.branch} and its worktree.\n` : ''}`
  + `Run the related tests for the lane's changed files with the repo's own command (e.g. node scripts/affected-tests.mjs --base ${args.base} --run, vitest related --run, jest --findRelatedTests) and report red true when any fail, with the failing lines in tail.\n`
  + `Then update the rows: ${STATUS} --file ${args.statusFile} done ${lane.row} "implemented ${lane.branch}; related tests green or red as you found them" and ${STATUS} --file ${args.statusFile} start ${lane.closeRow}. Return red, tail, sha (HEAD of the lane), worktree.`
const testBranch = (lane) => `${lane.branch}--tests`
const reviewArgs = (lane, worktree, extra = {}) => ({ row: lane.closeRow, repo: args.repo, base: args.base, range: `${args.base}...${lane.branch}`, landing: true, fix: true, branch: lane.branch, worktree, suite: args.suite, ...extra })
const finding = (id, file, problem, fix) => ({ id, severity: 'blocking', file, line: 0, problem, fix, security: false })

const outcome = (lane, status, sha = '', text = '', extra = {}) => ({ row: lane.row, closeRow: lane.closeRow, status, sha, text, ...extra })
// The review's own lists travel with the lane's outcome, so a finding of a failed review or an optional one is never lost.
const listsOf = (reviewed) => ({ ...(reviewed.findings?.length > 0 ? { findings: reviewed.findings } : {}), ...(reviewed.optional?.length > 0 ? { optional: reviewed.optional } : {}) })
const heldForLead = (lane, reviewed) => outcome(lane, 'lead-decision', reviewed.tip,
  `security findings ruled not real by a weaker check, so the lane is held: ${reviewed.leadList.map((item) => `${item.id} ${item.file}:${item.line} (${item.reason})`).join('; ')}. Land with wf-land at tip ${reviewed.tip} only after the lead rules.`, listsOf(reviewed))
const reviewChild = async (lane, extra) => {
  const reviewed = await workflow({ scriptPath: `${args.scriptsDir}/review.js` }, extra)
  leadList.push(...(reviewed.leadList ?? []))
  return reviewed
}

async function buildLane(lane) {
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
  return { lane, joined }
}

async function reviewLane(step) {
  if (step.status) return step
  const { lane, joined } = step
  const initialFindings = joined.red ? [finding(`join-${lane.row}`, '(tests)', `related tests are red after the join: ${joined.tail}`, 'make the related tests pass')] : []
  const reviewed = await reviewChild(lane, reviewArgs(lane, joined.worktree, initialFindings.length > 0 ? { initialFindings } : {}))
  if (reviewed.status !== 'clean') return outcome(lane, `review-${reviewed.status}`, reviewed.tip, reviewed.text, listsOf(reviewed))
  if ((reviewed.leadList ?? []).length > 0) return heldForLead(lane, reviewed)
  return { lane, reviewed }
}

async function landLane(step) {
  if (step.status) return step
  const { lane } = step
  let reviewed = step.reviewed
  while (true) {
    const landed = await inLandQueue(() => workflow({ scriptPath: `${args.scriptsDir}/land.js` }, { row: lane.closeRow, closeRow: lane.closeRow, statusFile: args.statusFile, repo: args.repo, base: args.base, branch: lane.branch, worktree: reviewed.worktree, suite: args.suite, tip: reviewed.tip }))
    if (landed.status === 'landed') return outcome(lane, 'landed', landed.sha, '', listsOf(reviewed))
    if (landed.status === 'failed') return outcome(lane, 'failed', landed.sha, landed.tidy)
    // conflict: the conflict is a finding the fix agent resolves while rebasing; needs-review: the rebase changed patches, so review the delta
    const conflict = landed.status === 'conflict' ? { initialFindings: [finding(`conflict-${lane.row}`, landed.tidy, `rebasing ${lane.branch} onto ${args.base} conflicts in ${landed.tidy}`, `resolve the conflicts keeping both intents while rebasing onto ${args.base}`)] } : {}
    reviewed = await reviewChild(lane, reviewArgs(lane, reviewed.worktree, { deltaOf: reviewed.tip, laneClasses: reviewed.tierFile, ...conflict }))
    if (reviewed.status !== 'clean') return outcome(lane, `review-${reviewed.status}`, reviewed.tip, reviewed.text, listsOf(reviewed))
    if ((reviewed.leadList ?? []).length > 0) return heldForLead(lane, reviewed)
  }
}

phase('Build')
const lanes = await pipeline(args.lanes, buildLane, joinLane, reviewLane, landLane)
return { lanes: lanes.map((entry, at) => entry ?? outcome(args.lanes[at], 'failed', '', 'the lane stopped on an error')), leadList }

function checkArgs(given) {
  const name = 'build' // the tool cuts `meta` out of the body, so the script's own name is written here
  const typeName = (type) => (type === 'array' ? 'an array' : `a ${type}`)
  const check = (holder, path, key, type) => {
    const value = holder === undefined || holder === null ? undefined : holder[key]
    const ok = type === 'array' ? Array.isArray(value) : typeof value === type
    if (!ok) throw new Error(`${name}: args.${path}${key} must be ${typeName(type)}`)
  }
  const required = { base: 'string', repo: 'string', suite: 'string', writers: 'number', statusFile: 'string', scriptsDir: 'string', lanes: 'array' }
  for (const [key, type] of Object.entries(required)) check(given, '', key, type)
  given.lanes.forEach((lane, at) => {
    const laneKeys = { row: 'string', closeRow: 'string', branch: 'string', spec: 'string', files: 'array', acceptanceTests: 'boolean', implementer: 'object' }
    for (const [key, type] of Object.entries(laneKeys)) check(lane, `lanes[${at}].`, key, type)
    for (const key of ['model', 'effort']) check(lane.implementer, `lanes[${at}].implementer.`, key, 'string')
    if (lane.implementer.agentType === 'ui-implementer') {
      const usable = typeof lane.matrix === 'string' && (lane.matrix.startsWith('none:') ? lane.matrix.slice('none:'.length).trim().length >= 15 : lane.matrix.trim() !== '')
      if (!usable) throw new Error(`${name}: args.lanes[${at}].matrix must be a coverage matrix path or \`none: <reason of 15+ characters>\` for a ui-implementer`)
    }
  })
}
