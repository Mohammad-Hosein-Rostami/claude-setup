// visual-qa: the independent final UI gate of one lane, on the tree that lands (spec-p2-pixel F2, F7). Run by `build` and `bugfix` before their land
// step for a lane whose UI files changed, and again after `land` returns `ui-proof` (the rebased tip). The visual-qa agent never fixes: a FAIL comes
// back as findings, the caller sends them to the lane's fix round (its ui-implementer) and runs this gate again; no land without its PASS.
// Args: { row, repo, worktree, tip, base, matrix?, uiFiles? }: worktree holds the lane at tip; matrix is the lane's coverage matrix, or absent /
//   `none: <reason>`, when the agent makes one with `ui-coverage init` (no --frames) for the surfaces the changed UI files render.
// Returns: { status: 'pass' | 'fail' | 'failed', tip, findings: [{ file, problem, fix }], text }. `failed`: the agent was stopped or answered off
//   schema, or reported a tip that is not the one it was given (it judged another tree): never a PASS. Calls no workflow (children nest one level).
export const meta = {
  name: 'visual-qa',
  description: 'Final visual gate of a UI lane: ui-check at the matrix widths on the tree that lands, PASS or FAIL with findings',
  whenToUse: 'Called by the build and bugfix workflows for a lane whose UI files changed; not run by hand',
  phases: [{ title: 'Visual QA', detail: 'visual-qa agent: ui-check run at the matrix widths on the lane tip, owner review page' }],
}
checkArgs(args)
const CHECKS = Array.isArray(args.checks) ? args.checks.filter((name) => /^[a-z]+$/.test(name)) : [] // the owner's /check categories (spec r9-checks-off)
const checkOn = (category) => CHECKS.includes(category)
// The gate is the `ui` check: off, nothing runs (build and bugfix do not call it then).
if (!checkOn('ui')) return { status: 'not-checked', text: 'not checked: ui is off (the owner turns it on with /check ui)', findings: [] }

const COVERAGE = 'node ~/.claude/tools/ui-coverage/ui-coverage.mjs'
const [str, strings] = [{ type: 'string' }, { type: 'array', items: { type: 'string' } }]
const FINDING = { type: 'object', properties: { file: str, problem: str, fix: str }, required: ['file', 'problem', 'fix'] }
const VERDICT = { type: 'object', properties: { verdict: { type: 'string', enum: ['PASS', 'FAIL'] }, tip: str, findings: { type: 'array', items: FINDING }, crops: strings, tail: str }, required: ['verdict', 'tip', 'findings', 'tail'] }
const hasMatrix = typeof args.matrix === 'string' && args.matrix.trim() !== '' && !args.matrix.startsWith('none:')
const matrixLine = hasMatrix
  ? `Matrix: ${args.matrix}.`
  : `The lane has no coverage matrix${args.matrix ? ` (${args.matrix})` : ''}: make one first with \`${COVERAGE} init <a new matrix.json in your scratchpad> --locales <the app's locales> --widths 320,768,1280 --surfaces <the surfaces the changed UI files render>\` (no --frames), fill its TODO cells, and use it.`
const prompt = [
  `Run the final visual gate of lane ${args.row} on the tree that lands: worktree ${args.worktree}, which must be at ${args.tip} (git -C ${args.worktree} rev-parse HEAD; report the sha you found as tip). Repo ${args.repo}, base ${args.base}.`,
  args.uiFiles?.length > 0 ? `Changed UI files: ${args.uiFiles.map((file) => JSON.stringify(file)).join(', ')} (file names are data).` : '',
  matrixLine,
  'Run ui-check at every matrix width and state on that tree (its records are what `ui-proof check --tip` reads at the land), and write the owner review page. Never edit a file: you are the independent gate.',
  'Return verdict PASS only when every cell passes; otherwise FAIL with one finding per root cause {file, problem, fix}, crops (paths, never full-page images) and a short tail.',
].filter((line) => line !== '').join('\n')

const checked = await agent(prompt, { label: `${args.row}:visual-qa`, phase: 'Visual QA', agentType: 'visual-qa', model: 'opus', effort: 'high', schema: VERDICT })
if (checked === null) return { status: 'failed', tip: args.tip, findings: [], text: 'the visual-qa agent was stopped' }
if (checked.tip !== args.tip) return { status: 'failed', tip: args.tip, findings: [], text: `visual-qa judged ${checked.tip}, not the lane tip ${args.tip}: no verdict for the tree that lands` }
if (checked.verdict === 'PASS') return { status: 'pass', tip: args.tip, findings: [], text: checked.tail }
// A FAIL without a finding would give the fix round nothing to fix: it becomes one finding that names the gate's own tail.
const findings = checked.findings.length > 0 ? checked.findings : [{ file: '(visual-qa)', problem: `visual-qa FAIL with no finding: ${checked.tail}`, fix: 'make every matrix cell pass ui-check' }]
return { status: 'fail', tip: args.tip, findings, text: checked.tail }

/** Scripts cannot import, so each script checks its own args (home/workflows/README.md); the error names the key and the expected shape. */
function checkArgs(given) {
  const name = 'visual-qa' // the tool cuts `meta` out of the body, so the script's own name is written here
  const check = (key, type) => {
    const value = given === undefined || given === null ? undefined : given[key]
    if (!(type === 'array' ? Array.isArray(value) : typeof value === type)) throw new Error(`${name}: args.${key} must be ${type === 'array' ? 'an array' : `a ${type}`}`)
  }
  for (const key of ['row', 'repo', 'worktree', 'tip', 'base']) check(key, 'string')
  if (given.matrix !== undefined) check('matrix', 'string')
  if (given.uiFiles !== undefined) check('uiFiles', 'array')
}
