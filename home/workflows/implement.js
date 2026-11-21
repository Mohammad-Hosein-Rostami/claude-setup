// implement: one writer of one `build` lane, split out of build.js (C4). role 'implement': the lane's implementer, and when it ends early (stopped,
// or `unfinished: true`) a hand-over to a fresh agent from the branch tip with the six-field brief (spec, diff, last report, hand-over note); two
// stops in a row end it. role 'tests': the test-writer of a lane with acceptanceTests. Each brief carries the lines agent-model-guard would add
// (the UI matrix, the standing rules), since a workflow spawn does not fire it, and tells the agent to write its constraints into the lane's
// hand-over note first (beside STATUS.md, never committed) and re-read that note after a compaction.
// Args: { role: 'implement' | 'tests', row, branch, base, spec, files, statusFile, acceptanceTests, model, effort, agentType?, matrix?, checkpoints?, principles?,
//   baseSha? (the base tip the build started from: each writer's first command compares its HEAD with it, `wrongBase` on a mismatch) }
// Returns: the agent's report (IMPLEMENTED: branch, worktree, sha, tests, tier, disputes?, unfinished?, notRun?, caveats?; tests: branch, worktree,
//   sha) or null when the writer was stopped. Called by build.js only, inside its writer limit; it calls no workflow (children nest one level).
export const meta = {
  name: 'implement',
  description: 'One writer of a build lane: implementer with hand-over from the branch tip, or the acceptance test-writer',
  whenToUse: 'Called by the build workflow for each lane; not run by hand',
  phases: [{ title: 'Build', detail: 'implementer (hand-over when it ends early) or test-writer, in its own worktree' }],
}
checkArgs(args)
const CHECKS = Array.isArray(args.checks) ? args.checks.filter((name) => /^[a-z]+$/.test(name)) : [] // the owner's /check categories (spec r9-checks-off)
const checkOn = (category) => CHECKS.includes(category)
// The acceptance test-writer (role tests) is a `test` check: off, it writes nothing (build does not start it then).
if (args.role === 'tests' && !checkOn('test')) return { status: 'not-checked', text: 'not checked: test is off', branch: '', worktree: '', sha: '' }

const TEST_WRITER = { agentType: 'test-writer', model: 'sonnet', effort: 'medium' }
const [str, bool, strings] = [{ type: 'string' }, { type: 'boolean' }, { type: 'array', items: { type: 'string' } }]
const shape = (properties, required) => ({ type: 'object', properties, required })
const IMPLEMENTED = shape({ branch: str, worktree: str, sha: str, tests: { type: 'object' }, tier: { type: 'object' }, disputes: strings, unfinished: bool, notRun: strings, caveats: strings, wrongBase: str }, ['branch', 'worktree', 'sha', 'tests'])
const TESTS_WRITTEN = shape({ branch: str, worktree: str, sha: str, wrongBase: str }, ['branch', 'worktree', 'sha'])
const lane = { row: args.row, branch: args.branch, spec: args.spec, files: args.files, acceptanceTests: args.acceptanceTests, matrix: args.matrix, checkpoints: args.checkpoints,
  principles: args.principles, implementer: { agentType: args.agentType, model: args.model, effort: args.effort } }
const testBranch = (of) => `${of.branch}--tests`
// agent-model-guard does not fire for a workflow spawn, so the brief carries its two lines: the UI matrix and the standing rules (S3).
const matrixLine = (lane) => (lane.implementer.agentType === 'ui-implementer' ? `MATRIX: ${lane.matrix}\n` : '')
const standingRulesLine = `Read the \`## Standing rules\` of ${args.statusFile} (if it has any) first and follow them.\n`
// The lane's hand-over note sits beside STATUS.md (never committed): the brief's constraints go in first, so they survive a compaction of the agent.
const handoverNote = (lane) => `${args.statusFile.replace(/[\\/][^\\/]*$/, '')}/HANDOFF-${lane.row.replace(/[^A-Za-z0-9._-]+/g, '-')}.md`
const noteLine = (lane) => `First write this brief's constraints (the standing rules, the files you may touch, the run rules) under "## Constraints" in ${handoverNote(lane)} (never commit it) and re-read that file after any compaction. `
  + 'If you must stop before the lane is done: commit, write in that note what is done, what is left, the next step and what not to redo, then return unfinished true. '
// Base check (r9-wf-guards): an isolated worktree starts at the session folder's HEAD (worktree.baseRef head), so a session off the base, or a resumed
// agent whose worktree was removed, would build on other commits; the agent proves its start first and build.js never counts a wrongBase report.
const baseCheckLine = args.baseSha ? `First command: git rev-parse HEAD. If it does not print ${args.baseSha} (the tip of ${args.base} the build started from), change nothing and return at once with wrongBase "wrong base <what it printed> != ${args.baseSha}" (other fields empty).\n` : ''
const implementerPrompt = (lane) => `${matrixLine(lane)}${standingRulesLine}${baseCheckLine}Implement lane ${lane.row} of the spec ${lane.spec}: touch only ${lane.files.join(', ')}. ${noteLine(lane)}`
  + `Your worktree starts on a throwaway branch (git branch --show-current, named worktree-...). Branch ${lane.branch} must hold your work, based on ${args.base}: `
  + `if it does not exist yet, rename the throwaway branch with \`git branch -m ${lane.branch}\` (git rebase ${args.base} if it is not based on it); `
  + `if it already exists (a re-done lane) never make a copy: remove the old worktree that holds it (git worktree list, then git worktree remove <path>), run \`git switch ${lane.branch} && git rebase ${args.base}\`, and delete the throwaway branch (\`git branch -d <its name>\`). `
  + (checkOn('test') ? `Run only the tests related to your changes while iterating (quiet reporter), commit after each green step, never merge, never push. `
    : `Run no tests (the owner left the test check off): build carefully instead (read the code and the installed docs first, re-read your diff against the spec once, strict types); commit after each step, never merge, never push. `)
  + contractText(lane)
  + (checkOn('review') ? `Last run \`node ~/.claude/tools/review-tier/review-tier.mjs ${args.base}...HEAD --landing --json\` and return IMPLEMENTED: branch (must be ${lane.branch}), worktree (your pwd), sha (HEAD), tests {cmd, exit}, tier (that JSON).`
    : `Return IMPLEMENTED: branch (must be ${lane.branch}), worktree (your pwd), sha (HEAD), tests {cmd: "", exit: 0} (not checked: test), tier {}.`)
// The lane contract in the implementer's brief: checkpoints, principle questions, locked files, and the run rules (never the full suite: the review runs it once).
const lockedFiles = (lane) => [...new Set((lane.checkpoints ?? []).flatMap((checkpoint) => checkpoint.files))]
const contractText = (lane) => (checkOn('test') && lane.checkpoints?.length > 0 ? `Checkpoints (when you are done each \`run\` must exit with its exit code; a red-first one exits differently before your change): ${lane.checkpoints.map((checkpoint) => `${checkpoint.id}: \`${checkpoint.run}\` exit ${checkpoint.exit} (${checkpoint.kind})`).join('; ')}. ` : '')
  + (lane.principles?.length > 0 ? `Principle questions: answer each yes or no with file:line before you finish, a no is a finding: ${lane.principles.map((principle) => `${principle.id} ${principle.question}`).join(' ')} ` : '')
  + `Locked files (${[...lockedFiles(lane), ...(lane.acceptanceTests ? [`the test files of ${testBranch(lane)}`] : [])].join(', ') || 'none'}): never edit them; if one is wrong write \`contract-dispute: <file>: <why>\` in disputes instead. `
  + `Never run the full suite (the review runs it once at the tip); Bash timeout 600000 for a commit, 60000 for a probe. `
  + (lane.acceptanceTests ? `If branch ${testBranch(lane)} exists, cherry-pick ${args.base}..${testBranch(lane)} before the last review-tier run. ` : '')
const testWriterPrompt = (lane) => `${standingRulesLine}${baseCheckLine}Write the acceptance tests of lane ${lane.row} from the spec ${lane.spec} (files: ${lane.files.join(', ')}): test files only, each test fails without the behaviour it checks. `
  + `Your worktree starts on a throwaway branch (named worktree-...): rename it with \`git branch -m ${testBranch(lane)}\`. Commit; never merge, never push. Return branch, worktree (your pwd), sha (HEAD).`
// The hand-over brief (six fields; no field is trimmed for length): a fresh agent continues the lane from its branch tip, given spec, diff, report and note.
const handoverPrompt = (lane, last) => [
  `Objective and why: finish lane ${lane.row} of the spec ${lane.spec}. The agent before you ended early (${last === null ? 'it was stopped before it returned' : 'it returned unfinished'}); continue from the tip of ${lane.branch}, never start over, so no finished work is redone.`,
  `Inputs: the spec ${lane.spec}; the lane diff (git diff ${args.base}...${lane.branch}); the last report ${last === null ? '(none)' : JSON.stringify({ sha: last.sha, notRun: last.notRun ?? [], caveats: last.caveats ?? [] })}; the hand-over note ${handoverNote(lane)} (done, left, next step, don't redo): read it first. If the old worktree that holds ${lane.branch} has uncommitted changes, commit them on ${lane.branch} as \`wip(${lane.row}): hand-over\` before you remove it.`,
  `Constraints (keep every one; re-read the note after a compaction): the "## Constraints" section of that note, and this brief of the lane: ${implementerPrompt(lane)}`,
  'Tools and sources: the repo, its tests, the spec and the note (the memory of the agent before you); git log and git diff of the lane branch.',
  `Acceptance, with defaults where the spec is silent (related tests green, every checkpoint at its exit code, nothing outside the lane's files): the lane is done as its spec says and committed on ${lane.branch}.`,
  'Output: the IMPLEMENTED report the brief asks for, plus "Not run" as notRun (each check you did not run) and "Caveats" as caveats (what may still be wrong); unfinished true only if you must stop too, after updating the note.',
].join('\n')

if (args.role === 'tests') return await agent(testWriterPrompt(lane), { label: `${lane.row}:tests`, phase: 'Build', ...TEST_WRITER, isolation: 'worktree', schema: TESTS_WRITTEN })
const first = await agent(implementerPrompt(lane), {
  label: `${lane.row}:implement`, phase: 'Build', agentType: lane.implementer.agentType ?? 'implementer', model: lane.implementer.model, effort: lane.implementer.effort, isolation: 'worktree', schema: IMPLEMENTED,
})
return await handedOver(lane, first)

// A lane that ended early (stopped, or unfinished: true) goes on with a fresh agent from its branch tip; two stops in a row end it (the lead decides).
async function handedOver(lane, first) {
  let [last, stoppedBefore] = [first, first === null]
  while (last === null || last.unfinished === true) {
    const next = await agent(handoverPrompt(lane, last), {
      label: `${lane.row}:handover`, phase: 'Build', agentType: lane.implementer.agentType ?? 'implementer', model: lane.implementer.model, effort: lane.implementer.effort, isolation: 'worktree', schema: IMPLEMENTED,
    })
    if (next === null && stoppedBefore) return null
    stoppedBefore = next === null
    last = next ?? last
  }
  return last
}

/** Scripts cannot import, so each script checks its own args (home/workflows/README.md); the error names the key and the expected shape. */
function checkArgs(given) {
  const name = 'implement' // the tool cuts `meta` out of the body, so the script's own name is written here
  const check = (key, type) => {
    const value = given === undefined || given === null ? undefined : given[key]
    if (!(type === 'array' ? Array.isArray(value) : typeof value === type)) throw new Error(`${name}: args.${key} must be ${type === 'array' ? 'an array' : `a ${type}`}`)
  }
  for (const [key, type] of Object.entries({ role: 'string', row: 'string', branch: 'string', base: 'string', spec: 'string', files: 'array', statusFile: 'string', acceptanceTests: 'boolean', model: 'string', effort: 'string' })) check(key, type)
  for (const key of ['agentType', 'matrix', 'baseSha']) if (given[key] !== undefined) check(key, 'string')
  for (const key of ['checkpoints', 'principles']) if (given[key] !== undefined) check(key, 'array')
  if (given.role !== 'implement' && given.role !== 'tests') throw new Error(`${name}: args.role must be 'implement' or 'tests'`)
}
