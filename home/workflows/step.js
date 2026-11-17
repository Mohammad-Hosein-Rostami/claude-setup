// step: one agent run as a workflow, so its progress shows in the workflow view and its label links to a STATUS.md row.
// The route for any single agent no other workflow covers: an architect design, a UI build, a visual-qa compare loop, a scout read.
// Args: { row, agentType, prompt, model, effort, isolation? }  (isolation: 'worktree' when the agent writes files next to other writers).
// Returns: the agent's final text (null when it was stopped or died; the caller decides what that means).
// Scripts cannot import, so checkArgs is repeated in each script (home/workflows/README.md).
export const meta = {
  name: 'step',
  description: 'Run one agent (any agent type, model and effort) as a workflow step with a STATUS.md row label',
  whenToUse: 'A single agent job that no other workflow covers: architect design, UI build, visual-qa loop, a judgement read',
  phases: [{ title: 'Step', detail: 'one agent, the agent file or the given model and effort' }],
}
checkArgs(args)

const options = { label: `${args.row}:step`, phase: 'Step', agentType: args.agentType, model: args.model, effort: args.effort }
if (args.isolation) options.isolation = args.isolation
return await agent(args.prompt, options)

function checkArgs(given) {
  const name = 'step' // the tool cuts `meta` out of the body, so the script's own name is written here
  const required = { row: 'string', agentType: 'string', prompt: 'string', model: 'string', effort: 'string' }
  const optional = { isolation: 'string' }
  const check = (key, type) => {
    const value = given === undefined || given === null ? undefined : given[key]
    const ok = type === 'array' ? Array.isArray(value) : typeof value === type
    if (!ok) throw new Error(`${name}: args.${key} must be ${type === 'array' ? 'an array' : `a ${type}`}`)
  }
  for (const [key, type] of Object.entries(required)) check(key, type)
  for (const [key, type] of Object.entries(optional)) if (given[key] !== undefined) check(key, type)
}
