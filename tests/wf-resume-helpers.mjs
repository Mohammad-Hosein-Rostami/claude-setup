// Shared setup for the wf-resume tests: a temp "world" laid out as Claude Code 2.1.326 writes it (probe, round 5): transcripts and run
// folders under <projects>/<project>/<session>/, a per-session workflow registry, and the estimator's state folder. Nothing here touches the
// real ~/.claude. Exports: world(), PostToolUse input builders (launchInput), journal line builders (started, result, LAUNCHED).
import { mkdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
