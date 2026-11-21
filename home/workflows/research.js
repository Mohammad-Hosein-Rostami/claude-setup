// research workflow: an Opus scope splits a question into sub-questions, Sonnet gatherers research them in parallel and
// write notes with URLs, an Opus synthesis writes the report from the notes only, an Opus critic checks every claim,
// Sonnet re-checks fetch the disputed and every version, date and price claim again, and Sonnet applies every patch
// (run it with the /workflows skill, section research).
// Args: { row, question, out, depth: 'simple' | 'compare' | 'complex' }. `out` is the report file; the notes go to `<out>.notes/`.
// Returns: { path, unverified: { claim, url, why }[], error? } (`error` is set when a step returned nothing).
// Invariants: a gatherer's tool-call budget (10-15) is a sizing hint, never a stop: claims it could not finish come back
// marked unverified, never dropped. Version, date and price claims need two independent sources and are re-checked
// against their URL itself, whether or not the critic lists them. A sub-question whose gatherer returned nothing is named in
// the synthesis prompt and comes back unverified. The patch step has no cap on the number of patches.
export const meta = {
  name: 'research',
  description: 'Research a question: Opus scope, Sonnet gatherers in parallel, Opus synthesis and critic, URL re-checks, patches',
  whenToUse: 'A question that needs several sources: versions, limits, prices, standards, comparisons',
  phases: [
    { title: 'Scope', detail: 'Opus splits the question into sub-questions (1-2 simple, 2-4 compare, 5-8 complex)' },
    { title: 'Gather', detail: 'one Sonnet gatherer per sub-question writes notes with URLs' },
    { title: 'Synthesize', detail: 'Opus writes the report from the notes only' },
    { title: 'Critic', detail: 'Opus critic, Sonnet re-checks against the URLs, Sonnet applies every patch' },
  ],
}
checkArgs(args)

const QUESTION_COUNTS = { simple: [1, 2], compare: [2, 4], complex: [5, 8] }
const GATHER_TOOL_CALLS = '10-15'
const FACT_KINDS = ['fact', 'version', 'date', 'price']
const { row, question, out, depth } = args
const notesDir = `${out}.notes`
const [minQuestions, maxQuestions] = QUESTION_COUNTS[depth]

const SCOPE_SCHEMA = { type: 'object', properties: { questions: { type: 'array', minItems: minQuestions, maxItems: maxQuestions, items: { type: 'object', properties: { id: { type: 'string' }, question: { type: 'string' } }, required: ['id', 'question'] } } }, required: ['questions'] }
const CLAIM_SCHEMA = { type: 'object', properties: { claim: { type: 'string' }, url: { type: 'string' }, kind: { type: 'string', enum: FACT_KINDS }, sources: { type: 'number' }, unverified: { type: 'boolean' } }, required: ['claim', 'url', 'kind', 'sources', 'unverified'] }
const NOTES_SCHEMA = { type: 'object', properties: { id: { type: 'string' }, notesPath: { type: 'string' }, claims: { type: 'array', items: CLAIM_SCHEMA } }, required: ['id', 'notesPath', 'claims'] }
const REPORT_SCHEMA = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
const CRITIC_SCHEMA = { type: 'object', properties: { disputed: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, problem: { type: 'string' }, url: { type: 'string' } }, required: ['claim', 'problem', 'url'] } }, recheck: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, url: { type: 'string' }, kind: { type: 'string' } }, required: ['claim', 'url', 'kind'] } }, patches: { type: 'array', items: { type: 'object', properties: { where: { type: 'string' }, change: { type: 'string' } }, required: ['where', 'change'] } } }, required: ['disputed', 'recheck', 'patches'] }
const RECHECK_SCHEMA = { type: 'object', properties: { claim: { type: 'string' }, status: { type: 'string', enum: ['holds', 'wrong', 'unreachable'] }, correction: { type: 'string' }, evidence: { type: 'string' } }, required: ['claim', 'status', 'correction', 'evidence'] }
const PATCHED_SCHEMA = { type: 'object', properties: { path: { type: 'string' }, applied: { type: 'number' } }, required: ['path', 'applied'] }

phase('Scope')
const scope = await agent(`Research question: ${question}\nSplit it into ${minQuestions}-${maxQuestions} independent sub-questions that together answer it, each with a short id (q1, q2, ...). A sub-question that needs a version, date or price must say so. Do not research yet.`, { label: `${row}:scope`, phase: 'Scope', agentType: 'general-purpose', model: 'opus', effort: 'high', schema: SCOPE_SCHEMA })
if (!scope) return { path: null, unverified: [], error: 'scope step returned nothing' }

phase('Gather')
const answers = await pipeline(scope.questions, gather)
const gathered = answers.filter(Boolean)
const unanswered = scope.questions.filter((_, index) => !answers[index])
const notes = gathered.map((g) => g.notesPath)
if (notes.length === 0) return { path: null, unverified: unverifiedClaims(gathered, [], unanswered), error: 'no gatherer returned notes' }

phase('Synthesize')
const report = await agent(`Research question: ${question}\nWrite the report to ${out} from these notes only (read them, do not search the web): ${notes.join(', ')}. Every claim keeps its URL; a claim marked unverified in the notes stays marked unverified in the report; do not add a fact the notes lack.${unanswered.length > 0 ? ` These sub-questions got no notes; list each in the report as open and unanswered: ${unanswered.map((q) => `${q.id} (${q.question})`).join('; ')}.` : ''} Return the path.`, { label: `${row}:synthesize`, phase: 'Synthesize', agentType: 'general-purpose', model: 'opus', effort: 'high', schema: REPORT_SCHEMA })
if (!report) return { path: null, unverified: [], error: 'synthesis step returned nothing' }

phase('Critic')
const critic = await agent(`Check every claim of the report ${report.path} against the notes (${notes.join(', ')}): list a claim the notes do not support or contradict as disputed (with the URL), list EVERY version, date and price claim in the report under recheck (with its URL), and list each fix the report needs as a patch (where, change). Read only.`, { label: `${row}:critic`, phase: 'Critic', agentType: 'general-purpose', model: 'opus', effort: 'high', schema: CRITIC_SCHEMA })
if (!critic) return { path: report.path, unverified: unverifiedClaims(gathered, [], unanswered), error: 'critic step returned nothing' }
const checks = (await pipeline(claimsToRecheck(critic, gathered), recheck)).filter(Boolean)
const needsPatch = critic.patches.length > 0 || checks.some((c) => c.status !== 'holds')
if (needsPatch) {
  const patched = await agent(`Apply every one of these changes to ${report.path}, none left out. Critic patches: ${JSON.stringify(critic.patches)}. Claims whose URL says otherwise, with the corrected text: ${JSON.stringify(checks.filter((c) => c.status === 'wrong'))}. Claims whose URL could not be fetched: ${JSON.stringify(checks.filter((c) => c.status === 'unreachable').map((c) => c.claim))} (mark each one unverified in the report text). Return the path and the number of changes applied.`, { label: `${row}:patch`, phase: 'Critic', agentType: 'general-purpose', model: 'sonnet', effort: 'high', schema: PATCHED_SCHEMA })
  if (!patched) return { path: report.path, unverified: unverifiedClaims(gathered, checks, unanswered), error: 'patch step returned nothing: the report may still hold the claims the critic and the re-checks found wrong' }
}
return { path: report.path, unverified: unverifiedClaims(gathered, checks, unanswered) }

function gather(subQuestion) {
  return agent(`Research question: ${question}\nYour sub-question (${subQuestion.id}): ${subQuestion.question}\nSearch the web and read sources. About ${GATHER_TOOL_CALLS} tool calls is the size to aim for; it is a hint, not a stop: if you run out, return the claims you could not finish marked unverified, never drop them. Write notes to ${notesDir}/${subQuestion.id}.md: one entry per claim with its URL. A version, date or price claim needs two independent sources (sources: 2), else mark it unverified. Return id, notesPath and the claims.`, { label: `${row}:gather:${subQuestion.id}`, phase: 'Gather', agentType: 'general-purpose', model: 'sonnet', effort: 'high', schema: NOTES_SCHEMA })
}

/** The disputed claims, the critic's list and every gathered version, date or price claim, each once. */
function claimsToRecheck(critic, gatheredNotes) {
  const byClaim = new Map()
  const gatheredFigures = gatheredNotes.flatMap((note) => note.claims).filter((c) => c.kind !== 'fact')
  for (const item of [...critic.disputed, ...critic.recheck, ...gatheredFigures]) if (!byClaim.has(item.claim)) byClaim.set(item.claim, item)
  return [...byClaim.values()]
}

function recheck(item, _original, index) {
  return agent(`Claim: ${item.claim}. URL: ${item.url || 'none given, find the source in the notes'}. Do not trust the notes: fetch the URL again and read what it says now. Return status holds, wrong (with the corrected text) or unreachable (cannot be fetched or read).`, { label: `${row}:recheck:${index + 1}`, phase: 'Critic', agentType: 'general-purpose', model: 'sonnet', effort: 'high', schema: RECHECK_SCHEMA })
}

/** Claims no source could confirm: marked unverified by a gatherer, whose URL could not be read, or whose sub-question got no notes. */
function unverifiedClaims(gatheredNotes, checks, unansweredQuestions) {
  const found = new Map()
  for (const q of unansweredQuestions) found.set(q.question, { claim: q.question, url: '', why: 'its gatherer returned nothing' })
  for (const note of gatheredNotes) for (const c of note.claims) if (c.unverified) found.set(c.claim, { claim: c.claim, url: c.url, why: 'gatherer could not confirm it' })
  for (const check of checks) if (check.status === 'unreachable') found.set(check.claim, { claim: check.claim, url: '', why: 'URL could not be fetched again' })
  return [...found.values()]
}

function checkArgs(given) {
  for (const key of ['row', 'question', 'out', 'depth']) {
    if (typeof given?.[key] !== 'string') throw new Error(`research: args.${key} must be a string`)
  }
  if (!['simple', 'compare', 'complex'].includes(given.depth)) throw new Error('research: args.depth must be simple, compare or complex')
}
