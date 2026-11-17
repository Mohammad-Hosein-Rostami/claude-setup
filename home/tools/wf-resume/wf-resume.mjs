#!/usr/bin/env node
// wf-resume: find and continue the workflow runs that did not finish (a killed process, a usage-limit stop, an exit, an account switch).
// Usage:
//   wf-resume.mjs list [--cwd <dir>] [--session <id>] [--into <session folder>]   the unfinished runs of a cwd and how to continue each
//   wf-resume.mjs call <runId>                          the exact Workflow call, with the args of the original launch
//   wf-resume.mjs adopt <runId> --into <session folder> [--from <session folder>]   copy the run's journal into another session, print the call
// Exit codes: 0 done, 1 refused (reason on stderr), 2 usage.
// The registry (written by hooks/workflow-register.mjs) and the notice text are in lib/; see README.md for the whole flow.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stateDir as estimateStateDir } from '../estimate/lib/table-store.mjs';
import { adoptRun } from './lib/adopt.mjs';
import { fullCall, resumeNotice } from './lib/notice.mjs';
import { defaultRegistryDir, findRun } from './lib/registry.mjs';

const USAGE = `Usage:
  wf-resume.mjs list [--cwd <dir>] [--session <id>] [--into <session folder>]
  wf-resume.mjs call <runId>
  wf-resume.mjs adopt <runId> --into <session folder> [--from <session folder>]`;

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
    const record = findRun(env.registryDir, parsed.positional[0]);
    if (record === null) return { code: 1, out: '', err: `no run ${parsed.positional[0]} in the workflow registry` };
    if (command === 'call') return { code: 0, out: fullCall(record), err: '' };
    const adopted = adoptRun({ record, into: parsed.flags.into, from: parsed.flags.from }, env.projectsRoot);
    return adopted.ok ? { code: 0, out: `${adopted.message}\nNext: ${fullCall(record)}`, err: '' } : { code: 1, out: '', err: adopted.message };
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
