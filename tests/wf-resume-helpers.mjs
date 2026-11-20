// Shared setup for the wf-resume tests: a temp "world" laid out as Claude Code 2.1.326 writes it (probe, round 5): transcripts and run
// folders under <projects>/<project>/<session>/, a per-session workflow registry, and the estimator's state folder. Nothing here touches the
// real ~/.claude. Exports: world(), PostToolUse input builders (launchInput), journal line builders (started, result, LAUNCHED), and the CLI
// test kit: cli (spawn with HOME = the world), inProcess (runCli with the clock passed in), seed (one registered run), registryBytes, markOf.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../home/tools/wf-resume/wf-resume.mjs';
import { launchRecord, runsOfSession, saveRun } from '../home/tools/wf-resume/lib/registry.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

export const NOW = Date.parse('2026-11-17T12:00:00Z');
export const MIN_MS = 60_000;
export const PROJECT = '-Users-me-proj';
export const started = (agentId, label, phase) => JSON.stringify({ type: 'started', key: `v2:${agentId}`, agentId, label, phase });
export const result = (agentId) => JSON.stringify({ type: 'result', key: `v2:${agentId}`, agentId, result: 'text', toolsUsed: ['Bash'] });
export const LAUNCHED = JSON.stringify({ type: 'launched' });
export const SCRIPT_TEXT = "export const meta = { name: 'land', description: 'x', phases: [{ title: 'Rebase' }, { title: 'Suite' }, { title: 'Land' }] };\nawait agent('x');\n";

/** The structured result Claude Code gives a Workflow launch (toolUseResult in the transcript). */
export const launchResponse = (runId, scriptPath, workflowName = 'land') => ({ status: 'async_launched', taskId: 'w1', taskType: 'local_workflow', workflowName, runId, summary: 's', transcriptDir: '/x', scriptPath });

/** A PostToolUse hook input for one Workflow launch. */
export function launchInput({ session = 'sess-1', runId = 'wf_aaa', scriptPath = '/s/land-wf_aaa.js', args, cwd = '/work/proj', toolInput, response, project = PROJECT, projectsRoot = '/home/u/.claude/projects' } = {}) {
  return {
    session_id: session, cwd, hook_event_name: 'PostToolUse', tool_name: 'Workflow',
    transcript_path: `${projectsRoot}/${project}/${session}.jsonl`,
    tool_input: toolInput ?? { scriptPath, ...(args === undefined ? {} : { args }) },
    tool_response: response ?? launchResponse(runId, scriptPath),
  };
}

// The notice prints these paths and cuts its text at a length cap, so tests that count the runs it shows need a short root (the launcher's TMPDIR is long).
const SHORT_TEMP_ROOT = '/tmp';

/** A temp world with the folders the hooks read. `addRun` writes the run folder of a session (journal lines, script copy, summary json). */
export async function world() {
  const root = realpathSync(makeTempDir('wf-resume-', SHORT_TEMP_ROOT));
  // root plays HOME, so a hook spawned with HOME=root finds the same folders the library functions are given.
  const claude = join(root, '.claude');
  const paths = { root, registryDir: join(claude, 'state', 'workflow-runs'), projectsRoot: join(claude, 'projects'), estimateDir: join(claude, 'state', 'estimate') };
  const sessionFolder = (session, project = PROJECT) => join(paths.projectsRoot, project, session);
  const addRun = ({ session, runId, lines, finished = false, summary = '{}', project = PROJECT, ageMin = 120, script = SCRIPT_TEXT }) => {
    const folder = sessionFolder(session, project);
    const runDir = join(folder, 'subagents', 'workflows', runId);
    mkdirSync(runDir, { recursive: true });
    const journal = join(runDir, 'journal.jsonl');
    writeFileSync(journal, `${lines.join('\n')}\n`);
    const when = new Date(NOW - ageMin * MIN_MS);
    utimesSync(journal, when, when);
    mkdirSync(join(folder, 'workflows', 'scripts'), { recursive: true });
    const scriptPath = join(folder, 'workflows', 'scripts', `land-${runId}.js`);
    writeFileSync(scriptPath, script);
    if (finished) writeFileSync(join(folder, 'workflows', `${runId}.json`), summary);
    return { folder, journal, scriptPath };
  };
  return { ...paths, sessionFolder, addRun };
}

export const KILLED = [LAUNCHED, started('a1', '4:rebase', 'Rebase'), result('a1'), started('a2', '4:suite', 'Suite')];
export const CLI = fileURLToPath(new URL('../home/tools/wf-resume/wf-resume.mjs', import.meta.url));

/** The CLI as a child process with HOME (and USERPROFILE) = the world, so it reads and writes only the test's own registry. */
export const cli = (w, ...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, HOME: w.root, USERPROFILE: w.root, CLAUDE_CONFIG_DIR: '' } });

/** The CLI in this process with the clock passed in (a test that depends on a journal's age never reads the wall clock). */
export const inProcess = (w, argv, nowMs) => runCli(argv, { registryDir: w.registryDir, projectsRoot: w.projectsRoot, estimateStateDir: w.estimateDir, cwd: '/work/proj', nowMs });

/** Registers one run (its run folder and its registry record, started at `at`); `mark` sets the record's `abandoned`. Returns the run folder's files. */
export function seed(w, { session = 'old-1', runId = 'wf_old', args = { row: '4', branch: 'lane/x' }, run = {}, at = '2026-11-17T10:00:00.000Z', mark } = {}) {
  const files = w.addRun({ session, runId, lines: KILLED, ...run });
  const record = launchRecord(launchInput({ session, runId, args, projectsRoot: w.projectsRoot, response: launchResponse(runId, files.scriptPath) }), at);
  saveRun(w.registryDir, mark === undefined ? record : { ...record, abandoned: mark });
  return files;
}

/** Every `.json` file of the registry folder, name and text, in name order. */
export const registryBytes = (w) => readdirSync(w.registryDir).filter((name) => name.endsWith('.json')).sort().map((name) => `${name}\n${readFileSync(join(w.registryDir, name), 'utf8')}`).join('\n--\n');

/** The `abandoned` field of one session's record of a run (undefined when it has none). */
export const markOf = (w, session, runId) => runsOfSession(w.registryDir, session).find((record) => record.runId === runId)?.abandoned;
