// review: review a lane the way the setup's rules say, as a pipeline, then fix what the reviews confirm and review the fixes again until a round
// is clean. Lenses come from review-tier (classes, models, efforts, stress and mutation plans); the script adds nothing and removes nothing.
// Args: { row, repo, base, range, landing, fix, branch, worktree, suite, tier?, addClasses?, laneClasses?, deltaOf?, priorFindings?, initialFindings?, waiverAt?, principles?, audit? }
//   suite: the repo's declared full-suite command (test-pass runs it as `run --suite`, never from this text);
//   tier: review-tier JSON from the lead to use for round 0 instead of running the tool; laneClasses: the class names of an earlier round (that
//   result's laneClasses: classes and plan kinds are kept, I4); deltaOf: the full 40-character sha an earlier round reviewed (round 0 reviews only
//   what changed since); it needs laneClasses and priorFindings: the blocking and should-fix findings of the round that reviewed deltaOf ([] only on
//   purpose, when that round was clean; at most MAX_PRIOR_FINDINGS), which every lens of round 0 verifies; a run without them is `failed` with the
//   cause, and `tier` with deltaOf throws. initialFindings: findings that are confirmed already (red tests after a join, a rebase conflict) and go
//   to the fix queue first; with deltaOf they are fixed BEFORE any review (nothing new to read until then) and are the prior findings of round 1,
//   so that call needs no priorFindings. fix:false only reports, so initialFindings with fix:false is `failed` (nobody would fix or re-read them).
//   waiverAt: the sha build.js's join proved by its checkpoints; round 0 then runs only `tier.waivable.reviews` (runner-computed tier, no weakened
//   check, no deltaOf), and any finding, open item or red suite makes round 1 a whole-range full-set round. principles: {id, question}[] the lens
//   prompts add to the tier's own. audit: {base, tip} recorded shas: the post-land audit of a waived lane (needs fix:false, landing:false; refuses deltaOf, tier, waiverAt and initialFindings).
// Returns: { status: 'clean'|'findings'|'incomplete'|'failed', rounds, tip (the reviewed sha: land only that), baseSha (merge-base of the last
//   round, audit.base in audit mode, null when no tier ran), waived (round 0 was waived and ended clean), worktree (the lane's worktree after the
//   fixes), laneClasses (the class names of the lane, for a later deltaOf run), suite, findings, optional, leadList, text } (a `clean` status means every required lens and verdict of the last round is in,
//   none confirmed anything, and with `landing` the suite passed at tip).
// Review set: a runner recomputes it with review-tier every round (with every --add-class and the lane's classes); the fix agent never supplies it.
//   The script keeps the lane's class names and the lane start (a full sha, resolved once by the first tier runner) in its own state and writes both
//   into every delta command (--lane-classes a,b --base <sha>): no file and no branch name is handed from round to round.
//   A delta round (review-tier --delta) names the prior findings as a file the runner writes from the script's own list, one line per finding with its
//   severity and no fixed/open claim; review-tier counts and hashes it, every lens gets every prior finding and returns `prior: <n> fixed, <m> open`,
//   and the round is clean only when each lens has m = 0 and n + m = that count (else `incomplete`). A count that differs from the list is `failed`.
//   The prior line is read in every delta round: no line, counts that do not add up, or a lens that says `needs the full range` end the round
//   `incomplete`; a prior finding a lens counted open without returning it stays open in the next round's prior file.
//   review-tier refuses an empty delta (exit 2): a run whose deltaOf is the lane's HEAD is `failed` with that cause, and a round whose fixes left
//   HEAD where it was ends `failed` ("the fix committed nothing for <ids>", or "no fix ran" when none did) before review-tier is asked again.
//   A review-tier that exits non-zero is `failed` with the tool's own error line, quoted.
//   A run whose tier did not exit 0, has no `reviews` list, or (with `landing` or in a delta round) has an empty one and nothing carried over is `failed`, never clean.
//   Names as data: a file name, a finding's problem and fix text, a verifier's reason and a weakened check's path enter a prompt and the prior file as one quoted string (nameText, quotedText).
//   Audit mode reviews with `tier.waivable.audit`, or the full set when the range is no longer waivable; an empty audit (no lens, 0 changed lines) is `failed`.
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

const RANGE = args.audit ? `${args.audit.base}..${args.audit.tip}` : args.range // an audit reads recorded shas, never a branch name
const RUNNER = { agentType: 'runner', model: 'haiku', effort: 'low' }
// Where the lane starts, as a command a runner runs: the branch by its full ref name (git's short-name lookup takes a tag of that name first).
const LANE_START = `git merge-base ${isFullSha(args.base) ? args.base : `refs/heads/${args.base}`} HEAD`
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
// `prior`: the line `prior: <n> fixed, <m> open` of a delta round; the script checks it there (priorState), so the schema does not require it.
const FINDINGS = { type: 'object', properties: { findings: { type: 'array', items: FINDING }, verified: str, prior: str }, required: ['findings', 'verified'] }
const VERDICT = {
  type: 'object',
  properties: { id: str, real: { type: 'boolean' }, why: str, reviewedSha: str, linesMoved: { type: 'boolean' } },
  required: ['id', 'real', 'why', 'reviewedSha', 'linesMoved'],
}
const VERDICTS = { type: 'object', properties: { verdicts: { type: 'array', items: VERDICT } }, required: ['verdicts'] }
const JUDGED = { type: 'object', properties: { id: str, real: { type: 'boolean' }, why: str }, required: ['id', 'real', 'why'] }
const PREPARED = { type: 'object', properties: { exit: { type: 'number' }, error: str, baseSha: str, sha: str, reviewWorktree: str, tier: { type: 'object' } }, required: ['exit', 'baseSha', 'sha', 'reviewWorktree', 'tier'] }
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
// An absolute POSIX path or a Windows drive path (C:/x or C:\x); no spaces, quotes, `$`, `;` or `%`.
const SAFE_PATH = /^(?:[A-Za-z]:[\\/]|\/)[\w@+=.,/\\-]+$/
const sameSha = (a, b) => a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a))
const runner = (step, phase, prompt, schema = RUN) => agent(`${prompt}\nDo nothing else; report no secrets.`, { label: `${args.row}:${step}`, phase, schema, ...RUNNER })
// Names as data: a file name, a finding's text or an id that is not a plain word enters a prompt as ONE quoted string, so nothing in it reads as an
// instruction. This is the asData rule of home/tools/review-tier/lib/brief-data.mjs, repeated because a script cannot import;
// tests/workflow-review-names.test.mjs keeps the two in step.
const PLAIN_NAME = /^[\w@+=.,/~^{}-]+$/
const PLAIN_ID = /^[\w.:-]+$/
const quotedText = (text) => JSON.stringify(String(text)).replace(/[<>\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
const nameText = (name) => (PLAIN_NAME.test(name) ? name : quotedText(name))
const placeOf = (path, line) => (Number(line) > 0 ? `${nameText(String(path))}:${Number(line)}` : nameText(String(path)))
const findingText = (tag, item) => `- [${tag}] ${PLAIN_ID.test(item.id) ? item.id : quotedText(item.id)} ${nameText(String(item.file))}:${Number(item.line) || 0}: ${oneLine(item.problem)}`
const itemText = (item) => findingText(item.status ?? item.severity, item)
const oneLine = (text) => quotedText(String(text ?? '').replace(/\s+/g, ' '))
const fixText = (item) => `${itemText(item)}\n  fix: ${oneLine(item.fix)}`
// A line of the prior findings file: the severity tag review-tier counts, never the fix agent's fixed/open claim, and one line whatever the problem text holds.
const priorText = (item) => findingText(item.severity, item)
const isCounted = (item) => item.severity === 'blocking' || item.severity === 'should-fix'
const PRIOR_LINE = /^prior: (\d+) fixed, (\d+) open$/ // the whole line: a remark after it ("0 open (B1 is still open)") is no prior line
const MAX_PRIOR_FINDINGS = 200 // a runner copies each into the prior file and every lens verifies each: a longer list is not checked reliably
const MAX_ERROR_CHARS = 400 // of review-tier's own error line, shown quoted in a failure text
const NO_CLASS = 'docs' // the one class name that raises no set: what a delta round passes when no round before it had a class
const FULL_RANGE = /needs the full range/i // the agents' Delta mode: a lens that cannot bound the fix says so, and the round is then not clean
const planText = (plan) => [
  plan?.stress ? `PLAN stress (run it; a full-suite re-run is the one thing not to do): ${JSON.stringify(plan.stress)}` : '',
  plan?.mutation ? `PLAN mutation: at most ${plan.mutation.maxMutants} mutants of changed lines, in a private copy of the worktree.` : '',
].filter(Boolean).join('\n')

// State across rounds. lastFixed: findings fixed in the previous round (their finders re-check them); recheck: findings still open
// (deferred by a fix agent, or moved by a fix) that the next round's lenses judge again.
// laneClasses: the class and tag names of every round so far; laneStart: the full sha the lane starts from, resolved once, by the first runner of the
// run and before any fix agent has worked (the first tier runner, or the `base` step of a run that fixes first), and
// written into every later delta command, so no branch moved during the run changes what a round reads.
const run = { round: 0, tip: null, deltaOf: args.deltaOf ?? null, laneClasses: [...(args.laneClasses ?? [])], laneStart: null, worktree: args.worktree, knownTier: args.tier ?? null, fixShas: [], expectedTip: null, baseSha: null, lensNotes: '' }
let lastFixed = []
let recheck = (args.priorFindings ?? []).map((item) => ({ ...item, status: 'open' })) // the caller's earlier round: every lens of round 0 verifies them
let blockingFiles = new Set()
const leadList = []
const optional = []
const outcome = (status, text, extra = {}) => ({ status, rounds: run.round + 1, tip: run.tip, baseSha: run.baseSha, waived: false, worktree: run.worktree, laneClasses: run.laneClasses, suite: 'none', findings: [], optional, leadList, text, ...extra })

const tierPrompt = (known, carried) => {
  const priorFile = `\${TMPDIR:-/tmp}/${slug(args.row)}-prior-<sha8>.md`
  const names = run.laneClasses.length > 0 ? run.laneClasses : run.deltaOf ? [NO_CLASS] : []
  const command = [`node ~/.claude/tools/review-tier/review-tier.mjs ${run.deltaOf ? `--delta ${run.deltaOf} --base ${run.laneStart ?? '<the lane start>'} --prior <the prior findings file> --prior-sha256 <its sha256>` : RANGE}`, args.landing || args.audit ? '--landing' : '',
    ...(args.addClasses ?? []).map((name) => `--add-class ${name}`), names.length > 0 ? `--lane-classes ${names.join(',')}` : '', '--json'].filter(Boolean).join(' ')
  return `Work in ${run.worktree} (lane ${args.branch}, base ${args.base}): cd there first, review-tier reads the git repository of its working folder. The reviewed sha is its HEAD (git rev-parse HEAD).\n`
    + `Add a detached review worktree of that sha outside every repo folder: git -C ${args.repo} worktree add --detach <scratch>/${slug(args.row)}-<sha8> <sha> (<sha8> is the first 8 characters of the sha). When that folder already exists, a killed run left it: first git -C ${args.repo} worktree remove --force <it> and git -C ${args.repo} worktree prune.\n`
    + `${run.deltaOf && !known && run.laneStart === null ? `The lane start is the output of ${LANE_START} (the full 40-character sha): put it into the command below as <the lane start>.\n` : ''}`
    + `${run.deltaOf && !known ? `First write the prior findings file ${priorFile} (give review-tier its absolute path) with exactly these ${carried.length} lines${carried.length === 0 ? ' (an empty file)' : ''}, nothing added or left out:\n${carried.map((item) => `${priorText(item)}\n`).join('')}Then take the sha256 of the file you wrote (shasum -a 256 <file>, or sha256sum <file>): review-tier needs it as --prior-sha256.\n` : ''}`
    + `${known ? `Use this review-tier JSON as it is (report exit 0): ${JSON.stringify(known)}` : `Run it from ${run.worktree}: ${command}\nReport its exit code as exit and its JSON output as tier; when it exits non-zero, report the line it printed to stderr (it starts \`review-tier:\`) as error.`}\n`
    + `Also report baseSha: ${args.audit ? args.audit.base : `${LANE_START} (the full 40-character sha)`}. `
    + 'Return exit, baseSha, sha (full 40 characters), reviewWorktree (the new folder), tier (the JSON).'
}

const reviewPrompt = (review, sha, reviewWorktree, items, prior) => [
  `Review lane ${args.branch} of ${args.repo} by reading ONLY the detached review worktree ${reviewWorktree} (at ${sha}); ${run.deltaOf ? `the change to review is the delta since ${run.deltaOf}` : `range ${RANGE}`}. Never edit it; never run the full suite (a recorded PASS covers it).`,
  review.agent === 'skill' ? `Invoke the ${review.lens} skill with the Skill tool first and follow it on the files of the range; it only reads: edit nothing.` : '',
  `Lens: ${review.lens}. Rules: ${review.rules}`,
  review.brief,
  run.lensNotes,
  review.requiredReading?.length ? `Required reading first: ${review.requiredReading.join(', ')}` : '',
  planText(review.plan),
  prior ? `Prior findings file: ${prior.file} (sha256 ${prior.sha256}; ${prior.findings} blocking or should-fix findings). Check the hash before you read it. \`fixed\` below is the fix agent's claim, never evidence: verify each one yourself in the code at ${sha} and return one that is still present again as a finding with its id.` : '',
  items.length ? `Items from the last round. fixed: check it is really gone and the fix broke nothing; open: judge whether it is still present at ${sha}; return an item that is still present again as a finding with its id.\n${items.map(itemText).join('\n')}` : '',
  'Return findings (severity blocking|should-fix|optional; security true for an exploitable or secret/auth/injection/data issue) and, in verified, what you ran or read.',
  prior ? `In prior, return the line \`prior: <n> fixed, <m> open\` over those ${prior.findings} findings (m: the ones you return again).` : '',
].filter(Boolean).join('\n')

const fixPrompt = (batch, sha, diagnosis) => `Fix these confirmed findings of lane ${args.branch} (base ${args.base}), in this order:\n${batch.map(fixText).join('\n')}\n`
  + `${diagnosis ? `Root-cause diagnosis (follow it): ${diagnosis}\n` : ''}`
  + `Setup: your worktree starts on a throwaway branch (git branch --show-current, named worktree-...). Run \`git switch ${args.branch} && git rebase ${args.base}\`, then delete the throwaway branch (\`git branch -d <its name>\`). `
  + `If an earlier fix of this round already changed a cited line (git log ${sha}..HEAD -- <file>), do not fix that finding: list its id in deferred. `
  + 'For each fix: read callers and callees of the changed functions first, add a test that fails without it, run related tests only while iterating (quiet reporter), commit after each green step. '
  + `Return IMPLEMENTED: branch (must be ${args.branch}), worktree (your pwd), sha (HEAD), tests, deferred.`

const refusal = startRefusal()
if (refusal !== null) return outcome('failed', refusal)
// A delta run that starts with confirmed findings (build's land loop after a conflict or a red suite) has nothing new to read at deltaOf, so it fixes
// first and reviews the fix as round 1 on the same deltaOf. No tier exists yet to say the files are not concurrency code: the fix takes the stronger model.
if (run.deltaOf !== null && args.fix && (args.initialFindings ?? []).length > 0) {
  phase('Fix')
  // The lane start is read before the fix agent works: afterwards the base branch is a ref the fix's writer could have moved.
  const start = await runner('base', 'Fix', `In ${run.worktree} run ${LANE_START} and return its exit code and, as tail, only the full 40-character sha it prints.`)
  if (start === null || start.exit !== 0 || !isFullSha(String(start.tail).trim())) return outcome('failed', `the lane start could not be read (${LANE_START} in ${run.worktree}): ${start === null ? 'the runner was stopped' : `exit ${start.exit}, ${oneLine(String(start.tail).slice(0, MAX_ERROR_CHARS))}`}. Check that ${nameText(args.base)} is a local branch or a full sha of that repository.`, { findings: args.initialFindings })
  run.laneStart = String(start.tail).trim()
  const first = { sha: run.deltaOf, fileClasses: null, fixes: [], failure: null }
  await fixBatch(args.initialFindings, first).catch((error) => { first.failure = `a fix step threw: ${error.message}` })
  const stopped = first.failure ?? nothingCommitted(first, args.initialFindings)
  if (stopped !== null) return outcome('failed', stopped, { findings: args.initialFindings })
  lastFixed = first.fixes
  run.round = 1
}

while (true) {
  phase('Tier')
  const knownTier = run.knownTier
  run.knownTier = null
  const carried = [...recheck, ...lastFixed]
  recheck = []
  const prepared = await runner('tier', 'Tier', tierPrompt(knownTier, carried.filter(isCounted)), PREPARED)
  if (prepared === null) return outcome('failed', 'the tier runner was stopped')
  const { sha, reviewWorktree, tier } = prepared
  const isDelta = run.deltaOf !== null // args.tier never comes with deltaOf (deltaRefusal), so a delta round's set is always review-tier's own
  const tierProblem = problemWithTier(prepared) ?? (isDelta ? problemWithPrior(tier.prior, carried.filter(isCounted).length) : null)
  if (tierProblem !== null) return outcome('failed', tierProblem)
  const waiver = run.round === 0 && canWaive(knownTier, sha, tier)
  // An audit uses the waiver's audit half; a range that is no longer waivable (a land-loop fix touched a gate path) gets the full set, never a failure (N3).
  const reviewSet = reviewSetOf(tier, waiver)
  if (args.audit && (reviewSet.length === 0 || !(tier.changedLines > 0))) return outcome('failed', `empty audit: ${RANGE} has ${tier.changedLines} changed lines and ${reviewSet.length} lenses, so nothing was audited`)
  if ((args.landing || isDelta) && reviewSet.length === 0 && carried.length === 0) return outcome('failed', `the ${isDelta ? 'delta' : 'landing'} review set of ${sha} is empty: review-tier gives at least one lens for a landing diff and for every fix round, so the tier was lost`)
  run.laneClasses = [...new Set([...run.laneClasses, ...classNamesOf(tier)])]
  run.tip = sha
  run.baseSha = prepared.baseSha
  if (!args.audit) run.laneStart ??= prepared.baseSha
  run.lensNotes = notesOf(tier)
  run.fixShas = []
  const round = { sha, fileClasses: tier.fileClasses ?? {}, fixes: [], failure: null }
  const suiteRun = args.landing
    ? runner('suite', 'Review', `Run the full suite on the exact tip ${sha} beside the reviews: add a detached worktree of ${sha} outside every repo folder, run node ~/.claude/tools/test-pass/test-pass.mjs run --repo <that folder> --suite (no command after it: test-pass runs the repo's declared suite), remove the worktree. Return the command's exit and its last 5 lines.`)
    : Promise.resolve(null)

  // The fix queue: one fix at a time in the lane. A batch enters it as soon as its verdicts are in, while slower lenses still read.
  let fixQueue = Promise.resolve()
  const enqueueFix = (batch) => { fixQueue = fixQueue.then(() => fixBatch(batch, round)).catch((error) => { round.failure = `a fix step threw: ${error.message}` }) }
  if (run.round === 0 && args.fix && (args.initialFindings ?? []).length > 0) enqueueFix(args.initialFindings)

  const judge = (item, why) => agent(`A check that is not stronger than the finder called this finding not real, which may not drop it. Rule on it from the code at ${reviewWorktree} (sha ${sha}).\n${fixText(item)}\nThe check's reason: ${why}`, { label: `${args.row}:judge:${slug(item.id)}`, phase: 'Verify', agentType: 'reviewer', model: 'opus', effort: 'max', schema: JUDGED })
  // I2: `real: false` drops a finding only from a verifier at least as strong as the finder and never a security finding; else the Opus-max judge rules.
  const rule = async (item, verdict, verifier, finder) => {
    if (verdict?.real === true) return { item, real: true, moved: verdict.linesMoved }
    if (verdict && !item.security && atLeast(verifier, finder)) return { item, real: false }
    const ruled = await judge(item, oneLine(verdict?.why ?? 'no verdict returned'))
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
    return { confirmed, prior: found.prior, said: found.verified, returned: found.findings.map((item) => item.id), lens: review.lens, open: ruled.filter((entry) => entry.real && entry.moved).map((entry) => ({ ...entry.item, status: 'open' })) }
  }

  phase('Review')
  const reviews = [...reviewSet]
  for (const item of carried) {
    if (!reviews.some((review) => sameOrigin(originOf(review), item.origin ?? DEFAULT_ORIGIN))) reviews.push({ ...(item.origin ?? DEFAULT_ORIGIN), rules: '', brief: 'Re-check only the items listed below.', requiredReading: [], plan: {} })
  }
  const results = await pipeline(
    reviews,
    // A delta round: every lens verifies every prior finding (the file holds them all). Any other round: a lens re-checks the items it found.
    (review) => agent(reviewPrompt(review, sha, reviewWorktree, carried.filter((item) => isDelta || sameOrigin(originOf(review), item.origin ?? DEFAULT_ORIGIN)), isDelta ? { ...tier.prior.files[0], findings: tier.prior.findings } : null), { label: `${args.row}:review:${slug(review.lens)}`, phase: 'Review', agentType: lensAgentTypeOf(review), ...specOf(review), schema: FINDINGS }),
    verify,
  )
  if (results.some((entry) => entry === null || entry.dead)) {
    await fixQueue
    return outcome('incomplete', 'a lens stopped before it returned; no verdict can stand for it')
  }
  const confirmed = results.flatMap((entry) => entry.confirmed)
  const open = results.flatMap((entry) => entry.open)
  const isClean = confirmed.length + open.length === 0
  const prior = isDelta ? priorState(results, tier.prior.findings, carried.filter(isCounted)) : { problem: null, stillOpen: null, leftOut: [] }
  const suite = await suiteRun
  const suiteRed = suite !== null && suite.exit !== 0
  if (suiteRed && args.fix) enqueueFix([{ id: `suite-${run.round}`, severity: 'blocking', file: '(suite)', line: 0, problem: `the full suite is red at ${sha}: ${suite.tail}`, fix: 'make the suite pass', security: false }])
  await fixQueue
  await runner('cleanup', 'Fix', `Remove the detached worktree ${reviewWorktree}: git -C ${args.repo} worktree remove --force ${reviewWorktree}.`)

  const suiteState = suite === null ? 'none' : suiteRed ? 'red' : 'pass'
  const found = { findings: [...confirmed, ...open], suite: suiteState }
  if (round.failure !== null) return outcome('failed', round.failure, found)
  if (!args.fix && (!isClean || suiteRed)) return outcome('findings', prior.problem ?? prior.stillOpen ?? '', found)
  // Checked in every delta round, also one that still has findings to fix: a lens that gave no usable prior line or needs the whole range verified nothing.
  if (prior.problem !== null) return outcome('incomplete', `the delta round cannot be clean: ${prior.problem}`, found)
  const settled = !args.fix || (round.fixes.length === 0 && recheck.length === 0 && open.length === 0 && !suiteRed)
  if (settled && prior.stillOpen !== null) return outcome('incomplete', `the delta round cannot be clean: ${prior.stillOpen}`, { suite: suiteState })
  if (settled) return outcome('clean', '', { suite: suiteState, waived: waiver })
  blockingFiles = new Set(confirmed.filter((item) => item.severity === 'blocking').map((item) => item.file))
  recheck.push(...open)
  // A prior finding a lens counted open without returning it stays open: the next prior file holds it, so it is verified again.
  const carriedOn = new Set([...round.fixes, ...recheck].map((item) => item.id))
  recheck.push(...prior.leftOut.filter((item) => !carriedOn.has(item.id)).map((item) => ({ ...item, status: 'open' })))
  const unmoved = nothingCommitted(round, [...round.fixes, ...recheck])
  if (unmoved !== null) return outcome('failed', unmoved, found)
  lastFixed = round.fixes
  run.round += 1
  run.deltaOf = waiver ? null : sha // a waived round 0 that found anything is re-reviewed over the whole range with the full set
}

/**
 * One fix in the lane: release the lane worktree, run the fix agent on the lane branch, and record what it fixed (`round.fixes`) and deferred (`recheck`).
 * `round`: { sha (what the findings were judged at), fileClasses (the tier's, or null before any tier), fixes, failure (set instead of throwing) }.
 */
async function fixBatch(batch, round) {
  const again = batch.filter((item) => item.severity === 'blocking' && blockingFiles.has(item.file))
  const diagnosis = again.length === 0 ? null : await agent(`The same files block two rounds in a row: ${[...new Set(again.map((item) => nameText(String(item.file))))].join(', ')}. Diagnose the root cause before anyone fixes again (C22): read those lines and the earlier fix (git -C ${args.repo} log -p ${args.branch} on them) and name the cause in <= 12 lines.\n${again.map(itemText).join('\n')}`, { label: `${args.row}:diagnose`, phase: 'Fix', agentType: 'deep-debugger', model: 'opus', effort: 'high' })
  const released = await runner('release', 'Fix', `Remove the lane worktree ${run.worktree} so the fix agent can switch to the lane branch: git -C ${run.worktree} status --porcelain must be empty (else report exit 1 and the status); then git -C ${args.repo} worktree remove ${run.worktree}.`)
  if (released === null || released.exit !== 0) { round.failure = `release of the lane worktree failed: ${released?.tail ?? 'runner stopped'}`; return }
  const concurrent = round.fileClasses === null || batch.some((item) => (round.fileClasses[item.file] ?? []).some((name) => name.startsWith('concurrency')))
  const fixed = await agent(fixPrompt(batch, round.sha, diagnosis), { label: `${args.row}:fix`, phase: 'Fix', agentType: 'implementer', model: concurrent ? 'opus' : 'sonnet', effort: 'high', isolation: 'worktree', schema: IMPLEMENTED })
  if (fixed === null) { round.failure = 'the fix agent was stopped'; return }
  // The next round reviews the HEAD of the worktree it returns, so it must be the lane branch's own and a plain path and sha (B1, N1).
  if (fixed.branch !== args.branch || !SAFE_PATH.test(fixed.worktree) || !isSha(fixed.sha)) { round.failure = `the fix agent returned branch ${fixed.branch}, worktree ${fixed.worktree}, sha ${fixed.sha}: not the lane ${args.branch}`; return }
  run.worktree = fixed.worktree
  run.expectedTip = fixed.sha
  run.fixShas.push(fixed.sha)
  round.fixes.push(...batch.filter((item) => !fixed.deferred.includes(item.id)).map((item) => ({ ...item, status: 'fixed' })))
  recheck.push(...batch.filter((item) => fixed.deferred.includes(item.id)).map((item) => ({ ...item, status: 'open' })))
}

/** Why the fixes of a round changed nothing, or null: the lane must be past `round.sha`, else the next round has no delta and review-tier would only say exit 2. */
function nothingCommitted(round, items) {
  const tip = run.fixShas.at(-1)
  if (tip !== undefined && !sameSha(tip, round.sha)) return null
  const ids = items.map((item) => (PLAIN_ID.test(item.id) ? item.id : quotedText(item.id))).join(', ')
  // No fix agent ran at all: the items are open for another reason (a verifier saw their lines moved, a lens counted a prior finding open without returning it).
  if (tip === undefined) return `no fix ran in this round and ${ids} stayed open (a verifier said a fix moved its lines, or a lens counted a prior finding open without returning it), but nothing was committed since ${round.sha}, so there is nothing to review again. Judge them at ${round.sha} yourself, or run the review again; nothing was closed.`
  return `the fix committed nothing for ${ids}: the lane is still at ${round.sha}, so there is nothing to review again. Read why the fix agent changed nothing (a flaky suite, a finding it disputes) and decide; nothing was closed.`
}

/** Why a run cannot start, or null. Returned as `failed`, never thrown: build's review child is not caught, and a thrown child would lose the lane. */
function startRefusal() {
  if (!args.fix && (args.initialFindings ?? []).length > 0) return 'args.initialFindings with fix:false: they are confirmed findings for the fix queue, and with fix:false nobody fixes them or reads them again, so the run could end clean with them open. Pass fix:true, or report them yourself and leave them out.'
  if ((args.priorFindings ?? []).length > MAX_PRIOR_FINDINGS) return `args.priorFindings holds ${args.priorFindings.length} findings, more than ${MAX_PRIOR_FINDINGS}: a runner copies each into the prior findings file and every lens verifies each, so a longer list is not checked reliably. Leave deltaOf out and review the whole range instead.`
  if (args.deltaOf === undefined) return null
  if (!isFullSha(args.deltaOf)) return `args.deltaOf must be the full 40-character sha the last review read (that result's tip), from the caller's own record: review-tier takes no short sha and no name in a fix round, because git reads those as a ref of that name first. Pass the output of git rev-parse <sha>; got ${quotedText(args.deltaOf.slice(0, 80))}.`
  if (args.laneClasses === undefined) return 'args.deltaOf needs args.laneClasses: the class names of the round that reviewed deltaOf (that result\'s laneClasses, such as ["security", "logic"]). review-tier --delta exits 2 without --lane-classes, so a fix round is never lighter than the lane\'s first review. Pass that result\'s laneClasses, or leave deltaOf out for a whole-range review.'
  if (!args.laneClasses.every(isClassName)) return 'args.laneClasses must hold class names (lower-case words such as "security" or "lock-free"): they are written into the review-tier command, and no file is read any more. Pass the laneClasses of the result that reviewed deltaOf.'
  const fixesFirst = args.fix && (args.initialFindings ?? []).length > 0
  if (args.priorFindings === undefined && !fixesFirst) return 'args.deltaOf needs args.priorFindings: the blocking and should-fix findings of the round that reviewed deltaOf ({id, severity, file, line, problem} each), so every lens verifies them. Pass [] only when that round ended clean, on purpose; without the list a delta round would close findings nobody checked. Or leave deltaOf out for a whole-range review.'
  return null
}

/**
 * Why a tier runner's answer cannot be trusted, or null when it can (B1, B2, N1): review-tier must have exited 0 with a `reviews` list, the reviewed sha
 * must be a full sha and the HEAD the last fix returned, and the review worktree must be a plain, fresh path (it goes into a `worktree remove --force`).
 */
function problemWithTier(prepared) {
  const { exit, error, baseSha, sha, reviewWorktree, tier } = prepared
  if (exit !== 0 && run.deltaOf !== null && isSha(sha) && sameSha(sha, run.deltaOf)) return `nothing to review: the lane's HEAD ${sha} is deltaOf itself, so nothing was committed since the reviewed sha and review-tier refused the empty delta (exit ${exit}). Pass the sha the last review read, after a fix was committed; for a whole-range review leave deltaOf out.`
  if (exit !== 0) return `review-tier exited ${exit}, so no review set exists for ${run.worktree}${error ? `; it said: ${quotedText(String(error).slice(0, MAX_ERROR_CHARS))}` : ' (the runner reported no error line)'}`
  if (!Array.isArray(tier?.reviews)) return 'the tier JSON has no `reviews` list, so no review set exists'
  // Both go into the next round's command (--delta, --base), where review-tier takes only a full sha; an audit's base is the caller's recorded one.
  if (!isFullSha(sha)) return `the reviewed sha ${sha} is not a full 40-character git sha`
  if (!(args.audit ? isSha(baseSha) : isFullSha(baseSha))) return `the baseSha ${baseSha} is not a full 40-character git sha`
  if (classNamesOf(tier) === null) return 'the tier JSON has no `laneClasses` (or `classes`) list of class names, so a later round could not keep the lane\'s classes'
  if (args.audit && !sameSha(sha, args.audit.tip)) return `the reviewed sha ${sha} is not the audit tip ${args.audit.tip}`
  if (args.audit && !sameSha(baseSha, args.audit.base)) return `the baseSha ${baseSha} is not the audit base ${args.audit.base}`
  if (run.expectedTip !== null && !sameSha(sha, run.expectedTip)) return `the lane worktree is at ${sha}, not at ${run.expectedTip}, the HEAD of the last fix`
  if (!SAFE_PATH.test(reviewWorktree) || !reviewWorktree.endsWith(`${slug(args.row)}-${sha.slice(0, 8)}`)) return `the review worktree ${reviewWorktree} is not <scratch>/${slug(args.row)}-<sha8>`
  return null
}

/** Why the `prior` object of a delta round's tier cannot be trusted, or null: review-tier must have read one file and counted exactly the findings the script listed (D3). */
function problemWithPrior(prior, carriedCount) {
  const report = Array.isArray(prior?.files) && prior.files.length === 1 ? prior.files[0] : null
  if (report === null || prior.findings !== carriedCount) return `the prior findings file holds ${report === null ? 'no counted' : prior.findings} findings, the round carries ${carriedCount}: the file is not the script's list`
  if (!SAFE_PATH.test(report.file ?? '') || !/^[0-9a-f]{64}$/.test(report.sha256 ?? '')) return `the prior findings file ${report.file} or its sha256 is not a plain value`
  return null
}

/**
 * What the lenses of a delta round say about its prior findings (`expected`: the count review-tier printed; `counted`: the items of the prior file).
 * problem: a lens gave no `prior: <n> fixed, <m> open` line, counts that do not add up, or said it needs the full range (the round is incomplete);
 * stillOpen: a lens has m > 0 (a round with nothing left to fix is then incomplete); leftOut: the prior findings of a lens whose m is larger than
 * the number of prior ids it returned again (which ones it meant is unknown, so every one it did not return stays open).
 */
function priorState(results, expected, counted) {
  const state = { problem: null, stillOpen: null, leftOut: [] }
  for (const { lens, prior, said, returned } of results) {
    const counts = PRIOR_LINE.exec(String(prior ?? '').trim())
    if (FULL_RANGE.test(`${said}\n${prior}`)) state.problem ??= `lens ${lens} says it needs the full range, so the delta was not enough to judge the fix: run the review again without deltaOf`
    else if (counts === null) state.problem ??= String(prior ?? '').trim() === '' ? `lens ${lens} returned no \`prior: <n> fixed, <m> open\` line` : `lens ${lens} returned a prior line that is not exactly \`prior: <n> fixed, <m> open\` (nothing before or after it, no period): ${oneLine(String(prior).slice(0, MAX_ERROR_CHARS))}`
    else if (Number(counts[1]) + Number(counts[2]) !== expected) state.problem ??= `lens ${lens} counted ${counts[1]} fixed and ${counts[2]} open, the prior findings file holds ${expected}`
    if (state.problem !== null) return state
    const open = Number(counts[2])
    if (open > 0) state.stillOpen ??= `lens ${lens} still sees ${open} of the ${expected} prior findings open`
    const leftOut = counted.filter((item) => !returned.includes(item.id))
    if (open > counted.length - leftOut.length) state.leftOut.push(...leftOut.filter((item) => !state.leftOut.includes(item)))
  }
  return state
}

/** Round 0 is waived only for a runner-computed tier of the sha the join proved, with a waivable part, no weakened check and no delta (I1, spec 6). */
function canWaive(knownTier, sha, tier) {
  return args.waiverAt !== undefined && args.deltaOf === undefined && knownTier === null && sameSha(sha, args.waiverAt)
    && Array.isArray(tier.waivable?.reviews) && tier.waivable.reviews.length > 0 && Array.isArray(tier.weakened) && tier.weakened.length === 0
}

/** The lenses of this round: an audit uses the waiver's audit half, a waived round 0 its waiver half, anything else the full set. */
function reviewSetOf(tier, waiver) {
  if (args.audit) return Array.isArray(tier.waivable?.audit) ? tier.waivable.audit : tier.reviews
  if (waiver) return tier.waivable.reviews
  return tier.reviews
}

/** The prompt lines every lens gets: weakened checks the diff adds, and the principle questions (the args' wording first, then the tier's other ids). */
function notesOf(tier) {
  const weakened = (tier.weakened ?? []).map(({ path, line, kind }) => `${placeOf(path, line)} ${nameText(String(kind))}`)
  const asked = args.principles ?? []
  const principles = [...asked.map(({ id, question }) => `${id}: ${question}`), ...(tier.principles ?? []).filter((id) => !asked.some((entry) => entry.id === id))]
  return [weakened.length > 0 ? `Weakened checks this diff adds (each is a finding unless the lane spec asks for it): ${weakened.join('; ')}` : '',
    principles.length > 0 ? `Principles (ids refer to ~/.claude/rules/principles.md; answer each yes/no with file:line in verified; a no is a finding): ${principles.join(' | ')}` : ''].filter(Boolean).join('\n')
}

/** A git sha as an agent reports it. A function, not a const: checkArgs runs before the body's consts exist. */
function isSha(text) {
  return /^[0-9a-f]{7,40}$/.test(text)
}

/** A sha as review-tier takes it in a fix round (--delta, --base): all 40 characters, so git looks no name up. */
function isFullSha(text) {
  return /^[0-9a-f]{40}$/.test(text)
}

/** A class or tag name of review-tier (security, concurrency-lite, lock-free): a plain word, safe in a command. */
function isClassName(name) {
  return typeof name === 'string' && /^[a-z][a-z-]{0,31}$/.test(name)
}

/** The class and tag names a tier JSON hands to the next round (`laneClasses`; `classes` in a JSON the lead made by hand), or null when it holds no such list. */
function classNamesOf(tier) {
  const names = tier.laneClasses ?? tier.classes
  return Array.isArray(names) && names.every(isClassName) ? names : null
}

function checkArgs(given) {
  const name = 'review' // the tool cuts `meta` out of the body, so the script's own name is written here
  const required = { row: 'string', repo: 'string', base: 'string', range: 'string', landing: 'boolean', fix: 'boolean', branch: 'string', worktree: 'string', suite: 'string' }
  const optional = { tier: 'object', addClasses: 'array', laneClasses: 'array', deltaOf: 'string', priorFindings: 'array', initialFindings: 'array', waiverAt: 'string', principles: 'array', audit: 'object' }
  const check = (key, type) => {
    const value = given === undefined || given === null ? undefined : given[key]
    const ok = type === 'array' ? Array.isArray(value) : typeof value === type
    if (!ok) throw new Error(`${name}: args.${key} must be ${type === 'array' ? 'an array' : `a ${type}`}`)
  }
  for (const [key, type] of Object.entries(required)) check(key, type)
  for (const [key, type] of Object.entries(optional)) if (given[key] !== undefined) check(key, type)
  if (given.principles !== undefined && !given.principles.every((entry) => typeof entry?.id === 'string' && typeof entry?.question === 'string')) throw new Error(`${name}: args.principles entries must be {id, question} strings`)
  // A given tier JSON would be a delta round with no prior file, no prior line and no forced lane set: a delta round's set is review-tier's own.
  if (given.tier !== undefined && given.deltaOf !== undefined) throw new Error(`${name}: args.tier cannot be combined with args.deltaOf: a delta round runs review-tier itself (--delta, --prior, --lane-classes); pass one of the two`)
  if (given.priorFindings !== undefined && given.deltaOf === undefined) throw new Error(`${name}: args.priorFindings belongs to a deltaOf run: they are the findings of the round that reviewed deltaOf; for a whole-range review leave them out`)
  const isFinding = (entry) => typeof entry?.id === 'string' && ['blocking', 'should-fix', 'optional'].includes(entry.severity) && typeof entry.file === 'string' && typeof entry.line === 'number' && typeof entry.problem === 'string'
  if (given.priorFindings !== undefined && !given.priorFindings.every(isFinding)) throw new Error(`${name}: args.priorFindings entries must be {id, severity (blocking|should-fix|optional), file, line (a number), problem}`)
  if (given.audit !== undefined) {
    if (given.audit === null || given.fix !== false || given.landing !== false) throw new Error(`${name}: args.audit needs fix:false and landing:false`)
    // Each of these would let a clean audit cover less than, or other than, the recorded base..tip with its own lenses.
    for (const key of ['deltaOf', 'tier', 'waiverAt', 'initialFindings', 'priorFindings']) if (given[key] !== undefined) throw new Error(`${name}: args.audit cannot be combined with args.${key}`)
    if (!isSha(given.audit.base) || !isSha(given.audit.tip)) throw new Error(`${name}: args.audit.base and args.audit.tip must be git shas`)
  }
}
