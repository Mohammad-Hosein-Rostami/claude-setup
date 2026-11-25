#!/usr/bin/env node
// Purpose: usage numbers for the agents of this setup, read from Claude Code's own transcripts: the per-agent table of the
//   final-pass plan (section 2) and the numbers its rules M1-M10 (section 7) need, so the review after real use is one command.
// Usage: node scripts/agent-usage.mjs [--since <iso>] [--project <key>] [--json]
//   --since    an ISO 8601 instant; transcripts last written before it are skipped (default: 7 days ago)
//   --project  one folder name under <config dir>/projects, the project key (default: every project)
//   --json     one JSON object { since, project, runs, rules, skippedLines, unreadable } instead of the text
// Reads: <config dir>/projects/<key>/<session>/subagents/*.jsonl (the agent type from the .meta.json beside each) and
//   <config dir>/projects/<key>/<session>.jsonl (the main session, the boss). <config dir> is CLAUDE_CONFIG_DIR, else ~/.claude.
// Output: a summary line, the table (one row per agent type; per-run columns are means, like the plan's baseline, report words
//   a median), then one line per rule `M<n> <what>: <number>`. A number with no runs behind it prints `no runs`, never 0%.
// Exit: 0, also when nothing matched (a zero table and `no runs since <iso>`); 2 on a bad or unknown flag or an unknown project.
// Exports: main(argv, env, nowMs) -> exit code.
// Invariants: reads only and prints counts only, never transcript text. A line that is not JSON is skipped and counted; a file
//   that cannot be read is named on stderr and skipped. Reading the transcripts is agent-usage/transcripts.mjs.
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { BIG_CONTEXT_TOKENS, LONG_SLEEP_SECONDS, collectRuns } from './agent-usage/transcripts.mjs';

const EXIT = { ok: 0, usage: 2 };
const USAGE = 'usage: node scripts/agent-usage.mjs [--since <iso>] [--project <key>] [--json]';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SINCE_DAYS = 7;
const MANY_EDITS = 60; // M1: own Edit/Write calls above this in one dev run
const REPORT_CAP_WORDS = { 'lex-web': 250, 'lex-scout': 200 }; // M8: the agents' own default caps
const MAP_CAP_WORDS = 500; // lex-scout's cap when its brief asks for a map
const BOSS_OWN_FILES = /REPORT-|HANDOFF|\/scratchpad\/|claude-setup-reports/; // M3: notes and reports the boss may touch
const RAISED_EFFORTS = new Set(['xhigh', 'max']);
const SAFE_PROJECT_KEY = /^(?!\.\.?$)[^/\\]+$/; // one folder name: no separator, not . or ..
const OPTIONS = { since: { type: 'string' }, project: { type: 'string' }, json: { type: 'boolean' } };

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const sum = (values) => values.reduce((total, value) => total + value, 0);
const mean = (values) => (values.length === 0 ? 0 : Math.round(sum(values) / values.length));
const share = (count, of) => ({ count, of, text: of === 0 ? 'no runs' : `${count} of ${of} (${Math.round((100 * count) / of)}%)` });
const tokens = (count) => (count >= 1e6 ? `${(count / 1e6).toFixed(1)}M` : `${(count / 1e3).toFixed(1)}k`);

/** The section 2 table: one row per agent type. */
function tableRows(agents) {
  return [...Map.groupBy(agents, (agent) => agent.type)].map(([type, list]) => {
    const each = (pick) => list.map((agent) => pick(agent.run));
    return {
      type, runs: list.length, coldStart: mean(each((run) => run.cold ?? 0)), contextPerRun: mean(each((run) => run.context)),
      turnsPerRun: mean(each((run) => run.turns)), bashPerRun: mean(each((run) => run.bash)),
      backgroundShells: sum(each((run) => run.backgroundStarts)), taskStops: sum(each((run) => run.stops)),
      sleepCommands: sum(each((run) => run.sleeps)), reportWords: median(each((run) => run.words)),
    };
  }).sort((a, b) => b.runs - a.runs || a.type.localeCompare(b.type));
}

/** Rules M1-M5: helpers, tess-simple, boss file calls, raised lex, tess on Opus. */
function rulesOneToFive(runsOf, boss) {
  const dev = runsOf('dev');
  const manyEdits = dev.filter((run) => run.edits > MANY_EDITS && !run.starts.some((start) => start.type === 'dev-part'));
  const simple = runsOf('tess-simple');
  const notReviewed = simple.filter((run) => /verdict: not reviewed/.test(run.lastText));
  const bossFiles = boss.map((run) => run.fileCalls.filter((path) => path && !BOSS_OWN_FILES.test(path)).length);
  const bossCalls = sum(bossFiles);
  const bossSessions = bossFiles.filter(Boolean).length;
  const lexStarts = boss.flatMap((run) => run.starts).filter((start) => start.type === 'lex');
  const raisedLex = lexStarts.filter((start) => RAISED_EFFORTS.has(start.effort));
  const tess = runsOf('tess');
  const tessBash = mean(tess.map((run) => run.bash));
  const tessContext = mean(tess.map((run) => run.context));
  return {
    M1: { label: `dev runs with > ${MANY_EDITS} own Edit/Write calls and no dev-part start`, ...share(manyEdits.length, dev.length) },
    M2: { label: 'tess-simple runs ending in verdict: not reviewed', ...share(notReviewed.length, simple.length) },
    M3: {
      label: 'boss Read/Edit/Write/Grep/Glob calls on project files', count: bossCalls, sessions: bossSessions,
      text: boss.length === 0 ? 'no runs' : `${bossCalls} calls in ${bossSessions} of ${boss.length} sessions`,
    },
    M4: { label: 'lex starts with effort xhigh or max', ...share(raisedLex.length, lexStarts.length) },
    M5: {
      label: 'tess own Bash per run and context read per run (means)', bash: tessBash, context: tessContext,
      text: tess.length === 0 ? 'no runs' : `${tessBash} Bash, ${tokens(tessContext)} over ${tess.length} runs`,
    },
  };
}

/** M6: vacuous tests over new tests, from tess reports' `tests:` line. */
function vacuousRule(tess) {
  const lines = tess.map((run) => /tests:[^\n]*/.exec(run.lastText)?.[0] ?? '').filter((line) => !/tests:\s*none/.test(line));
  const newTests = sum(lines.map((line) => Number(/(\d+) new/.exec(line)?.[1] ?? 0)));
  const vacuous = sum(lines.map((line) => Number(/(\d+) vacuous/.exec(line)?.[1] ?? 0)));
  return { label: 'tess-write tests reported vacuous, of new tests', ...share(vacuous, newTests) };
}

/** Whether a helper's report is over its word cap (a report-file brief has no cap). */
function overCap(type, run) {
  if (/report file|full text/i.test(run.brief ?? '')) return false;
  const cap = type === 'lex-scout' && /\bmap\b/i.test(run.brief ?? '') ? MAP_CAP_WORDS : REPORT_CAP_WORDS[type];
  return run.words > cap;
}

/** Rules M6-M10: vacuous tests, shells and sleeps, report caps, dev context, cache rebuilds. */
function rulesSixToTen(agents, runsOf) {
  const allRuns = agents.map((agent) => agent.run);
  const leftRunning = allRuns.filter((run) => run.tasksLeftRunning > 0).length;
  const longSleeps = sum(allRuns.map((run) => run.longSleeps));
  const helpers = agents.filter((agent) => agent.type in REPORT_CAP_WORDS);
  const overCapCount = helpers.filter((agent) => overCap(agent.type, agent.run)).length;
  const dev = runsOf('dev');
  const devTurns = sum(dev.map((run) => run.turns));
  const rebuilds = Object.fromEntries([...Map.groupBy(agents, (agent) => agent.type)].map(([type, list]) => {
    const context = sum(list.map((agent) => agent.run.context));
    return [type, context === 0 ? 0 : Math.round((1000 * sum(list.map((agent) => agent.run.gapCacheWrites))) / context) / 10];
  }));
  return {
    M6: vacuousRule(runsOf('tess')),
    M7: {
      label: `runs that reported with a background task still running; sleep commands of ${LONG_SLEEP_SECONDS} s or more`,
      runs: leftRunning, longSleeps, text: allRuns.length === 0 ? 'no runs' : `${leftRunning} runs; ${longSleeps} sleeps`,
    },
    M8: { label: 'lex-web and lex-scout reports over their word cap', ...share(overCapCount, helpers.length) },
    M9: { label: `dev turns above ${tokens(BIG_CONTEXT_TOKENS)} of context`, ...share(sum(dev.map((run) => run.bigTurns)), devTurns) },
    M10: {
      label: 'cache writes after a gap over 5 min, % of context read per agent type', byType: rebuilds,
      text: agents.length === 0 ? 'no runs' : Object.entries(rebuilds).map(([type, pct]) => `${type} ${pct}%`).join(', '),
    },
  };
}

/** The table and rule lines as text. */
function renderText(report) {
  const where = report.project ?? 'all projects';
  const total = sum(report.runs.map((row) => row.runs));
  const lines = [`agent-usage since ${report.since} (${where}): ${total} runs, ${report.skippedLines} unreadable lines skipped`];
  if (total === 0) lines.push(`no runs since ${report.since}`);
  lines.push('type | runs | cold start | context read/run | turns/run | own Bash/run | bg shells | TaskStop | sleep cmds | report words');
  for (const row of report.runs) {
    lines.push([row.type, row.runs, tokens(row.coldStart), tokens(row.contextPerRun), row.turnsPerRun, row.bashPerRun,
      row.backgroundShells, row.taskStops, row.sleepCommands, row.reportWords].join(' | '));
  }
  for (const [id, rule] of Object.entries(report.rules)) lines.push(`${id} ${rule.label}: ${rule.text}`);
  return `${lines.join('\n')}\n`;
}

/** Parsed flags, or { error } for a usage error (parseArgs throws on an unknown flag or a missing value). */
function readOptions(argv, nowMs) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS }));
  } catch (error) {
    return { error: error.message };
  }
  const sinceMs = values.since === undefined ? nowMs - DEFAULT_SINCE_DAYS * DAY_MS : Date.parse(values.since);
  if (Number.isNaN(sinceMs)) return { error: `--since is not an ISO 8601 instant: ${values.since}` };
  const project = values.project ?? null;
  if (project !== null && !SAFE_PROJECT_KEY.test(project)) return { error: `--project is not a folder name: ${project}` };
  return { sinceMs, project, json: values.json === true };
}

/** The project folders to read: every one under `root`, or the one named (null when it does not exist). */
function projectFolders(root, project) {
  const isFolder = (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
  if (project !== null) return isFolder(join(root, project)) ? [join(root, project)] : null;
  return isFolder(root) ? readdirSync(root).map((name) => join(root, name)).filter(isFolder) : [];
}

/** Runs the report; returns the exit code. */
export function main(argv, env = process.env, nowMs = Date.now()) {
  const options = readOptions(argv, nowMs);
  if (options.error) {
    process.stderr.write(`agent-usage: ${options.error}\n${USAGE}\n`);
    return EXIT.usage;
  }
  const root = join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
  const projectDirs = projectFolders(root, options.project);
  if (projectDirs === null) {
    process.stderr.write(`agent-usage: no such project under ${root}: ${options.project}\n${USAGE}\n`);
    return EXIT.usage;
  }
  const tally = { skippedLines: 0, unreadable: [] };
  const { agents, boss } = collectRuns(projectDirs, options.sinceMs, tally);
  const runsOf = (type) => agents.filter((agent) => agent.type === type).map((agent) => agent.run);
  const report = {
    since: new Date(options.sinceMs).toISOString(), project: options.project, runs: tableRows(agents),
    rules: { ...rulesOneToFive(runsOf, boss), ...rulesSixToTen(agents, runsOf) }, ...tally,
  };
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderText(report));
  return EXIT.ok;
}

if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) process.exitCode = main(process.argv.slice(2));
