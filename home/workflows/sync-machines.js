// sync-machines workflow: bring this machine and each sync target to the same base tip (or the targets to a phase tag), check
// that every machine runs the same pinned Claude Code, install the setup and run doctor on each (run it with the /workflows skill, section sync-machines).
// Args: { row, repo, base, tag? }. `repo` is this machine's checkout; each target's checkout sits at the same path relative to
// the home folder. The targets come from this machine's git-ignored settings/local.json (`claudeSetup.syncTargets`, read by
// scripts/install/local-settings.mjs; none listed: `pc` over `ssh pc`). With `tag` (`r9-phase-N`) the targets get that tag and
// `install --update --to <tag>` (PLAN section 3: a target stays on the previous tag as the comparison); this machine stays on the tip.
// Returns: { status: 'stopped', problems } | { status: 'synced' | 'partial', machines: { machine, synced, sha, doctorExit, diagnosis }[] }.
// `synced` means every machine synced and its doctor exited 0; `partial` means one failed, and its row says why. One row per machine.
// Invariants: it starts only when the base folder has no tracked changes, git-tidy is clean, the full suite has a PASS at the base
// tip and, when review-tier ships an audit-log, `audit-log gate` exits 0 for the tip (untracked files are allowed and untouched).
// One CLI version per phase: it stops, naming the machine, when a machine is below the floor, has no DISABLE_UPDATES=1, is not
// on its local.json pin, or differs from another in version or release channel. Targets get the tip as a git bundle and a
// fast-forward pull (or a fetched tag), never a push; local.json values that are not machine-specific (`claudeSetup.shared`)
// are copied, never pushed. Every prompt that runs commands over ssh tells the runner to start each remote command with a PATH
// export (REMOTE_PATH_EXPORT: the target's non-interactive shell lacks ~/.local/bin and friends) and to wrap ssh in perl's alarm.
// A machine that cannot sync skips its doctor and gets a diagnosis; the others go on.
export const meta = {
  name: 'sync-machines',
  description: 'Sync this machine and its sync targets to the base tip (or the targets to a tag): bundle, ff-only pull, install, doctor on each; never pushes',
  whenToUse: 'After a landing on the setup repo, when every machine must run the same setup',
  phases: [
    { title: 'Verify', detail: 'no tracked changes, git-tidy clean, suite PASS and audit-log gate at the base tip; targets from settings/local.json' },
    { title: 'Versions', detail: 'claude --version, channel and DISABLE_UPDATES on every machine: one pinned CLI at or above the floor' },
    { title: 'Sync', detail: 'this machine install; each target bundle, ff-only pull (or tag), shared local values, install, side by side' },
    { title: 'Doctor', detail: 'doctor.sh on each machine that synced' },
  ],
}
checkArgs(args)

const LOCAL_MACHINE = 'macbook' // this machine's label in the rows; the targets are named in local.json
const CLI_FLOOR = '2.1.326' // the phase pin's floor on every machine (scripts/doctor.sh CLAUDE_FLOOR)
const DOCTOR_TIMEOUT_MS = 600000 // the Bash tool's maximum: doctor runs the suite when no PASS is recorded (about 4 minutes), so it stays in the foreground
// A non-interactive ssh shell on a target has a short PATH (no ~/.local/bin, ~/.volta/bin, /usr/local/bin, /opt/homebrew/bin), so
// `claude`, `node` and `git` are not found; every remote command starts with this export (harmless in Git Bash on Windows).
const REMOTE_PATH_EXPORT = 'export PATH="$HOME/.volta/bin:/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH";'
const SSH_TIMEOUT_SECONDS = 120 // a remote read or check; the MacBook has no `timeout` command, so ssh is wrapped in perl's alarm
const SYNC_SSH_TIMEOUT_SECONDS = 540 // the remote pull and install: under the Bash tool's 600 s maximum, so the alarm fires before the tool's own timeout
const TRANSFER_TIMEOUT_SECONDS = 300 // the scp of the bundle and shared file over a slow link (the PC sits behind a phone relay); under the same 600 s maximum
const DOCTOR_SSH_TIMEOUT_SECONDS = DOCTOR_TIMEOUT_MS / 1000 + 60 // doctor runs the suite, plus a margin over the Bash timeout
const VERSION_CHECK = 'claude --version once (on Windows a CLI install can leave no binary)'
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
const HOST = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/
const { row, repo, base, tag } = args

const TARGET = { type: 'object', properties: { name: { type: 'string' }, ssh: { type: 'string' } }, required: ['name', 'ssh'] }
// The runner reports one exit code per check or step; the script reads them (allExitedZero), never the runner's own ok.
const EXITS = { type: 'array', items: { type: 'number' } }
const VERIFY_SCHEMA = { type: 'object', properties: { exits: EXITS, sha: { type: 'string' }, problems: { type: 'array', items: { type: 'string' } }, targets: { type: 'array', items: TARGET } }, required: ['exits', 'sha', 'problems'] }
const CLI_SCHEMA = { type: 'object', properties: { version: { type: 'string' }, channel: { type: 'string' }, pinned: { type: 'boolean' }, pin: { type: 'string' } }, required: ['version', 'channel', 'pinned', 'pin'] }
const SYNC_SCHEMA = { type: 'object', properties: { exits: EXITS, sha: { type: 'string' }, tail: { type: 'string' } }, required: ['exits', 'sha', 'tail'] }
// The owner's /check categories (args.checks, spec r9-checks-off): check (4), the suite PASS, runs only with `test` on, (5), the audit-log
// gate, only with `review` on; the others are not checks of the code and always run. Doctor stays (the owner's command, spec "Safety floor").
const CHECKS = Array.isArray(args.checks) ? args.checks.filter((name) => /^[a-z]+$/.test(name)) : []
const checkOn = (category) => CHECKS.includes(category)
const VERIFY_CHECKS = checkOn('test') ? 5 : 4 // checks (1) to (3), (6) and with `test` (4) always run; (5) only with `review` and audit-log.mjs; (0) only with a tag
/** True when the reply lists at least `least` exit codes and every one is 0. */
const allExitedZero = (reply, least = 1) => Array.isArray(reply?.exits) && reply.exits.length >= least && reply.exits.every((exit) => exit === 0)
const DOCTOR_SCHEMA = { type: 'object', properties: { exit: { type: 'number' }, tail: { type: 'string' } }, required: ['exit', 'tail'] }

const runner = (step, prompt, phaseTitle, schema) => agent(prompt, { label: `${row}:${step}`, phase: phaseTitle, agentType: 'runner', model: 'haiku', effort: 'medium', schema })

phase('Verify')
const tagCheck = tag ? ` (0) git rev-parse --verify refs/tags/${tag} exits 0 (the target tag exists);` : ''
const ready = await runner('verify', `In ${repo} check, in this order, and stop at the first failure:${tagCheck} (1) git branch --show-current is ${base}; (2) git status --porcelain --untracked-files=no prints nothing; (3) node ~/.claude/tools/git-tidy/git-tidy.mjs check ${repo} --base ${base} exits 0; ${checkOn('test') ? `(4) with SHA from git rev-parse ${base}: node ~/.claude/tools/test-pass/test-pass.mjs check SHA --repo ${repo} --suite exits 0;` : `(4) skipped (test check off): SHA is git rev-parse ${base}, no exit code;`} ${checkOn('review') ? `(5) when ${repo}/home/tools/review-tier/audit-log.mjs exists, node ${repo}/home/tools/review-tier/audit-log.mjs gate --repo ${repo} --tip SHA exits 0 (a waived lane's audit is still open or found a defect: report its output);` : '(5) skipped (review check off), no exit code;'} (6) node ${repo}/scripts/install/local-settings.mjs targets prints JSON: return its targets array as targets (a failure is a problem line). Change nothing. Return exits (one exit code per check you ran, in order; for (1) and (2) 0 when it holds, else 1), sha, targets and one problem line per failed check.`, 'Verify', VERIFY_SCHEMA)
if (!allExitedZero(ready, VERIFY_CHECKS + (tag ? 1 : 0))) return { status: 'stopped', problems: ready ? ready.problems : ['verify step returned nothing'] }
const targets = checkedTargets(ready.targets)
if (typeof targets === 'string') return { status: 'stopped', problems: [targets] }
const machines = [LOCAL_MACHINE, ...targets.map((target) => target.name)]
const hostOf = Object.fromEntries(targets.map((target) => [target.name, target.ssh]))

phase('Versions')
const versions = await parallel(machines.map((machine) => () => runner(`cli:${machine}`, cliPrompt(machine), 'Versions', CLI_SCHEMA)))
const cliStops = cliProblems(machines, versions)
if (cliStops.length > 0) return { status: 'stopped', problems: cliStops }

const rows = await pipeline(machines, syncMachine, doctorMachine)
const results = machines.map((machine, index) => rows[index] ?? { machine, synced: false, sha: '', doctorExit: null, diagnosis: 'the steps for this machine returned nothing' })
const allGood = results.every((entry) => entry.synced && entry.doctorExit === 0)
return { status: allGood ? 'synced' : 'partial', machines: results }

/** The targets the verify step read, each name and host a plain word (they go into ssh and scp); a string says why not. */
function checkedTargets(given) {
  if (!Array.isArray(given) || given.length === 0) return 'no sync target: settings/local.json claudeSetup.syncTargets is empty and the verify step returned none'
  const bad = given.find((target) => !NAME.test(target?.name ?? '') || !HOST.test(target?.ssh ?? '') || target.name === LOCAL_MACHINE)
  return bad ? `sync target ${JSON.stringify(bad).slice(0, 120)} is not a plain name and ssh host (or uses the name ${LOCAL_MACHINE})` : given
}

/** A perl alarm that ends the command after `seconds` (this Mac has no timeout command); `or die` makes a failed exec exit non-zero, not 0. */
function alarmed(seconds) {
  return `perl -e 'alarm ${seconds}; exec @ARGV or die "exec: $!"'`
}

/** How the runner starts a command on a target: ssh inside an alarm, the PATH export inside the quoted remote command. */
function remoteRule(machine, seconds) {
  return `run each remote command as ${alarmed(seconds)} ssh ${hostOf[machine]} '${REMOTE_PATH_EXPORT} <command>', with the export inside the quotes so the target's shell runs it`
}

function where(machine, seconds = SSH_TIMEOUT_SECONDS) {
  return machine === LOCAL_MACHINE ? `in ${repo}` : `over ssh ${hostOf[machine]} (${remoteRule(machine, seconds)}), in that machine's checkout of the repo (the same path relative to the home folder as ${repo}; if it is not there, stop and report that, do not search)`
}

function cliPrompt(machine) {
  return `Run ${where(machine)}: claude --version (the x.y.z it prints is version); in ~/.claude/settings.json read autoUpdatesChannel (missing: "latest") as channel and env.DISABLE_UPDATES; pinned is true only when DISABLE_UPDATES is "1" there or in the shell environment; node scripts/install/local-settings.mjs targets prints cliVersion: return it as pin ("" when empty). Change nothing. Return version, channel, pinned and pin.`
}

/** Numeric x.y.z compare: true when `version` is `floor` or later (2.1.99 is older than 2.1.326). */
function atLeast(version, floor) {
  const [a, b] = [version, floor].map((text) => text.split('.').map(Number))
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index]
  return true
}

/** Every reason the machines do not run one pinned CLI at or above the floor, one line each naming the machine. */
function cliProblems(names, reports) {
  const problems = []
  names.forEach((machine, index) => {
    const report = reports[index]
    if (!report || !/^\d+\.\d+\.\d+$/.test(report.version ?? '')) return problems.push(`${machine}: claude --version gave no version`)
    if (!atLeast(report.version, CLI_FLOOR)) problems.push(`${machine}: claude ${report.version} is below the floor ${CLI_FLOOR}`)
    if (!report.pinned) problems.push(`${machine}: DISABLE_UPDATES=1 is not set, so the phase pin does not hold`)
    if (report.pin && report.pin !== report.version) problems.push(`${machine}: claude ${report.version}, but settings/local.json pins ${report.pin}`)
  })
  for (const key of ['version', 'channel']) {
    const seen = names.map((machine, index) => `${machine} ${reports[index]?.[key] ?? '?'}`)
    if (new Set(reports.map((report) => report?.[key])).size > 1) problems.push(`the machines differ in claude ${key === 'version' ? 'version' : 'release channel'}: ${seen.join(', ')}`)
  }
  return problems
}

function syncMachine(machine) {
  const steps = machine === LOCAL_MACHINE ? `In ${repo} run scripts/install.sh, then report git rev-parse HEAD. After the install run ${VERSION_CHECK}.` : targetSteps(machine)
  return runner(`sync:${machine}`, `${steps} Never push, never reset or force anything. Return exits (the exit code of each step you ran, in order), sha (HEAD afterwards) and the failing step's last 10 lines as tail.`, 'Sync', SYNC_SCHEMA)
}

function targetSteps(machine) {
  const host = hostOf[machine]
  const bundle = `/tmp/${row}-sync-${machine}.bundle`
  const shared = `/tmp/${row}-local-shared.json`
  const move = tag
    ? `git fetch ${bundle} refs/tags/${tag}:refs/tags/${tag}, then scripts/install.sh --update --to ${tag}`
    : `check git branch --show-current is ${base} and git status --porcelain --untracked-files=no prints nothing, then git pull --ff-only ${bundle} ${base}, then scripts/install.sh`
  return `Move the ${tag ? `tag ${tag}` : 'tip'} to ${machine}. (1) On this machine: git -C ${repo} bundle create ${bundle} ${tag ? `refs/tags/${tag}` : base}, then node ${repo}/scripts/install/local-settings.mjs shared ${shared}, then ${alarmed(TRANSFER_TIMEOUT_SECONDS)} scp ${bundle} ${shared} ${host}:/tmp/. (2) On ${machine}, ${where(machine, SYNC_SSH_TIMEOUT_SECONDS)}: node scripts/install/local-settings.mjs merge-shared ${shared}, then ${move}, then ${VERSION_CHECK} on ${machine}, never on this Mac. Run each ssh and scp as a foreground Bash command with timeout: 600000.`
}

async function doctorMachine(synced, machine) {
  if (!allExitedZero(synced)) return { machine, synced: false, sha: '', doctorExit: null, diagnosis: await diagnose(machine, synced?.tail ?? 'no result') }
  const doctor = await runner(`doctor:${machine}`, `Run scripts/doctor.sh ${where(machine, DOCTOR_SSH_TIMEOUT_SECONDS)}. It reuses a recorded suite PASS, else runs the whole suite and takes minutes: run it as ONE foreground Bash command with timeout: ${DOCTOR_TIMEOUT_MS}, never in the background and never in a polling loop. Return exit (doctor.sh's exit code) and the FAIL and WARN lines as tail.`, 'Doctor', DOCTOR_SCHEMA)
  const exit = doctor ? doctor.exit : null
  const diagnosis = exit === 0 ? '' : await diagnose(machine, doctor ? doctor.tail : 'doctor returned nothing')
  return { machine, synced: true, sha: synced.sha, doctorExit: exit, diagnosis }
}

function diagnose(machine, tail) {
  const remote = machine === LOCAL_MACHINE ? '' : ` Run any check on ${machine} ${where(machine)}; a fix command for ${machine} starts with ${REMOTE_PATH_EXPORT}`
  return agent(`The ${machine} sync of ${repo} failed. Output tail: ${tail}\nName the cause and the one command that fixes it, in 3 lines. Read only; run nothing that changes a machine.${remote}`, { label: `${row}:diagnose:${machine}`, phase: 'Doctor', agentType: 'general-purpose', model: 'sonnet', effort: 'medium' })
}

function checkArgs(given) {
  for (const key of ['row', 'repo', 'base']) {
    if (typeof given?.[key] !== 'string') throw new Error(`sync-machines: args.${key} must be a string`)
  }
  if (given.tag !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(given.tag)) throw new Error('sync-machines: args.tag must be a tag name')
}
