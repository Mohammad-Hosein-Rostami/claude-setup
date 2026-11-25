#!/usr/bin/env node
// The real-Claude end-to-end runner (plan Lane C and section 9): scenarios E0-E11 drive real `claude -p` sessions of the setup
// under test in throwaway repos and a temp HOME, then check their transcripts, logs and git state. One line per check:
// `<scenario> <check> | <expected> | <observed> | PASS|FAIL|NOT RUN`, and `<out>/results.json`. Usage: `--help` (lib/cli.mjs).
// Exit: 0 every check passed, 1 a check failed or did not run, 2 usage error or no CS_E2E_LIVE=1, 3 stopped at a usage limit.
// Safety (owner rules): a live run needs CS_E2E_LIVE=1, else nothing is made or started; `--dry-run` prints every setup step
// and command line and starts nothing; every `claude` argv comes from claudeArgs (an allowed `--model`, never Fable); every
// child gets childEnv (no API key, no auth token, no base URL); every write is inside the run root; the only remote is a bare
// repo in it; every printed or kept text is redacted; at a usage limit every scenario stops, the reset time is printed and
// nothing is retried; in a finally block and on SIGINT/SIGTERM every process group of the run is ended and checked gone; the
// root is removed only when this run made it.
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quietToolsDir } from '../clean-env.mjs';
import { removeTempDir, testTempRoot } from '../temp-dir-helpers.mjs';
import { copyRedacted, keepTranscripts, scenarioRecord } from './lib/artifacts.mjs';
import { checkLine } from './lib/checks.mjs';
import { liveAllowed, LIVE_SWITCH, loadScenarios, parseArgs, USAGE, UsageError } from './lib/cli.mjs';
import { commonLines } from './lib/common.mjs';
import { makeContext, makeOps, makeRunState } from './lib/context.mjs';
import { buildHome, homePaths } from './lib/home.mjs';
import { leakSnapshot, realRepoOf } from './lib/leaks.mjs';
import { ALLOWED_MODELS, modelOfArgs } from './lib/models.mjs';
import { ProcessRegistry } from './lib/processes.mjs';
import { redact } from './lib/redact.mjs';
import { EXIT, exitCodeOf, formatLine, notRunLine, statusOf, writeResults } from './lib/report.mjs';
import { makeRunRoot, removeProjectFolders, removeRunRoot, removeStaleRoots, RUN_PREFIX } from './lib/scratch.mjs';
import { childPath, installShims } from './lib/shims.mjs';
import { resetText } from './lib/stream.mjs';

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE_REASON = 'E0(e) failed: the nested claude runs are not logged in on the subscription';
const stampOf = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const say = (text) => console.log(redact(text));

/**
 * fake-dialog-tool.mjs loads pin-home.mjs, which sets this process's HOME to a fixed test folder; it is loaded only here, after
 * the real HOME was read, and HOME is put back, so the real HOME is still known (E10, E11, the settings copy).
 * @returns {Promise<typeof import('../fake-dialog-tool.mjs').fakePopup>}
 */
async function popupMaker() {
  const kept = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const { fakePopup } = await import('../fake-dialog-tool.mjs');
  for (const [name, value] of Object.entries(kept)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  return fakePopup;
}

/** The run's fixed files: shims, their logs and the dialog's answer. */
const runFiles = (root) => ({ bin: join(root, 'bin'), quietLog: join(root, 'quiet-tools.log'), dialogLog: join(root, 'dialog.log'),
  dialogModeFile: join(root, 'dialog-mode') });

/** Prints the home, the shims and every scenario's setup and run steps; starts nothing. @returns {number} the exit code */
async function dryRun(options, scenarios) {
  const realHome = homedir();
  const root = join(testTempRoot(), `${RUN_PREFIX}<stamp>-XXXXXX`);
  const files = runFiles(root);
  const homeSteps = [];
  const ops = makeOps({ dry: true, root, record: (text) => homeSteps.push(text) });
  const paths = options.realHomeMode ? homePaths(root, realHome, true) : buildHome(ops, { root, setupFrom: options.setupFrom, realHome });
  installShims(ops, { ...files, modeFile: files.dialogModeFile, popupDir: '<fake popup dir>' });
  say(`e2e dry run: nothing is made or started. run root ${root}; HOME ${paths.home}; checkout ${options.setupFrom}`);
  for (const text of homeSteps) say(`home setup: ${text}`);
  const run = makeRunState({ dry: true, root, setupFrom: options.setupFrom, realHome, realHomeMode: options.realHomeMode, paths,
    childPath: '<run bin>:<quiet tools>:$PATH', ...files, realRepo: realRepoOf(realHome, options.setupFrom), shimDirs: [] });
  const claudeSteps = [];
  for (const scenario of scenarios) {
    const ctx = makeContext(run, scenario);
    say(`# ${scenario.id} ${scenario.title} (model ${scenario.model}, ${scenario.minutes} min)`);
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
    return { ctx, lines: [checkLine(`${scenario.title}: ${ctx.phase} ran to its end`, 'no error', error.message, false)] };
  }
}

/** The whole live run (the header's safety rules). @returns {Promise<number>} the exit code */
async function liveRun(options, scenarios) {
  const realHome = homedir();
  const madeRoots = new Set();
  const registry = new ProcessRegistry();
  const outDir = resolve(options.out ?? join(tmpdir(), `cs-e2e-results-${stampOf(new Date())}`));
  const all = [];
  const records = [];
  const print = (id, line) => { all.push(line); say(formatLine(id, line)); };
  const stale = removeStaleRoots();
  const root = makeRunRoot();
  madeRoots.add(root);
  const files = runFiles(root);
  let run = null;
  let popupDir = null;
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
  say(`e2e live run: root ${root}; results ${outDir}${stale.length ? `; removed ${stale.length} stale root(s)` : ''}`);
  if (options.realHomeMode) say('e2e: --real-home: the children use the real HOME (owner opt-in)');
  try {
    const ops = makeOps({ dry: false, root, record: () => {} });
    const paths = options.realHomeMode ? homePaths(root, realHome, true) : buildHome(ops, { root, setupFrom: options.setupFrom, realHome });
    if (options.realHomeMode) for (const dir of [paths.longRunState, paths.tmp]) ops.mkdir(dir);
    const quietDir = quietToolsDir();
    if (process.platform !== 'win32') {
      popupDir = (await popupMaker())('deny').env.PATH.split(delimiter)[0];
      installShims(ops, { ...files, modeFile: files.dialogModeFile, popupDir });
    }
    const realRepo = realRepoOf(realHome, options.setupFrom);
    run = makeRunState({ dry: false, root, setupFrom: options.setupFrom, realHome, realHomeMode: options.realHomeMode, paths,
      childPath: childPath(files.bin, quietDir), ...files, registry, realRepo, shimDirs: [files.bin, quietDir].filter(Boolean) });
    run.before = leakSnapshot({ realHome, realRepo });
    let gate = null;
    for (const scenario of scenarios) {
      const skip = run.limit ? 'stopped at the usage limit (no retry)' : run.interrupted ? 'the run was interrupted' : gate
        ?? (process.platform === 'win32' && scenario.needsShims ? 'needs the POSIX shims (plan section 10)' : null);
      if (skip) {
        const line = notRunLine(scenario.title, skip);
        print(scenario.id, line);
        records.push(scenarioRecord(scenario, null, [line]));
        continue;
      }
      say(`# ${scenario.id} ${scenario.title}`);
      const { ctx, lines } = await runScenario(run, scenario);
      for (const line of lines) print(scenario.id, line);
      if (scenario.id === 'E0' && lines.some((line) => line.gate && statusOf(line) !== 'PASS')) gate = GATE_REASON;
      copyRedacted(ctx.logs, join(outDir, scenario.id, 'logs'));
      records.push(scenarioRecord(scenario, ctx, lines));
    }
  } catch (error) {
    print('run', checkLine('the run set up and ran', 'no error', error.message, false));
  } finally {
    const left = await registry.endAll();
    print('run', checkLine('no process of the run is left', 'none', left.join(', ') || 'none', left.length === 0));
    if (run) {
      keepTranscripts(run.paths.projectsDir, root, join(outDir, 'transcripts'), options.realHomeMode);
      if (!options.realHomeMode) copyRedacted(run.paths.logsDir, join(outDir, 'home-logs'));
      copyRedacted(join(root, 'long-run-state'), join(outDir, 'long-run-state'));
      if (options.realHomeMode) removeProjectFolders(run.paths.projectsDir, root);
    }
    if (popupDir) removeTempDir(popupDir);
    const removal = removeRunRoot(root, madeRoots);
    print('run', checkLine('the run root was removed', 'removed', removal.reason, removal.removed));
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  }
  const limit = run?.limit ?? null;
  const code = exitCodeOf({ lines: all, limit });
  writeResults(outDir, { root, setupFrom: options.setupFrom, realHomeMode: options.realHomeMode, limit, exit: code, scenarios: records,
    run: all.filter((line) => !records.some((record) => record.lines.includes(line))) });
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
