// review: review a lane the way the setup's rules say, as a pipeline, then fix what the reviews confirm and review the fixes again until a round
// is clean. Lenses come from review-tier (classes, models, efforts, stress and mutation plans); the script adds nothing and removes nothing.
// Args: { row, repo, base, range, landing, fix, branch, worktree, suite, tier?, addClasses?, laneClasses?, deltaOf?, initialFindings? }
//   suite: the repo's declared full-suite command (test-pass runs it as `run --suite`, never from this text);
//   tier: review-tier JSON from the lead to use for round 0 instead of running the tool; laneClasses: file of an earlier round's tier JSON (classes and
//   plans are kept, I4); deltaOf: a sha already reviewed (round 0 reviews only what changed since); initialFindings: findings that are
//   confirmed already (red tests after a join, a rebase conflict) and go to the fix queue first; fix:false only reports.
// Returns: { status: 'clean'|'findings'|'incomplete'|'failed', rounds, tip (the reviewed sha: land only that), worktree (the lane's worktree after the
//   fixes), tierFile, suite, findings, optional, leadList, text } (a `clean` status means every required lens and verdict of the last round is in,
//   none confirmed anything, and with `landing` the suite passed at tip).
// Review set: a runner recomputes it with review-tier every round (with every --add-class and the lane's classes); the fix agent never supplies it.
//   A run whose tier did not exit 0, has no `reviews` list, or (with `landing`) has an empty one and nothing carried over is `failed`, never clean.
// Rules kept here (spec round 4, I2 and I3): a verifier is as strong as its finder; its `real: false` drops a finding only when it is at least
// as strong and the finding is not security, else an Opus-max judge rules; a security finding the judge calls not real goes to leadList with
// the reason; a finding whose lines a fix already moved is carried into the next round as an open item, never judged at a newer HEAD.
// Worktrees (an isolated agent cannot run git in another agent's worktree): reviewers read a detached worktree at the reviewed sha, a runner
// releases (removes) the lane worktree before each fix, and the isolated fix agent switches to the lane branch itself.
// Scripts cannot import, so checkArgs is repeated in each script (home/workflows/README.md).
export const meta = {
  name: 'review',
  description: 'Tiered review of a lane as a pipeline: lenses, verifiers, serial fixes, delta rounds until clean',
  whenToUse: 'A lane or branch needs its review set (review-tier) with fixes and re-reviews, before landing',
  phases: [
    { title: 'Tier', detail: 'review-tier set, review worktree at the reviewed sha' },
    { title: 'Review', detail: 'one agent per lens, at the lens model and effort' },
    { title: 'Verify', detail: 'Sonnet-high verifiers per 5 findings; an Opus-max judge for what a weaker verdict would drop' },
    { title: 'Fix', detail: 'serial fix queue in the lane; deep-debugger when a file blocks twice in a row' },
  ],
}
checkArgs(args)

const RUNNER = { agentType: 'runner', model: 'haiku', effort: 'low' }
const FINDINGS_PER_VERIFIER = 5
const MODEL_RANK = { haiku: 0, sonnet: 1, opus: 2 }
const EFFORT_RANK = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 }
// Verifiers are Sonnet high for every lens: fast and cheap. A finding of a stronger lens (Opus) that this verifier calls not real is ruled by the
// Opus-max judge, never dropped (I2), so no accuracy is lost; a finding the verifier confirms goes to the fix queue at once.
const VERIFIER = { model: 'sonnet', effort: 'high' }
const DEFAULT_ORIGIN = { agent: 'reviewer', model: 'sonnet', effort: 'high', lens: 'correctness' }
const str = { type: 'string' }
const FINDING = {
  type: 'object',
  properties: { id: str, severity: { type: 'string', enum: ['blocking', 'should-fix', 'optional'] }, file: str, line: { type: 'number' }, problem: str, fix: str, security: { type: 'boolean' } },
  required: ['id', 'severity', 'file', 'line', 'problem', 'fix', 'security'],
}
const FINDINGS = { type: 'object', properties: { findings: { type: 'array', items: FINDING }, verified: str }, required: ['findings', 'verified'] }
const VERDICT = {
  type: 'object',
  properties: { id: str, real: { type: 'boolean' }, why: str, reviewedSha: str, linesMoved: { type: 'boolean' } },
  required: ['id', 'real', 'why', 'reviewedSha', 'linesMoved'],
}
const VERDICTS = { type: 'object', properties: { verdicts: { type: 'array', items: VERDICT } }, required: ['verdicts'] }
const JUDGED = { type: 'object', properties: { id: str, real: { type: 'boolean' }, why: str }, required: ['id', 'real', 'why'] }
const PREPARED = { type: 'object', properties: { exit: { type: 'number' }, sha: str, reviewWorktree: str, tierFile: str, tier: { type: 'object' } }, required: ['exit', 'sha', 'reviewWorktree', 'tierFile', 'tier'] }
const IMPLEMENTED = {
  type: 'object',
  properties: { branch: str, worktree: str, sha: str, tests: { type: 'object' }, deferred: { type: 'array', items: str } },
  required: ['branch', 'worktree', 'sha', 'tests', 'deferred'],
}
const RUN = { type: 'object', properties: { exit: { type: 'number' }, tail: str }, required: ['exit', 'tail'] }

const atLeast = (a, b) => MODEL_RANK[a.model] > MODEL_RANK[b.model] || (a.model === b.model && EFFORT_RANK[a.effort] >= EFFORT_RANK[b.effort])
const slug = (text) => String(text).replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '')
const specOf = (review) => ({ model: review.model ?? 'sonnet', effort: review.effort ?? 'high' })
const originOf = (review) => ({ agent: review.agent, model: review.model, effort: review.effort, lens: review.lens })
const sameOrigin = (a, b) => a.agent === b.agent && a.model === b.model && a.effort === b.effort && a.lens === b.lens
const agentTypeOf = (review) => (review.agent === 'security-auditor' ? 'security-auditor' : 'reviewer')
// A review-tier lens with agent `skill` is a skill (ui-quality-pass): the agent must call it, which the read-only reviewer agent cannot.
const SKILL_LENS_AGENT = 'general-purpose'
const lensAgentTypeOf = (review) => (review.agent === 'skill' ? SKILL_LENS_AGENT : agentTypeOf(review))
// Agents return paths, branches and shas that go into later shell commands: only plain values pass (N1).
const SHA = /^[0-9a-f]{7,40}$/
const SAFE_PATH = /^\/[\w@+=.,/-]+$/
const sameSha = (a, b) => a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a))
const runner = (step, phase, prompt, schema = RUN) => agent(`${prompt}\nDo nothing else; report no secrets.`, { label: `${args.row}:${step}`, phase, schema, ...RUNNER })
const itemText = (item) => `- [${item.status ?? item.severity}] ${item.id} ${item.file}:${item.line}: ${item.problem}`
const fixText = (item) => `${itemText(item)}\n  fix: ${item.fix}`
const planText = (plan) => [
  plan?.stress ? `PLAN stress (run it; a full-suite re-run is the one thing not to do): ${JSON.stringify(plan.stress)}` : '',
  plan?.mutation ? `PLAN mutation: at most ${plan.mutation.maxMutants} mutants of changed lines, in a private copy of the worktree.` : '',
].filter(Boolean).join('\n')

// State across rounds. lastFixed: findings fixed in the previous round (their finders re-check them); recheck: findings still open
// (deferred by a fix agent, or moved by a fix) that the next round's lenses judge again.
const run = { round: 0, tip: null, deltaOf: args.deltaOf ?? null, laneClasses: args.laneClasses ?? null, worktree: args.worktree, knownTier: args.tier ?? null, fixShas: [], expectedTip: null }
let lastFixed = []
let recheck = []
let blockingFiles = new Set()
let tierFile = args.laneClasses ?? null
const leadList = []
const optional = []
const outcome = (status, text, extra = {}) => ({ status, rounds: run.round + 1, tip: run.tip, worktree: run.worktree, tierFile, suite: 'none', findings: [], optional, leadList, text, ...extra })

const tierPrompt = (known) => {
  const command = [`node ~/.claude/tools/review-tier/review-tier.mjs ${run.deltaOf ? `--delta ${run.deltaOf}` : args.range}`, args.landing ? '--landing' : '',
    ...(args.addClasses ?? []).map((name) => `--add-class ${name}`), run.laneClasses ? `--lane-classes ${run.laneClasses}` : '', '--json'].filter(Boolean).join(' ')
  const tierFile = `\${TMPDIR:-/tmp}/${slug(args.row)}-tier-<sha8>.json`
  return `Work in ${run.worktree} (lane ${args.branch}, base ${args.base}): cd there first, review-tier reads the git repository of its working folder. The reviewed sha is its HEAD (git rev-parse HEAD).\n`
    + `Add a detached review worktree of that sha outside every repo folder: git -C ${args.repo} worktree add --detach <scratch>/${slug(args.row)}-<sha8> <sha> (<sha8> is the first 8 characters of the sha).\n`
    + `${known ? `Use this review-tier JSON as it is (report exit 0): ${JSON.stringify(known)}` : `Run it from ${run.worktree}: ${command}\nReport its exit code as exit and its JSON output as tier.`}\n`
    + `Write the tier JSON (with its fileClasses) to ${tierFile}. Never write over ${run.laneClasses ?? 'an existing file'}: when the name is taken, add -2, -3 until it is free. `
    + 'Return exit, sha (full 40 characters), reviewWorktree (the new folder), tierFile (that path), tier (the JSON).'
}

const reviewPrompt = (review, sha, reviewWorktree, items) => [
  `Review lane ${args.branch} of ${args.repo} by reading ONLY the detached review worktree ${reviewWorktree} (at ${sha}); ${run.deltaOf ? `the change to review is the delta since ${run.deltaOf}` : `range ${args.range}`}. Never edit it; never run the full suite (a recorded PASS covers it).`,
  review.agent === 'skill' ? `Invoke the ${review.lens} skill with the Skill tool first and follow it on the files of the range; it only reads: edit nothing.` : '',
  `Lens: ${review.lens}. Rules: ${review.rules}`,
  review.brief,
  review.requiredReading?.length ? `Required reading first: ${review.requiredReading.join(', ')}` : '',
  planText(review.plan),
  items.length ? `Items from the last round. fixed: check it is really gone and the fix broke nothing; open: judge whether it is still present at ${sha}, and report it as a finding if it is.\n${items.map(itemText).join('\n')}` : '',
  'Return findings (severity blocking|should-fix|optional; security true for an exploitable or secret/auth/injection/data issue) and, in verified, what you ran or read.',
].filter(Boolean).join('\n')

const fixPrompt = (batch, sha, diagnosis) => `Fix these confirmed findings of lane ${args.branch} (base ${args.base}), in this order:\n${batch.map(fixText).join('\n')}\n`
  + `${diagnosis ? `Root-cause diagnosis (follow it): ${diagnosis}\n` : ''}`
  + `Setup: your worktree starts on a throwaway branch (git branch --show-current, named worktree-...). Run \`git switch ${args.branch} && git rebase ${args.base}\`, then delete the throwaway branch (\`git branch -d <its name>\`). `
  + `If an earlier fix of this round already changed a cited line (git log ${sha}..HEAD -- <file>), do not fix that finding: list its id in deferred. `
  + 'For each fix: read callers and callees of the changed functions first, add a test that fails without it, run related tests only while iterating (quiet reporter), commit after each green step. '
  + `Return IMPLEMENTED: branch (must be ${args.branch}), worktree (your pwd), sha (HEAD), tests, deferred.`

while (true) {
  phase('Tier')
  const knownTier = run.knownTier
  run.knownTier = null
  const prepared = await runner('tier', 'Tier', tierPrompt(knownTier), PREPARED)
  if (prepared === null) return outcome('failed', 'the tier runner was stopped')
  const { sha, reviewWorktree, tier } = prepared
  const tierProblem = problemWithTier(prepared)
  if (tierProblem !== null) return outcome('failed', tierProblem)
  if (args.landing && tier.reviews.length === 0 && recheck.length + lastFixed.length === 0) return outcome('failed', `the landing review set of ${sha} is empty: review-tier gives at least one lens for a landing diff, so the tier was lost`)
  tierFile = prepared.tierFile
  run.tip = sha
  run.fixShas = []
  const roundFixes = []
  let fixFailure = null
  const suiteRun = args.landing
    ? runner('suite', 'Review', `Run the full suite on the exact tip ${sha} beside the reviews: add a detached worktree of ${sha} outside every repo folder, run node ~/.claude/tools/test-pass/test-pass.mjs run --repo <that folder> --suite (no command after it: test-pass runs the repo's declared suite), remove the worktree. Return the command's exit and its last 5 lines.`)
    : Promise.resolve(null)

  // The fix queue: one fix at a time in the lane. A batch enters it as soon as its verdicts are in, while slower lenses still read.
  const fixBatch = async (batch) => {
    const again = batch.filter((item) => item.severity === 'blocking' && blockingFiles.has(item.file))
    const diagnosis = again.length === 0 ? null : await agent(`The same files block two rounds in a row: ${[...new Set(again.map((item) => item.file))].join(', ')}. Diagnose the root cause before anyone fixes again (C22): read those lines and the earlier fix (git -C ${args.repo} log -p ${args.branch} on them) and name the cause in <= 12 lines.\n${again.map(itemText).join('\n')}`, { label: `${args.row}:diagnose`, phase: 'Fix', agentType: 'deep-debugger', model: 'opus', effort: 'high' })
    const released = await runner('release', 'Fix', `Remove the lane worktree ${run.worktree} so the fix agent can switch to the lane branch: git -C ${run.worktree} status --porcelain must be empty (else report exit 1 and the status); then git -C ${args.repo} worktree remove ${run.worktree}.`)
    if (released === null || released.exit !== 0) { fixFailure = `release of the lane worktree failed: ${released?.tail ?? 'runner stopped'}`; return }
    const concurrent = batch.some((item) => (tier.fileClasses?.[item.file] ?? []).some((name) => name.startsWith('concurrency')))
    const fixed = await agent(fixPrompt(batch, sha, diagnosis), { label: `${args.row}:fix`, phase: 'Fix', agentType: 'implementer', model: concurrent ? 'opus' : 'sonnet', effort: 'high', isolation: 'worktree', schema: IMPLEMENTED })
    if (fixed === null) { fixFailure = 'the fix agent was stopped'; return }
    // The next round reviews the HEAD of the worktree it returns, so it must be the lane branch's own and a plain path and sha (B1, N1).
    if (fixed.branch !== args.branch || !SAFE_PATH.test(fixed.worktree) || !SHA.test(fixed.sha)) { fixFailure = `the fix agent returned branch ${fixed.branch}, worktree ${fixed.worktree}, sha ${fixed.sha}: not the lane ${args.branch}`; return }
    run.worktree = fixed.worktree
    run.expectedTip = fixed.sha
    run.fixShas.push(fixed.sha)
    roundFixes.push(...batch.filter((item) => !fixed.deferred.includes(item.id)).map((item) => ({ ...item, status: 'fixed' })))
    recheck.push(...batch.filter((item) => fixed.deferred.includes(item.id)).map((item) => ({ ...item, status: 'open' })))
  }
  let fixQueue = Promise.resolve()
  const enqueueFix = (batch) => { fixQueue = fixQueue.then(() => fixBatch(batch)).catch((error) => { fixFailure = `a fix step threw: ${error.message}` }) }
  if (run.round === 0 && args.fix && (args.initialFindings ?? []).length > 0) enqueueFix(args.initialFindings)

  const judge = (item, why) => agent(`A check that is not stronger than the finder called this finding not real, which may not drop it. Rule on it from the code at ${reviewWorktree} (sha ${sha}).\n${fixText(item)}\nThe check's reason: ${why}`, { label: `${args.row}:judge:${slug(item.id)}`, phase: 'Verify', agentType: 'reviewer', model: 'opus', effort: 'max', schema: JUDGED })
  // I2: `real: false` drops a finding only from a verifier at least as strong as the finder and never a security finding; else the Opus-max judge rules.
  const rule = async (item, verdict, verifier, finder) => {
    if (verdict?.real === true) return { item, real: true, moved: verdict.linesMoved }
    if (verdict && !item.security && atLeast(verifier, finder)) return { item, real: false }
    const ruled = await judge(item, verdict?.why ?? 'no verdict returned')
    if (ruled?.real === false && item.security) leadList.push({ ...item, reason: ruled.why })
    return { item, real: ruled === null ? true : ruled.real, moved: verdict?.linesMoved === true }
  }
  const verifyBatch = async (batch, at, review, finder, verifier) => {
    const moved = run.fixShas.length > 0
      ? `Fixes committed since ${sha}: ${run.fixShas.join(', ')}. Set linesMoved true for a finding when one of them touched the cited lines (git diff ${sha}..${run.fixShas.at(-1)} -- <file>). Judge each finding at ${sha}, never at a newer HEAD.`
      : `linesMoved is false: no fix has changed anything since ${sha}.`
    const verdicts = await agent(`Verify each finding independently by reading the code at ${reviewWorktree} (sha ${sha}); try to refute it; real is false only when you can show why. ${moved}\n${batch.map(fixText).join('\n')}`, { label: `${args.row}:verify:${slug(review.lens)}-${at + 1}`, phase: 'Verify', agentType: agentTypeOf(review), ...verifier, schema: VERDICTS })
    return parallel(batch.map((item) => () => rule(item, verdicts?.verdicts.find((verdict) => verdict.id === item.id), verifier, finder)))
  }
  // A verifier or judge that threw (parallel gives null) stands for findings nobody ruled on: the round is incomplete, never clean (C9).
  const unruled = (batches) => batches.some((entries) => entries === null || entries.some((entry) => entry === null))
  const verify = async (found, review) => {
    if (found === null) return { dead: true }
    const finder = specOf(review)
    optional.push(...found.findings.filter((item) => item.severity === 'optional'))
    const needing = found.findings.filter((item) => item.severity !== 'optional').map((item) => ({ ...item, origin: originOf(review) }))
    const batches = Array.from({ length: Math.ceil(needing.length / FINDINGS_PER_VERIFIER) }, (_, at) => needing.slice(at * FINDINGS_PER_VERIFIER, (at + 1) * FINDINGS_PER_VERIFIER))
    const ruledBatches = await parallel(batches.map((batch, at) => () => verifyBatch(batch, at, review, finder, VERIFIER)))
    if (unruled(ruledBatches)) return { dead: true }
    const ruled = ruledBatches.flat()
    const confirmed = ruled.filter((entry) => entry.real && !entry.moved).map((entry) => entry.item)
    if (args.fix && confirmed.length > 0) enqueueFix(confirmed)
    return { confirmed, open: ruled.filter((entry) => entry.real && entry.moved).map((entry) => ({ ...entry.item, status: 'open' })) }
  }

  phase('Review')
  const carried = [...recheck, ...lastFixed]
  recheck = []
  const reviews = [...tier.reviews]
  for (const item of carried) {
    if (!reviews.some((review) => sameOrigin(originOf(review), item.origin ?? DEFAULT_ORIGIN))) reviews.push({ ...(item.origin ?? DEFAULT_ORIGIN), rules: '', brief: 'Re-check only the items listed below.', requiredReading: [], plan: {} })
  }
  const results = await pipeline(
    reviews,
    (review) => agent(reviewPrompt(review, sha, reviewWorktree, carried.filter((item) => sameOrigin(originOf(review), item.origin ?? DEFAULT_ORIGIN))), { label: `${args.row}:review:${slug(review.lens)}`, phase: 'Review', agentType: lensAgentTypeOf(review), ...specOf(review), schema: FINDINGS }),
    verify,
  )
  if (results.some((entry) => entry === null || entry.dead)) {
    await fixQueue
    return outcome('incomplete', 'a lens stopped before it returned; no verdict can stand for it')
  }
  const confirmed = results.flatMap((entry) => entry.confirmed)
  const open = results.flatMap((entry) => entry.open)
  const suite = await suiteRun
  const suiteRed = suite !== null && suite.exit !== 0
  if (suiteRed && args.fix) enqueueFix([{ id: `suite-${run.round}`, severity: 'blocking', file: '(suite)', line: 0, problem: `the full suite is red at ${sha}: ${suite.tail}`, fix: 'make the suite pass', security: false }])
  await fixQueue
  await runner('cleanup', 'Fix', `Remove the detached worktree ${reviewWorktree}: git -C ${args.repo} worktree remove --force ${reviewWorktree}.`)

  const suiteState = suite === null ? 'none' : suiteRed ? 'red' : 'pass'
  if (fixFailure !== null) return outcome('failed', fixFailure, { findings: [...confirmed, ...open], suite: suiteState })
  if (!args.fix) return outcome(confirmed.length + open.length > 0 || suiteRed ? 'findings' : 'clean', '', { findings: [...confirmed, ...open], suite: suiteState })
  if (roundFixes.length === 0 && recheck.length === 0 && open.length === 0 && !suiteRed) return outcome('clean', '', { suite: suiteState })
  blockingFiles = new Set(confirmed.filter((item) => item.severity === 'blocking').map((item) => item.file))
  recheck.push(...open)
  lastFixed = roundFixes
  run.round += 1
  run.deltaOf = sha
  run.laneClasses = tierFile
}

/**
 * Why a tier runner's answer cannot be trusted, or null when it can (B1, B2, N1): review-tier must have exited 0 with a `reviews` list, the reviewed sha
 * must be the HEAD the last fix returned, and the review worktree and tier file must be plain, fresh paths (they go into a `worktree remove --force`).
 */
function problemWithTier(prepared) {
  const { exit, sha, reviewWorktree, tierFile: file, tier } = prepared
  if (exit !== 0) return `review-tier exited ${exit}, so no review set exists for ${run.worktree}`
  if (!Array.isArray(tier?.reviews)) return 'the tier JSON has no `reviews` list, so no review set exists'
  if (!SHA.test(sha)) return `the reviewed sha ${sha} is not a git sha`
  if (run.expectedTip !== null && !sameSha(sha, run.expectedTip)) return `the lane worktree is at ${sha}, not at ${run.expectedTip}, the HEAD of the last fix`
  if (!SAFE_PATH.test(reviewWorktree) || !reviewWorktree.endsWith(`${slug(args.row)}-${sha.slice(0, 8)}`)) return `the review worktree ${reviewWorktree} is not <scratch>/${slug(args.row)}-<sha8>`
  if (!SAFE_PATH.test(file) || file === run.laneClasses) return `the tier file ${file} is not a new plain path`
  return null
}

function checkArgs(given) {
  const name = 'review' // the tool cuts `meta` out of the body, so the script's own name is written here
  const required = { row: 'string', repo: 'string', base: 'string', range: 'string', landing: 'boolean', fix: 'boolean', branch: 'string', worktree: 'string', suite: 'string' }
  const optional = { tier: 'object', addClasses: 'array', laneClasses: 'string', deltaOf: 'string', initialFindings: 'array' }
  const check = (key, type) => {
    const value = given === undefined || given === null ? undefined : given[key]
    const ok = type === 'array' ? Array.isArray(value) : typeof value === type
    if (!ok) throw new Error(`${name}: args.${key} must be ${type === 'array' ? 'an array' : `a ${type}`}`)
  }
  for (const [key, type] of Object.entries(required)) check(key, type)
  for (const [key, type] of Object.entries(optional)) if (given[key] !== undefined) check(key, type)
}
