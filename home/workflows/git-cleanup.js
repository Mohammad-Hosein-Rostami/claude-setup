// git-cleanup workflow: find the old branches, worktrees and copies of each repo, prove which are merged, and remove
// only those (run it with the /wf-git-cleanup skill).
// Args: { row, repos: string[] } (absolute repo folders).
// Returns: { repos: { repo, applied, safe, needsLanding, ownerDecisions, vetoed, after }[], ownerItems: { repo, ref, question }[] }.
// Invariants: each repo goes inventory, plan, apply with no barrier between repos. The apply step runs only when the plan
// vetoes nothing the prune would remove; it first writes a backup bundle, then `git-tidy prune --apply` (which proves every
// removal itself), then `git-tidy check` again. Dirty worktrees, unique commits and published merges are never touched:
// they come back as owner items for the lead to ask.
export const meta = {
  name: 'git-cleanup',
  description: 'Clean old branches and worktrees in repos: inventory, Sonnet plan with patch-id proof, apply only proven items',
  whenToUse: 'Leftover branches, copies (-2, -3), merged worktrees or a tangled history in one or more repos',
  phases: [
    { title: 'Inventory', detail: 'git-tidy check and a dry prune per repo, saved to files' },
    { title: 'Plan', detail: 'Sonnet sorts every item: SAFE, NEEDS LANDING or OWNER DECISION, with patch-id proof' },
    { title: 'Apply', detail: 'backup bundle, git-tidy prune --apply, git-tidy check again' },
  ],
}
checkArgs(args)

const { row, repos } = args

const INVENTORY_SCHEMA = { type: 'object', properties: { repo: { type: 'string' }, checkFile: { type: 'string' }, pruneFile: { type: 'string' }, findings: { type: 'number' }, planned: { type: 'number' } }, required: ['repo', 'checkFile', 'pruneFile', 'findings', 'planned'] }
const REF_REASON = { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' }, why: { type: 'string' } }, required: ['ref', 'why'] } }
const PLAN_SCHEMA = { type: 'object', properties: { repo: { type: 'string' }, safe: { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' }, proof: { type: 'string' } }, required: ['ref', 'proof'] } }, needsLanding: REF_REASON, ownerDecisions: { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' }, question: { type: 'string' } }, required: ['ref', 'question'] } }, pruneVeto: REF_REASON }, required: ['repo', 'safe', 'needsLanding', 'ownerDecisions', 'pruneVeto'] }
const APPLY_SCHEMA = { type: 'object', properties: { repo: { type: 'string' }, pruneExit: { type: 'number' }, checkExit: { type: 'number' }, remaining: { type: 'number' } }, required: ['repo', 'pruneExit', 'checkExit', 'remaining'] }

const results = await pipeline(repos, inventory, plan, apply)
const kept = results.filter(Boolean)
return { repos: kept, ownerItems: kept.flatMap(ownerItemsOf) }

function nameOf(repo) {
  return repo.split('/').filter(Boolean).pop()
}

function workFolder(repo) {
  return `${repo}/.git/git-cleanup-${row}`
}

function inventory(repo) {
  return agent(`Repo ${repo}. Make the folder ${workFolder(repo)}, then save node ~/.claude/tools/git-tidy/git-tidy.mjs check ${repo} --json to check.json there and node ~/.claude/tools/git-tidy/git-tidy.mjs prune ${repo} --json (a dry run, no --apply) to prune.json there. Change nothing else. Return repo, the two file paths, the number of findings and the number of planned removals.`, { label: `${row}:inventory:${nameOf(repo)}`, phase: 'Inventory', agentType: 'runner', model: 'haiku', effort: 'medium', schema: INVENTORY_SCHEMA })
}

async function plan(inventoried, repo) {
  if (!inventoried) return null
  const planned = await agent(`Repo ${repo}. Read ${inventoried.checkFile} and ${inventoried.pruneFile}. Sort every item into: safe (its work is on the base, proven with git patch-id or git cherry; give the proof), needsLanding (unique commits that should reach the base first), ownerDecisions (anything whose fate is the owner's: dirty worktrees, unique commits to keep, published merges, rescue branches; give the question). Also list in pruneVeto every item the dry prune would remove that is NOT safe by your proof. Read only; delete nothing.`, { label: `${row}:plan:${nameOf(repo)}`, phase: 'Plan', agentType: 'general-purpose', model: 'sonnet', effort: 'high', schema: PLAN_SCHEMA })
  return planned ? { ...planned, repo } : null
}

async function apply(planned, repo) {
  if (!planned) return null
  const base = { repo, applied: false, safe: planned.safe, needsLanding: planned.needsLanding, ownerDecisions: planned.ownerDecisions, vetoed: planned.pruneVeto, after: null }
  if (planned.pruneVeto.length > 0) return base
  const after = await agent(`Repo ${repo}. Run exactly, in order: git -C ${repo} bundle create ${workFolder(repo)}/backup.bundle --all; then node ~/.claude/tools/git-tidy/git-tidy.mjs prune ${repo} --apply; then node ~/.claude/tools/git-tidy/git-tidy.mjs check ${repo}. Stop if the bundle fails. Never push; no other command. Return repo, the exit of prune and of check, and how many check findings remain.`, { label: `${row}:apply:${nameOf(repo)}`, phase: 'Apply', agentType: 'runner', model: 'haiku', effort: 'medium', schema: APPLY_SCHEMA })
  return { ...base, applied: Boolean(after) && after.pruneExit === 0, after }
}

/** What the lead must ask or land: the plan's owner questions, items needing landing, and vetoed removals. */
function ownerItemsOf(entry) {
  return [
    ...entry.ownerDecisions.map((item) => ({ repo: entry.repo, ref: item.ref, question: item.question })),
    ...entry.needsLanding.map((item) => ({ repo: entry.repo, ref: item.ref, question: `NEEDS LANDING: ${item.why}` })),
    ...entry.vetoed.map((item) => ({ repo: entry.repo, ref: item.ref, question: `Not removed: ${item.why}` })),
  ]
}

function checkArgs(given) {
  if (typeof given?.row !== 'string') throw new Error('git-cleanup: args.row must be a string')
  if (!Array.isArray(given.repos)) throw new Error('git-cleanup: args.repos must be an array')
}
