#!/usr/bin/env node
// wf-resume: find and continue the workflow runs that did not finish (a killed process, a usage-limit stop, an exit, an account switch).
// Usage:
//   wf-resume.mjs list [--cwd <dir>] [--session <id>] [--into <session folder>]   the unfinished runs of a cwd and how to continue each
//   wf-resume.mjs call <runId>                          the exact Workflow call, with the args of the original launch
//   wf-resume.mjs adopt <runId> --into <session folder> [--from <session folder>]   copy the run's journal into another session, print the call
//   wf-resume.mjs abandon <runId>                       the owner gave the run up: mark it in the registry so `list` and the start notice skip it (no git; no worktree, branch or journal removed)
// Exit codes: 0 done, 1 refused (reason on stderr), 2 usage. Exports: runCli(argv, env).
// The registry (written by hooks/workflow-register.mjs) and the notice text are in lib/; see README.md for the whole flow.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stateDir as estimateStateDir } from '../estimate/lib/table-store.mjs';
import { adoptRun } from './lib/adopt.mjs';
import { LIVE_WINDOW_MS, fullCall, resumeNotice, sessionFolderOf } from './lib/notice.mjs';
import { RUN_ID, defaultRegistryDir, findRun, isAbandonMark, markAbandoned, runCopies } from './lib/registry.mjs';
import { inspectRun } from './lib/run-state.mjs';

const USAGE = `Usage:
  wf-resume.mjs list [--cwd <dir>] [--session <id>] [--into <session folder>]
  wf-resume.mjs call <runId>
  wf-resume.mjs adopt <runId> --into <session folder> [--from <session folder>]
  wf-resume.mjs abandon <runId>`;
const MS_PER_MINUTE = 60_000;

/** `--name value` pairs and the words that are not flags; a flag with no value, or an unknown flag, is a usage mistake (null). */
function parse(words, allowed) {
  const flags = {};
  const positional = [];
  for (let at = 0; at < words.length; at += 1) {
    if (!words[at].startsWith('--')) positional.push(words[at]);
    else if (allowed.includes(words[at].slice(2)) && at + 1 < words.length) flags[words[at].slice(2)] = words[(at += 1)];
    else return null;
  }
  return { flags, positional };
}

const refused = (err) => ({ code: 1, out: '', err });

/** The refusal text for the first unmarked copy of a run whose journal was written within LIVE_WINDOW_MS (it may still be running); null when none. */
function liveRefusal(copies, runId, env) {
  for (const copy of copies.filter((record) => !isAbandonMark(record.abandoned))) {
    const state = inspectRun(sessionFolderOf(copy, env.projectsRoot), copy, env.nowMs);
    if (state.state === 'unfinished' && state.ageMs < LIVE_WINDOW_MS) {
      return `run ${runId} may still be running (journal written ${Math.round(state.ageMs / MS_PER_MINUTE)} min ago): check /workflows`;
    }
  }
  return null;
}

/**
 * `abandon <runId>`: marks every copy of the run in the registry (see markAbandoned) so the notice and `list` stop showing it. Refuses an id that
 * is not a run id (never echoed), an id with no record, and a run with an unmarked copy whose journal was written within LIVE_WINDOW_MS. A run
 * whose copies are all marked is reported, not written again; a second call finishes a write that failed halfway. Runs no git.
 * @param {string} runId the one positional word
 * @param {{ registryDir: string, projectsRoot: string, nowMs: number }} env folders and the clock
 * @returns {{ code: number, out: string, err: string }}
 */
function abandonRun(runId, env) {
  if (!RUN_ID.test(runId)) return refused('not a run id');
  const copies = runCopies(env.registryDir, runId);
  if (copies.length === 0) return refused(`no run ${runId} in the workflow registry`);
  const live = liveRefusal(copies, runId, env);
  if (live !== null) return refused(live);
  if (copies.every((copy) => isAbandonMark(copy.abandoned))) return { code: 0, out: `${runId} already abandoned at ${copies.map((copy) => copy.abandoned).sort()[0]}`, err: '' };
  const done = markAbandoned(env.registryDir, runId, new Date(env.nowMs).toISOString());
  if (done.failed) return refused(done.marked === 0 ? 'registry not written' : 'registry not fully written (some records may be marked): run abandon again');
  if (done.marked > 0) return { code: 0, out: `abandoned ${runId} (${done.marked} record(s)); the start notice no longer lists it; relaunching it with Workflow lists it again`, err: '' };
  return done.already === null ? refused(`no run ${runId} in the workflow registry`) : { code: 0, out: `${runId} already abandoned at ${done.already}`, err: '' };
}

/**
 * @param {string[]} argv the words after the script name
 * @param {{ registryDir: string, projectsRoot: string, estimateStateDir: string, cwd: string, nowMs: number }} env folders, cwd and the clock
 * @returns {{ code: number, out: string, err: string }}
 */
export function runCli(argv, env) {
  const [command, ...rest] = argv;
  const usage = { code: 2, out: '', err: USAGE };
  if (command === 'list') {
    const parsed = parse(rest, ['cwd', 'session', 'into']);
    if (parsed === null || parsed.positional.length > 0) return usage;
    const { cwd = env.cwd, session = null, into = null } = parsed.flags;
    const text = resumeNotice({ sessionId: session, cwd, sessionFolder: into, source: 'startup', nowMs: env.nowMs }, { registryDir: env.registryDir, projectsRoot: env.projectsRoot, estimateStateDir: env.estimateStateDir });
    return { code: 0, out: text === '' ? `No unfinished workflow runs recorded for ${cwd}.` : text, err: '' };
  }
  if (command === 'call' || command === 'adopt') {
    const parsed = parse(rest, command === 'adopt' ? ['into', 'from'] : []);
    if (parsed === null || parsed.positional.length !== 1 || (command === 'adopt' && parsed.flags.into === undefined)) return usage;
    if (!RUN_ID.test(parsed.positional[0])) return { code: 1, out: '', err: 'not a run id' };
    const record = findRun(env.registryDir, parsed.positional[0]);
    if (record === null) return { code: 1, out: '', err: `no run ${parsed.positional[0]} in the workflow registry` };
    if (command === 'call') return { code: 0, out: fullCall(record), err: '' };
    const adopted = adoptRun({ record, into: parsed.flags.into, from: parsed.flags.from }, env.projectsRoot);
    return adopted.ok ? { code: 0, out: `${adopted.message}\nNext: ${fullCall(record)}`, err: '' } : { code: 1, out: '', err: adopted.message };
  }
  if (command === 'abandon') {
    const parsed = parse(rest, []);
    return parsed === null || parsed.positional.length !== 1 ? usage : abandonRun(parsed.positional[0], env);
  }
  return usage;
}

// ~/.claude/tools is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const projectsRoot = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  const outcome = runCli(process.argv.slice(2), { registryDir: defaultRegistryDir(), projectsRoot, estimateStateDir: estimateStateDir(), cwd: process.cwd(), nowMs: Date.now() });
  if (outcome.out !== '') console.log(outcome.out);
  if (outcome.err !== '') console.error(outcome.err);
  process.exitCode = outcome.code;
}
