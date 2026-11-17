// sync-machines workflow: bring the MacBook and the PC to the same base tip, install the setup and run doctor on both
// (run it with the /wf-sync skill).
// Args: { row, repo, base }. `repo` is this machine's checkout of the repo; the PC's checkout sits at the same path
// relative to the home folder.
// Returns: { status: 'stopped', problems } | { status: 'synced' | 'partial', machines: { machine, synced, sha, doctorExit, diagnosis }[] }.
// `synced` means every machine synced and its doctor exited 0; `partial` means one failed, and its row says why. There is one row per machine.
// Invariants: it starts only when the base folder has no tracked changes, git-tidy is clean and the full suite has a PASS
// at the base tip (untracked files are allowed and untouched). The PC gets the tip as a git bundle and a fast-forward
// pull, never a push. A machine that cannot sync skips its doctor and gets a diagnosis; the other machine goes on.
export const meta = {
  name: 'sync-machines',
  description: 'Sync the MacBook and the PC to the base tip: bundle, ff-only pull, install, doctor on both; never pushes',
  whenToUse: 'After a landing on the setup repo, when both machines must run the same setup',
  phases: [
    { title: 'Verify', detail: 'no tracked changes, git-tidy clean, suite PASS at the base tip' },
    { title: 'Sync', detail: 'MacBook install; PC bundle, ff-only pull, install, side by side' },
    { title: 'Doctor', detail: 'doctor.sh on each machine that synced' },
  ],
}
checkArgs(args)

const MACHINES = ['macbook', 'pc']
const DOCTOR_TIMEOUT_MIN = 30 // doctor runs the whole suite; with no measured duration yet, the lead's long-command default
const { row, repo, base } = args

const VERIFY_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' }, sha: { type: 'string' }, problems: { type: 'array', items: { type: 'string' } } }, required: ['ok', 'sha', 'problems'] }
const SYNC_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' }, sha: { type: 'string' }, tail: { type: 'string' } }, required: ['ok', 'sha', 'tail'] }
const DOCTOR_SCHEMA = { type: 'object', properties: { exit: { type: 'number' }, tail: { type: 'string' } }, required: ['exit', 'tail'] }

const runner = (step, prompt, phaseTitle, schema) => agent(prompt, { label: `${row}:${step}`, phase: phaseTitle, agentType: 'runner', model: 'haiku', effort: 'low', schema })

phase('Verify')
const ready = await runner('verify', `In ${repo} check, in this order, and stop at the first failure: (1) git branch --show-current is ${base}; (2) git status --porcelain --untracked-files=no prints nothing; (3) node ~/.claude/tools/git-tidy/git-tidy.mjs check ${repo} --base ${base} exits 0; (4) with SHA from git rev-parse ${base}: node ~/.claude/tools/test-pass/test-pass.mjs check SHA --repo ${repo} --suite exits 0. Change nothing. Return ok, sha and one problem line per failed check.`, 'Verify', VERIFY_SCHEMA)
if (!ready || !ready.ok) return { status: 'stopped', problems: ready ? ready.problems : ['verify step returned nothing'] }

const rows = await pipeline(MACHINES, syncMachine, doctorMachine)
const machines = MACHINES.map((machine, index) => rows[index] ?? { machine, synced: false, sha: '', doctorExit: null, diagnosis: 'the steps for this machine returned nothing' })
const allGood = machines.every((entry) => entry.synced && entry.doctorExit === 0)
return { status: allGood ? 'synced' : 'partial', machines }

function syncMachine(machine) {
  const steps = machine === 'pc' ? pcSteps() : `In ${repo} run scripts/install.sh, then report git rev-parse HEAD.`
  return runner(`sync:${machine}`, `${steps} Never push, never reset or force anything. Return ok (every step exited 0), sha (HEAD afterwards) and the failing step's last 10 lines as tail.`, 'Sync', SYNC_SCHEMA)
}

function pcSteps() {
  const bundle = `/tmp/${row}-sync.bundle`
  return `Move the tip to the PC. (1) On this machine: git -C ${repo} bundle create ${bundle} ${base}, then scp ${bundle} pc:${bundle}. (2) ssh pc, in the PC's checkout of this repo (the same path relative to the home folder as ${repo}; if it is not there, stop and report that, do not search): check git branch --show-current is ${base} and git status --porcelain --untracked-files=no prints nothing, then git pull --ff-only ${bundle} ${base}, then scripts/install.sh.`
}

async function doctorMachine(synced, machine) {
  if (!synced?.ok) return { machine, synced: false, sha: '', doctorExit: null, diagnosis: await diagnose(machine, synced?.tail ?? 'no result') }
  const where = machine === 'pc' ? `over ssh pc in the PC's checkout of the repo (same path relative to the home folder as ${repo})` : `in ${repo}`
  const doctor = await runner(`doctor:${machine}`, `Run scripts/doctor.sh ${where}. It runs the whole test suite and takes minutes: start it in the background with a ${DOCTOR_TIMEOUT_MIN} minute timeout and wait for it. Return exit (doctor.sh's exit code) and the FAIL and WARN lines as tail.`, 'Doctor', DOCTOR_SCHEMA)
  const exit = doctor ? doctor.exit : null
  const diagnosis = exit === 0 ? '' : await diagnose(machine, doctor ? doctor.tail : 'doctor returned nothing')
  return { machine, synced: true, sha: synced.sha, doctorExit: exit, diagnosis }
}

function diagnose(machine, tail) {
  return agent(`The ${machine} sync of ${repo} failed. Output tail: ${tail}\nName the cause and the one command that fixes it, in 3 lines. Read only; run nothing that changes a machine.`, { label: `${row}:diagnose:${machine}`, phase: 'Doctor', agentType: 'general-purpose', model: 'sonnet', effort: 'medium' })
}

function checkArgs(given) {
  for (const key of ['row', 'repo', 'base']) {
    if (typeof given?.[key] !== 'string') throw new Error(`sync-machines: args.${key} must be a string`)
  }
}
