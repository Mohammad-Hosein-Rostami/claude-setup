// join: the Join stage of one `build` lane, split out of build.js (C4). A runner cherry-picks the test-writer's commits, runs the base-side and head
// runs of the lane's checkpoints, lists out-of-scope, locked and UI files, runs the related tests and closes the implement row; this script then
// judges the contract from the exit codes (never a model's reading).
// Args: { row, closeRow, branch, base, files, statusFile, worktree, sha, disputes?, checkpoints?, written?: { branch, worktree, sha } }: worktree, sha and
//   disputes are the implementer's report; written is the test-writer's (left out when the lane has none).
// Returns: { status: 'joined', joined, findings, waiverAt? } | { status: 'join-failed' | 'contract-touched', sha, text }.
//   joined.uiFiles: the changed files ui-proof counts as UI (one definition, ui-proof/lib/ui-files.mjs); build sends a lane with any to visual-qa.
//   waiverAt is the joined sha only with a test-writer, a red-first checkpoint, every checkpoint met at base and head, nothing vacuous or out of scope
//   and no implementer dispute. Called by build.js only; it calls no workflow (children nest one level).
export const meta = {
  name: 'join',
  description: 'Join one build lane: cherry-pick tests, checkpoint runs, scope and UI lists, related tests, contract verdict',
  whenToUse: 'Called by the build workflow for each lane; not run by hand',
  phases: [{ title: 'Join', detail: 'runner reports exit codes and file lists; the script judges the contract' }],
}
checkArgs(args)

const STATUS = 'node ~/.claude/tools/status/status.mjs'
const UI_PROOF = 'node ~/.claude/tools/ui-proof/ui-proof.mjs'
const [str, num, bool, strings] = [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'array', items: { type: 'string' } }]
const shape = (properties, required) => ({ type: 'object', properties, required })
const CHECKPOINT_RESULT = shape({ id: str, baseExit: num, headExit: num, tail: str }, ['id', 'baseExit', 'headExit', 'tail'])
const JOINED = shape({ red: bool, tail: str, sha: str, worktree: str, vacuous: strings, outOfScope: strings, contractTouched: strings, uiFiles: strings, checkpoints: { type: 'array', items: CHECKPOINT_RESULT } },
  ['red', 'tail', 'sha', 'worktree', 'vacuous', 'outOfScope', 'contractTouched', 'checkpoints'])
const SAFE_PATH = /^(?:[A-Za-z]:[\\/]|\/)[\w@+=.,/\\-]+$/
const built = { worktree: args.worktree, sha: args.sha, disputes: args.disputes ?? [] }
const written = args.written ?? null
const checkpoints = args.checkpoints ?? []
const lockedFiles = [...new Set(checkpoints.flatMap((checkpoint) => checkpoint.files))]
const finding = (id, file, problem, fix) => ({ id, severity: 'blocking', file, line: 0, problem, fix, security: false })

const joined = await agent(joinPrompt(), { label: `${args.row}:join`, phase: 'Join', schema: JOINED, agentType: 'runner', model: 'haiku', effort: 'medium' })
if (joined === null) return { status: 'join-failed', sha: built.sha, text: 'the join runner was stopped' }
if (!SAFE_PATH.test(joined.worktree)) return { status: 'join-failed', sha: built.sha, text: `the join runner returned a worktree path that is not a plain absolute path: ${joined.worktree}` }
const nothingLocked = written === null && lockedFiles.length === 0 // then the runner was never asked for contractTouched
if (!nothingLocked && joined.contractTouched.length > 0) {
  return { status: 'contract-touched', sha: joined.sha, text: `locked contract files were edited: ${joined.contractTouched.join(', ')}; not reviewed or landed. Disputes: ${(built.disputes ?? []).join('; ') || 'none given'}` }
}
return { status: 'joined', joined: { ...joined, uiFiles: joined.uiFiles ?? [] }, ...judgeContract() }

/** The join runner's brief: it only runs commands and reports numbers and file lists. */
function joinPrompt() {
  const baseSide = written ? `the test-writer worktree ${written.worktree} (at ${written.sha})` : 'a detached worktree at `git merge-base ' + args.base + ' HEAD` (git worktree add --detach, removed when you are done)'
  const lockedPathspec = [...lockedFiles, ...(written ? [`<the test files changed by ${written.sha}>`] : [])].join(' ')
  // Nothing locked: no contractTouched (an empty pathspec would list every changed file). A checkpoint with no locked files still needs its base-side run.
  const locked = lockedPathspec !== ''
  return [
    `Join lane ${args.row} in its worktree ${built.worktree} (branch ${args.branch}). Bash timeout 600000 for every test or checkpoint command, 60000 for any other.`,
    written ? `Cherry-pick onto the lane only the commits of ${written.branch} (worktree ${written.worktree}, sha ${written.sha}) that \`git cherry ${args.branch} ${written.branch}\` marks +. Keep the helper branch and worktree until the base-side runs below are done.` : '',
    written || checkpoints.length > 0 ? `Base-side runs, in ${baseSide}: ${written ? `run each test file changed by ${written.sha} (git diff --name-only ${args.base}...${written.sha}) alone with the repo's single-file test command and list in vacuous those that exit 0; ` : ''}${checkpoints.length > 0 ? `run each checkpoint's command and keep its exit as baseExit: ${checkpoints.map((checkpoint) => `${checkpoint.id}: ${checkpoint.run}`).join('; ')}.` : ''}` : '',
    checkpoints.length > 0 ? `Head runs, in ${built.worktree} (the joined HEAD): run the same checkpoint commands, keep each exit as headExit and the last 3 output lines as tail (no secrets). Report every checkpoint as {id, baseExit, headExit, tail}.` : '',
    `Lists (file names, empty when none): outOfScope = files in \`git diff --name-only ${args.base}...HEAD\` that are neither inside ${args.files.join(', ')} nor test files of the lane${locked ? `; contractTouched = \`git diff ${written ? written.sha : '<the merge-base sha above>'} HEAD --name-only -- ${lockedPathspec}\`` : ''}; uiFiles = the lines \`${UI_PROOF} changed --from $(git merge-base ${args.base} HEAD) --to HEAD --repo ${built.worktree}\` prints (exit 1 means some, 0 none).`,
    written ? `Then delete the helper branch ${written.branch} and its worktree.` : '',
    `Run the related tests for the lane's changed files with the repo's own command (e.g. node scripts/affected-tests.mjs --base ${args.base} --run, vitest related --run, jest --findRelatedTests) and report red true when any fail, with the failing lines in tail.`,
    `Then update the rows: ${STATUS} --file ${args.statusFile} done ${args.row} "implemented ${args.branch}; related tests green or red as you found them" and ${STATUS} --file ${args.statusFile} start ${args.closeRow}. Return red, tail, sha (HEAD of the lane), worktree, vacuous, outOfScope, contractTouched, uiFiles, checkpoints.`,
  ].filter((line) => line !== '').join('\n')
}

/**
 * The verdict on the join's numbers. Passing at head means headExit equals the declared exit; red-first must differ at base, keeps-working must match.
 * @returns {{ findings: object[], waiverAt?: string }} findings become the review's first findings; waiverAt only as the header says
 */
function judgeContract() {
  const findings = []
  const problem = (id, text) => findings.push(finding(`contract-${args.row}-${id}`, '(contract)', text, 'fix the change (or add the missing test) so the contract holds; locked files are never edited'))
  const results = new Map(joined.checkpoints.map((result) => [result.id, result]))
  for (const checkpoint of checkpoints) {
    const result = results.get(checkpoint.id)
    if (result === undefined) { problem(checkpoint.id, `checkpoint ${checkpoint.id} (${checkpoint.run}) has no result from the join`); continue }
    if (result.headExit !== checkpoint.exit) problem(checkpoint.id, `checkpoint ${checkpoint.id} (${checkpoint.run}) exits ${result.headExit} at the joined head, not ${checkpoint.exit}: ${result.tail}`)
    const metAtBase = checkpoint.kind === 'red-first' ? result.baseExit !== checkpoint.exit : result.baseExit === checkpoint.exit
    if (!metAtBase) problem(checkpoint.id, `checkpoint ${checkpoint.id} (${checkpoint.run}) exits ${result.baseExit} before the change: a ${checkpoint.kind} checkpoint ${checkpoint.kind === 'red-first' ? 'must not already pass' : 'must pass'} there`)
  }
  joined.vacuous.forEach((file) => problem(`vacuous-${file}`, `test ${file} passes without the change (vacuous)`))
  joined.outOfScope.forEach((file) => problem(`scope-${file}`, `${file} changed but is outside the lane's files`))
  const redFirst = checkpoints.some((checkpoint) => checkpoint.kind === 'red-first')
  const waived = written !== null && redFirst && findings.length === 0 && (built.disputes ?? []).length === 0
  return { findings, ...(waived ? { waiverAt: joined.sha } : {}) }
}

/** Scripts cannot import, so each script checks its own args (home/workflows/README.md); the error names the key and the expected shape. */
function checkArgs(given) {
  const name = 'join' // the tool cuts `meta` out of the body, so the script's own name is written here
  const check = (key, type) => {
    const value = given === undefined || given === null ? undefined : given[key]
    if (!(type === 'array' ? Array.isArray(value) : typeof value === type)) throw new Error(`${name}: args.${key} must be ${type === 'array' ? 'an array' : `a ${type}`}`)
  }
  for (const [key, type] of Object.entries({ row: 'string', closeRow: 'string', branch: 'string', base: 'string', statusFile: 'string', files: 'array', worktree: 'string', sha: 'string' })) check(key, type)
  for (const key of ['checkpoints', 'disputes']) if (given[key] !== undefined) check(key, 'array')
  const written = given.written
  if (written !== undefined && !['branch', 'worktree', 'sha'].every((key) => typeof written?.[key] === 'string')) throw new Error(`${name}: args.written must be {branch, worktree, sha} strings`)
}
