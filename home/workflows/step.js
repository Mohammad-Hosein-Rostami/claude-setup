// step: one agent run as a workflow, so its progress shows in the workflow view and its label links to a STATUS.md row.
// The route for any single agent no other workflow covers: an architect design, a UI build, a visual-qa compare loop, a scout read.
// Args: { row, agentType, prompt, model, effort, isolation?, alone?, statusFile? }  (isolation: 'worktree' when the agent writes files next to other
//   writers; alone: true says no other writing agent runs, which is the only case a writer may run without isolation; statusFile: the project's
//   STATUS.md, whose `## Standing rules` the agent reads first).
// Returns: the agent's final text (null when it was stopped or died; the caller decides what that means).
// A workflow spawn does not fire agent-model-guard (probe P2), so the gates it holds for a plain Agent call are repeated here, shape only (a script has
// no file access): a UI agent (ui-implementer, visual-qa) needs a `MATRIX:` line in its prompt (a path, or `none:` with a reason of 15 or more
// characters); a writer (implementer, ui-implementer, test-writer, general-purpose, claude) needs isolation or `alone: true`; the model and effort are
// always named by the caller, so no routing is needed; statusFile adds the standing-rules line to the brief.
// Scripts cannot import, so checkArgs is repeated in each script (home/workflows/README.md).
export const meta = {
  name: 'step',
  description: 'Run one agent (any agent type, model and effort) as a workflow step with a STATUS.md row label',
  whenToUse: 'A single agent job that no other workflow covers: architect design, UI build, visual-qa final gate, a judgement read',
  phases: [{ title: 'Step', detail: 'one agent, the agent file or the given model and effort' }],
}
checkArgs(args)

const UI_AGENT_TYPES = ['ui-implementer', 'visual-qa']
const WRITER_TYPES = ['implementer', 'ui-implementer', 'test-writer', 'general-purpose', 'claude']
const MIN_REASON_CHARS = 15 // what ui-coverage asks of every reason
const MATRIX_LINE = /(?:^|\n)[ \t]*MATRIX:([^\r\n]*)/g
const matrixUsable = (prompt) => [...prompt.matchAll(MATRIX_LINE)].map((found) => found[1].trim())
  .some((value) => (value.startsWith('none:') ? value.slice('none:'.length).trim().length >= MIN_REASON_CHARS : value !== ''))
if (UI_AGENT_TYPES.includes(args.agentType) && !matrixUsable(args.prompt)) throw new Error(`step: a ${args.agentType} prompt needs a line \`MATRIX: <path>\` or \`MATRIX: none: <reason of ${MIN_REASON_CHARS}+ characters>\` (ui-coverage init makes the matrix)`)
if (WRITER_TYPES.includes(args.agentType) && args.isolation !== 'worktree' && args.alone !== true) throw new Error(`step: a ${args.agentType} writes files: pass isolation "worktree", or alone true when no other writer runs`)

const standingRules = args.statusFile ? `Read the \`## Standing rules\` of ${args.statusFile} first and follow them.\n` : ''
const options = { label: `${args.row}:step`, phase: 'Step', agentType: args.agentType, model: args.model, effort: args.effort }
if (args.isolation) options.isolation = args.isolation
return await agent(`${standingRules}${args.prompt}`, options)

function checkArgs(given) {
  const name = 'step' // the tool cuts `meta` out of the body, so the script's own name is written here
  const required = { row: 'string', agentType: 'string', prompt: 'string', model: 'string', effort: 'string' }
  const optional = { isolation: 'string', alone: 'boolean', statusFile: 'string' }
  const check = (key, type) => {
    const value = given === undefined || given === null ? undefined : given[key]
    const ok = type === 'array' ? Array.isArray(value) : typeof value === type
    if (!ok) throw new Error(`${name}: args.${key} must be ${type === 'array' ? 'an array' : `a ${type}`}`)
  }
  for (const [key, type] of Object.entries(required)) check(key, type)
  for (const [key, type] of Object.entries(optional)) if (given[key] !== undefined) check(key, type)
}
