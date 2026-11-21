#!/usr/bin/env node
// The token view (spec-p6 `r9-token-view`): where the tokens of a period went, from this machine's transcripts and the
// per-account limit logs. (a) limits against time per account; (b) use per role and per lane; (c) cache reads, writes, rebuilds
// and context fill; (d) waste; (e) general-purpose spawns per day (probe P6-13).
// Usage: node ~/.claude/tools/token-view/token-view.mjs [--days N] [--project <text>] [--detail] [--json]
//          [--projects <dir>] [--limits <dir>]
// Exports: main(argv) -> Promise<number> (the exit code), parseArgs(argv).
// Invariants: read-only; exit 0 with a view, 2 on a bad argument; `--projects` and `--limits` point it at fixture folders, so a
// test never reads the real ones. The transcript fields are undocumented (see lib/transcripts.mjs): a new CLI build can change them.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readLimitLogs } from './lib/limits.mjs';
import { printView, viewJson } from './lib/print.mjs';
import { summarise } from './lib/summary.mjs';
import { listRuns, readRun } from './lib/transcripts.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 7; // the limit logs keep 7 days, so a longer period would show use without its limits
const USAGE = 'usage: token-view.mjs [--days N] [--project <text>] [--detail] [--json] [--projects <dir>] [--limits <dir>]';

/**
 * Reads the command line.
 * @param {string[]} argv - the arguments after the script.
 * @returns {{days: number, project: string, detail: boolean, json: boolean, projects: string, limits: string}|{error: string}}
 */
export function parseArgs(argv) {
  const options = {
    days: DEFAULT_DAYS, project: '', detail: false, json: false,
    projects: join(homedir(), '.claude', 'projects'), limits: join(homedir(), '.claude', 'state', 'limits'),
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--detail' || flag === '--json') options[flag.slice(2)] = true;
    else if (['--days', '--project', '--projects', '--limits'].includes(flag) && i + 1 < argv.length) options[flag.slice(2)] = argv[++i];
    else return { error: `unknown or incomplete argument: ${flag}` };
  }
  options.days = Number(options.days);
  if (!Number.isFinite(options.days) || options.days <= 0) return { error: '--days takes a positive number' };
  return options;
}

/**
 * Prints the view.
 * @param {string[]} argv - the arguments after the script.
 * @returns {Promise<number>} 0 when the view printed, 2 on a bad argument.
 */
export async function main(argv) {
  const options = parseArgs(argv);
  if (options.error) {
    process.stderr.write(`token-view: ${options.error}\n${USAGE}\n`);
    return 2;
  }
  const sinceMs = Date.now() - options.days * DAY_MS;
  const listed = listRuns(options.projects, sinceMs).filter((run) => !options.project || run.project.includes(options.project));
  const runs = [];
  for (const run of listed) runs.push(await readRun(run)); // one file at a time: the lead's transcripts reach hundreds of MB
  const inPeriod = runs.map((run) => ({ ...run, messages: run.messages.filter((m) => m.t >= sinceMs) }));
  const view = summarise(inPeriod);
  const limits = readLimitLogs(options.limits, sinceMs);
  process.stdout.write(options.json ? `${JSON.stringify(viewJson(view, limits), null, 2)}\n` : `${printView(view, limits, options)}\n`);
  return 0;
}

// ~/.claude/tools is a symlink into the repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
