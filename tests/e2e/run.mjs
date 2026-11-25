#!/usr/bin/env node
// The real-Claude end-to-end runner (plan Lane C and section 9): scenarios E0, E1, E6, E7, E9 and E11 drive real `claude -p` sessions of the setup
// under test in throwaway repos and a temp HOME, then check their transcripts, logs and git state. One line per check:
// `<scenario> <check> | <expected> | <observed> | PASS|FAIL|NOT RUN`, and `<out>/results.json`. Usage: `--help` (lib/cli.mjs).
// Exit: 0 every check passed, 1 a check failed or did not run, 2 usage error, no CS_E2E_LIVE=1 or not logged in, 3 stopped at
// a usage limit.
// Login: first the token is found (lib/stored-login.mjs: CLAUDE_CODE_OAUTH_TOKEN, else the claude-account store, read once
// with the real HOME; none: one line, exit 2); only the account name and the source are printed and kept. Then (lib/login.mjs)
// `claude auth status --json` runs with a child's env and the temp HOME; without a login the run prints one line and exits 2.
// A claude run refused its login stops the whole run (exit 2, one line).
// Safety (owner rules): a live run needs CS_E2E_LIVE=1, else nothing is made or started; `--dry-run` prints every setup step
// and command line and starts nothing; every `claude` argv comes from claudeArgs (an allowed `--model`, never Fable); every
// child gets childEnv (no API key, no auth token, no base URL); every write is inside the run root; the only remote is a bare
// repo in it; every printed or kept text is redacted; at a usage limit every scenario stops, the reset time is printed and
// nothing is retried; in a finally block and on SIGINT/SIGTERM every process group of the run is ended and checked gone; the
// root is removed only when this run made it. `--real-home` gives the real HOME only to a scenario that needs it (E9,
// `needsRealHome`); the others keep the temp HOME, and the dry run prints each scenario's HOME. E0(a) sets the answer mode
// the later jobs run in (lib/jobs.mjs, R8): once, or with `--resume` rounds until done.
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quietToolsDir } from '../clean-env.mjs';
import { testTempRoot } from '../temp-dir-helpers.mjs';
import { copyRedacted, keepTranscripts, scenarioRecord } from './lib/artifacts.mjs';
import { checkLine } from './lib/checks.mjs';
import { liveAllowed, LIVE_SWITCH, loadScenarios, parseArgs, USAGE, UsageError } from './lib/cli.mjs';
import { commonLines } from './lib/common.mjs';
import { makeContext, makeOps, makeRunState } from './lib/context.mjs';
import { childEnv, useLogin } from './lib/env.mjs';
import { buildHome, homePaths } from './lib/home.mjs';
import { ANSWER_MODES, answerModeOf } from './lib/jobs.mjs';
import { leakSnapshot, realRepoOf } from './lib/leaks.mjs';
import { LOGIN_LINE, loginPreflight, PREFLIGHT_ARGS } from './lib/login.mjs';
import { ALLOWED_MODELS, modelOfArgs } from './lib/models.mjs';
import { ProcessRegistry } from './lib/processes.mjs';
import { redact } from './lib/redact.mjs';
import { EXIT, exitCodeOf, formatLine, notRunLine, statusOf, writeResults } from './lib/report.mjs';
import { makeRunRoot, removeProjectFolders, removeRunRoot, removeStaleRoots, RUN_PREFIX } from './lib/scratch.mjs';
import { childPath, installShims } from './lib/shims.mjs';
import { resetText } from './lib/stream.mjs';
import { resolveLogin } from './lib/stored-login.mjs';

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE_REASON = 'E0(e) failed: the nested claude runs are not logged in on the subscription';
const GATE_ERROR = 'E0 stopped with an error, so its probes say nothing';
const LOGIN_STOP = 'stopped: a claude run was refused its login (no retry)';
const stampOf = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const say = (text) => console.log(redact(text));

/** The run's fixed files: the shims and their log. */
const runFiles = (root) => ({ bin: join(root, 'bin'), quietLog: join(root, 'quiet-tools.log') });

/** Prints the home, the shims and every scenario's setup and run steps; starts nothing. @returns {number} the exit code */
async function dryRun(options, scenarios) {
  const realHome = homedir();
  const root = join(testTempRoot(), `${RUN_PREFIX}<stamp>-XXXXXX`);
  const files = runFiles(root);
  const homeSteps = [];
  const ops = makeOps({ dry: true, root, record: (text) => homeSteps.push(text) });
  const paths = buildHome(ops, { root, setupFrom: options.setupFrom, realHome });
  const realPaths = options.realHomeMode ? homePaths(root, realHome, true) : null;
  installShims(ops, files);
  say(`e2e dry run: nothing is made or started. run root ${root}; HOME ${paths.home}${realPaths ? ` (the real HOME ${realPaths.home} only for a scenario that needs it)` : ''}; checkout ${options.setupFrom}`);
  for (const text of homeSteps) say(`home setup: ${text}`);
  say(`preflight: claude ${PREFLIGHT_ARGS.join(' ')} with the child env and HOME ${paths.home} (skipped in a dry run)`);
  const run = makeRunState({ dry: true, root, setupFrom: options.setupFrom, realHome, realHomeMode: options.realHomeMode, paths, realPaths,
    childPath: '<run bin>:<quiet tools>:$PATH', ...files, realRepo: realRepoOf(realHome, options.setupFrom), shimDirs: [] });
  const claudeSteps = [];
  for (const scenario of scenarios) {
    const ctx = makeContext(run, scenario);
    say(`# ${scenario.id} ${scenario.title} (model ${scenario.model}, ${scenario.minutes} min; HOME ${ctx.paths.home})`);
    await scenario.setup(ctx);
    ctx.phase = 'run';
    await scenario.run(ctx);
    for (const step of ctx.steps) say(`${scenario.id} ${step.phase}: ${step.text}`);
    claudeSteps.push(...ctx.steps.filter((step) => step.claudeArgs));
  }
  const unnamed = claudeSteps.filter((step) => !ALLOWED_MODELS.includes(modelOfArgs(step.claudeArgs)));
  say(`dry run: ${claudeSteps.length} claude command line(s); ${unnamed.length === 0 ? `each names --model ${ALLOWED_MODELS.join('|')}` : `${unnamed.length} without an allowed --model`}`);
  return unnamed.length === 0 ? EXIT.pass : EXIT.fail;
}

/** One scenario, live. @returns {Promise<{ctx: object, lines: object[]}>} */
async function runScenario(run, scenario) {
  const ctx = makeContext(run, scenario);
  try {
    await scenario.setup(ctx);
    ctx.phase = 'run';
    await scenario.run(ctx);
    ctx.phase = 'check';
    if (ctx.notRun) return { ctx, lines: [notRunLine(scenario.title, ctx.notRun)] };
    return { ctx, lines: [...(await scenario.check(ctx)), ...commonLines(ctx, scenario.minutes)] };
  } catch (error) {
    // `gate`: an E0 that threw proved nothing, so no later scenario runs either (gate is read only for E0)
    return { ctx, lines: [{ ...checkLine(`${scenario.title}: ${ctx.phase} ran to its end`, 'no error', error.message, false), gate: true, error: true }] };
  }
}

/**
 * Runs the scenarios in order; each is NOT RUN once the run stopped (a login refusal, a usage limit, an interrupt) or E0's
 * gate failed. @param {{print: Function, records: object[], outDir: string}} out
 */
async function runEach(run, scenarios, { print, records, outDir }) {
  let gate = null;
  for (const scenario of scenarios) {
    const skip = run.login ? LOGIN_STOP : run.limit ? 'stopped at the usage limit (no retry)' : run.interrupted ? 'the run was interrupted' : gate
      ?? (process.platform === 'win32' && scenario.needsShims ? 'needs the POSIX shims (plan section 10)' : null);
    if (skip) {
      const line = notRunLine(scenario.title, skip);
      print(scenario.id, line);
      records.push(scenarioRecord(scenario, null, [line]));
      continue;
    }
    say(`# ${scenario.id} ${scenario.title}`);
    const outcome = await runScenario(run, scenario);
    const { ctx } = outcome;
    // a login refusal: one line for the scenario instead of a FAIL per check that the refusal broke
    const lines = run.login ? [checkLine(`${scenario.title}: every claude run is logged in`, 'logged in', `${run.login.name}: ${run.login.text}`, false)] : outcome.lines;
    for (const line of lines) print(scenario.id, line);
    if (scenario.id === 'E0' && lines.some((line) => line.gate && statusOf(line) !== 'PASS')) gate = lines.some((line) => line.error) ? GATE_ERROR : GATE_REASON;
    if (scenario.id === 'E0') {
      // R8: how the later jobs run (lib/jobs.mjs); E0(a) not done or not run keeps the resume rounds
      run.answerMode = answerModeOf(ctx.notes.a);
      say(`e2e: E0 answer mode ${run.answerMode}: later jobs ${run.answerMode === ANSWER_MODES.direct ? 'run once' : 'get --resume rounds until done'}`);
    }
    copyRedacted(ctx.logs, join(outDir, scenario.id, 'logs'));
    records.push(scenarioRecord(scenario, ctx, lines));
  }
}

/** The whole live run (the header's safety rules). @returns {Promise<number>} the exit code */
async function liveRun(options, scenarios) {
  // the login first, with the real env and HOME (nothing made yet); the token goes to the child env and the redactor only
  const found = await resolveLogin({ setupFrom: options.setupFrom, useStore: options.storedLogin });
  if (!found.ok) {
    say(found.line);
    say(`e2e: ${found.detail}`);
    return EXIT.usage;
  }
  useLogin(found.token);
  const loginFrom = { source: found.source, name: found.name };
  const realHome = homedir();
  const madeRoots = new Set();
  const registry = new ProcessRegistry();
  const outDir = resolve(options.out ?? join(tmpdir(), `cs-e2e-results-${stampOf(new Date())}`));
  const all = [];
  const records = [];
  let loginMissing = false;
  // after a failed preflight the run prints only its one line, and a cleanup line only when it failed
  const print = (id, line) => { all.push(line); if (!loginMissing || statusOf(line) !== 'PASS') say(formatLine(id, line)); };
  const stale = removeStaleRoots();
  const root = makeRunRoot();
  madeRoots.add(root);
  const files = runFiles(root);
  let run = null;
  let signals = 0;
  const onSignal = (name) => {
    signals += 1;
    if (signals > 1) { registry.killAllNow(); process.exit(130); }
    say(`e2e: ${name}: stopping every scenario, then cleaning up (send it again to kill everything now)`);
    run?.interrupt();
  };
  const onInt = () => onSignal('SIGINT');
  const onTerm = () => onSignal('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  try {
    const ops = makeOps({ dry: false, root, record: () => {} });
    const paths = buildHome(ops, { root, setupFrom: options.setupFrom, realHome });
    const realPaths = options.realHomeMode ? homePaths(root, realHome, true) : null;
    const quietDir = quietToolsDir();
    const login = loginPreflight({ cwd: root, env: childEnv({ home: paths.home, tmp: paths.tmp, path: childPath(files.bin, quietDir),
      quietLog: files.quietLog, longRunState: paths.longRunState }) });
    if (!login.loggedIn) {
      loginMissing = true;
      say(LOGIN_LINE);
    } else {
      say(`e2e live run: root ${root}; results ${outDir}${stale.length ? `; removed ${stale.length} stale root(s)` : ''}; ${found.line}, ${login.detail}`);
      if (realPaths) say(`e2e: --real-home: only a scenario that needs it (E9) uses the real HOME ${realPaths.home} (owner opt-in); the rest keep the temp HOME`);
      installShims(ops, files);
      const realRepo = realRepoOf(realHome, options.setupFrom);
      run = makeRunState({ dry: false, root, setupFrom: options.setupFrom, realHome, realHomeMode: options.realHomeMode, paths, realPaths,
        childPath: childPath(files.bin, quietDir), ...files, registry, realRepo, shimDirs: [files.bin, quietDir].filter(Boolean) });
      run.before = leakSnapshot({ realHome, realRepo });
      await runEach(run, scenarios, { print, records, outDir });
    }
  } catch (error) {
    print('run', checkLine('the run set up and ran', 'no error', error.message, false));
  } finally {
    const left = await registry.endAll();
    print('run', checkLine('no process of the run is left', 'none', left.join(', ') || 'none', left.length === 0));
    if (run) {
      keepTranscripts(run.paths.projectsDir, root, join(outDir, 'transcripts'), false);
      copyRedacted(run.paths.logsDir, join(outDir, 'home-logs'));
      copyRedacted(join(root, 'long-run-state'), join(outDir, 'long-run-state'));
      if (run.realPaths) {
        // the real HOME: only the project folders of this run's root are kept, then removed
        keepTranscripts(run.realPaths.projectsDir, root, join(outDir, 'transcripts-real-home'), true);
        removeProjectFolders(run.realPaths.projectsDir, root);
      }
    }
    const removal = removeRunRoot(root, madeRoots);
    print('run', checkLine('the run root was removed', 'removed', removal.reason, removal.removed));
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  }
  const limit = run?.limit ?? null;
  const login = loginMissing ? { name: 'preflight', text: LOGIN_LINE } : run?.login ?? null;
  const code = exitCodeOf({ lines: all, limit, login });
  writeResults(outDir, { root, setupFrom: options.setupFrom, realHomeMode: options.realHomeMode, loginFrom, limit, login, exit: code, scenarios: records,
    run: all.filter((line) => !records.some((record) => record.lines.includes(line))) });
  if (loginMissing) return code;
  if (run?.login) say(`e2e: stopped: ${run.login.scenario} ${run.login.name} was refused its login (${run.login.text}); ${LOGIN_LINE}. Nothing was retried.`);
  if (limit) say(`e2e: stopped at a usage limit (${limit.kind}: ${limit.text}); it resets at ${resetText(limit)}. Nothing was retried.`);
  say(`e2e: ${all.filter((line) => statusOf(line) === 'PASS').length}/${all.length} PASS; exit ${code}; results ${join(outDir, 'results.json')}`);
  return code;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv, { setupFrom: CHECKOUT });
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`e2e: ${error.message}\n${USAGE}`);
    return EXIT.usage;
  }
  if (options.mode === 'help') { console.log(USAGE); return EXIT.pass; }
  const scenarios = await loadScenarios(options.ids);
  if (options.mode === 'list') {
    for (const scenario of scenarios) console.log(`${scenario.id}\t${scenario.model}\t${scenario.minutes} min\t${scenario.title}`);
    return EXIT.pass;
  }
  if (options.mode === 'dry') return dryRun(options, scenarios);
  if (!liveAllowed()) {
    console.error(`e2e: a live run starts real claude sessions on the owner's subscription; set ${LIVE_SWITCH}=1 to run it (or use --dry-run)`);
    return EXIT.usage;
  }
  return liveRun(options, scenarios);
}

process.exitCode = await main(process.argv.slice(2));
