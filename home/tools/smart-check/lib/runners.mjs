// Purpose: run one planned check kind at its level (spec r9-smart-check 2, run.mjs): the scoped type check (the project's typecheck
//   script, else an incremental tsc of the nearest tsconfig), lint filtered to the changed lines, affected tests (this repo's
//   scripts/affected-tests.mjs through test-pass, `vitest related`, `jest --findRelatedTests`), the build script, the ui crop or matrix
//   through ui-check `responsive`, hook probes; the deep review and visual-qa are handed to the lead (only the lead starts agents).
// Exports: runKind(row, plan, deadline), commandResult(cmd, args, options), MAX_FINDING_LINES.
// Invariants: binaries come only from the project's node_modules/.bin (typecheck-plan's projectBin) or the setup's own tools, never
//   npx; build info, lint cache and screenshots go to the smart-check state folder, never into the project; every command gets at most
//   what is left of the deadline and is killed after it; a check that cannot run is `error` or `not-run` with its reason, never a pass.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nearestTsconfig, projectBin, projectFolders, readJsonFile } from '../../../hooks/lib/typecheck-plan.mjs';
import { stateDir } from '../ledger.mjs';
import { cheapLens } from './lens.mjs';

export const MAX_FINDING_LINES = 15; // what reaches the agent of one failing check (round 1, 8.1 token rule)
const TOOLS = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 10_000;
const FOLDER_LOOKUP_MS = 5_000;
const CROP_WIDTHS = [320, 1440, 768]; // 320 (WCAG reflow), the usual design width, the common tablet edge (round 2, 9.2)
const MATRIX_WIDTHS = [320, 599, 600, 767, 768, 1023, 1024, 1279, 1280, 1440]; // bp-1 and bp of the common breakpoints, design, widest

/** Runs one command with what is left of the deadline. @returns {{exit: number|null, out: string, timedOut: boolean, seconds: number}} */
export function commandResult(cmd, args, { cwd, deadline, env = process.env, input = '' }) {
  const timeout = Math.max(1000, deadline - Date.now());
  const started = Date.now();
  const result = spawnSync(cmd, args, { cwd, env, input, encoding: 'utf8', timeout, maxBuffer: OUTPUT_MAX_BYTES, windowsHide: true, killSignal: 'SIGKILL' });
  return { exit: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}`, timedOut: result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGKILL', seconds: (Date.now() - started) / 1000, failed: result.error && result.error.code !== 'ETIMEDOUT' ? result.error.message : '' };
}

const clean = (text) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, 300);
const linesOf = (text) => text.split('\n').map(clean).filter((line) => line.trim());
const outcome = (result, kind, findings) => {
  if (result.timedOut) return { result: 'not-run', note: `${kind}: out of time`, seconds: result.seconds };
  if (result.failed) return { result: 'error', note: `${kind}: ${result.failed}`, seconds: result.seconds };
  if (result.exit === 0) return { result: 'pass', seconds: result.seconds };
  const shown = findings ?? linesOf(result.out);
  return { result: 'catch', findings: shown.slice(0, MAX_FINDING_LINES), seconds: result.seconds };
};

/** `npm`, `pnpm` or `yarn`, by the lockfile at the top. */
const packageManager = (top) => (existsSync(join(top, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(top, 'yarn.lock')) ? 'yarn' : 'npm');
const scriptRun = (plan, name, deadline) => commandResult(packageManager(plan.top), ['run', '--silent', name], { cwd: plan.top, deadline });
const binOf = (plan, tool) => projectBin(projectFolders(plan.top, FOLDER_LOOKUP_MS), tool);
const privateDir = (name) => { const dir = join(stateDir(), name); mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; };
const keyOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

function runTypes(row, plan, deadline) {
  const script = ['typecheck', 'type-check'].find((name) => typeof plan.project.scripts[name] === 'string');
  if (script) return outcome(scriptRun(plan, script, deadline), 'types');
  const tsc = binOf(plan, 'tsc');
  if (!tsc) return { result: 'not-run', note: 'types: no tsc in node_modules/.bin' };
  const first = plan.facts.code.files[0];
  const tsconfig = row.level === 'full' || !first ? join(plan.top, 'tsconfig.json') : nearestTsconfig(join(plan.top, first), plan.top) ?? join(plan.top, 'tsconfig.json');
  if (Array.isArray(readJsonFile(tsconfig)?.references)) return { result: 'not-run', note: 'types: project references (tsc -b would write build output); /check types runs the gate' };
  const info = join(privateDir('tsbuildinfo'), keyOf(tsconfig));
  return outcome(commandResult(tsc, ['--noEmit', '--incremental', '--tsBuildInfoFile', info, '--pretty', 'false', '-p', tsconfig], { cwd: plan.top, deadline }), 'types');
}

/** eslint `unix` lines kept to the added lines of the change (reviewdog's filter, round 1). */
function addedLineFindings(out, plan) {
  const added = new Map(plan.files.map((file) => [join(plan.top, file.path), new Set(file.added.map(({ line }) => line))]));
  return linesOf(out).filter((line) => {
    const match = /^(.+?):(\d+):\d+:/.exec(line);
    return match && added.get(match[1])?.has(Number(match[2]));
  });
}

function runLint(row, plan, deadline) {
  if (row.level === 'full' && plan.project.scripts.lint) return outcome(scriptRun(plan, 'lint', deadline), 'lint');
  const eslint = binOf(plan, 'eslint');
  if (!eslint) return { result: 'not-run', note: 'lint: no eslint in node_modules/.bin' };
  const files = plan.facts.code.files.map((path) => join(plan.top, path)).filter(existsSync);
  const cache = join(privateDir('eslintcache'), keyOf(plan.top));
  const result = commandResult(eslint, ['--cache', '--cache-location', cache, '--format', 'unix', '--no-error-on-unmatched-pattern', ...(row.level === 'full' ? ['.'] : files)], { cwd: plan.top, deadline });
  if (result.exit !== 1 || row.level === 'full') return outcome(result, 'lint');
  const findings = addedLineFindings(result.out, plan);
  return findings.length ? outcome(result, 'lint', findings) : { result: 'pass', note: 'lint: findings only on unchanged lines', seconds: result.seconds };
}

function runTests(row, plan, deadline) {
  const testPass = join(TOOLS, 'test-pass', 'test-pass.mjs');
  const files = plan.facts.paths.map((path) => join(plan.top, path)).filter(existsSync);
  const { testRunner } = plan.project;
  if (row.level === 'full') return outcome(commandResult(process.execPath, [testPass, 'run', '--repo', plan.top, '--suite', '--quiet'], { cwd: plan.top, deadline }), 'tests');
  if (testRunner === 'node') {
    const tests = plan.affected?.tests ?? [];
    if (tests.length === 0) return { result: 'pass', note: 'tests: no test reaches the change' };
    return outcome(commandResult(process.execPath, [testPass, 'run', '--repo', plan.top, '--quiet', '--', process.execPath, '--test', '--test-reporter=dot', ...tests], { cwd: plan.top, deadline }), 'tests');
  }
  const bin = testRunner === 'vitest' || testRunner === 'jest' ? binOf(plan, testRunner) : null;
  if (!bin) return { result: 'not-run', note: `tests: no scoped runner (${testRunner}); /check test runs them` };
  const args = testRunner === 'vitest' ? ['related', '--run', '--reporter=dot', ...files] : ['--findRelatedTests', ...files, '--passWithNoTests'];
  return outcome(commandResult(bin, args, { cwd: plan.top, deadline }), 'tests');
}

function runVisual(row, plan, deadline) {
  if (plan.facts.jobKind === 'ui-pixel' || /visual-qa/.test(row.how)) return { result: 'handoff', note: 'visual: run visual-qa once at the end of this lane (Figma job)' };
  const url = process.env.SMART_CHECK_UI_URL;
  if (!url) return { result: 'not-run', note: 'visual: no running page known (set SMART_CHECK_UI_URL)' };
  const widths = row.level === 'full' ? MATRIX_WIDTHS : CROP_WIDTHS;
  const out = mkdtempSync(join(tmpdir(), 'smart-check-ui-'));
  return outcome(commandResult(process.execPath, [join(TOOLS, 'ui-check', 'cli.mjs'), 'responsive', '--url', url, '--widths', widths.join(','), '--out', out], { cwd: plan.top, deadline }), 'visual');
}

/** Each changed hook gets an empty input with a scratch HOME: it must end without a crash (exit 0 or a deliberate 2). */
function runProbes(row, plan, deadline) {
  const home = mkdtempSync(join(tmpdir(), 'smart-check-probe-'));
  const findings = [];
  let seconds = 0;
  for (const path of plan.facts.triggers.hooks.filter((p) => /\.(mjs|js|cjs)$/.test(p) && !p.includes('/lib/') && existsSync(join(plan.top, p)))) {
    const result = commandResult(process.execPath, [join(plan.top, path)], { cwd: home, deadline: Math.min(deadline, Date.now() + PROBE_TIMEOUT_MS), input: '{}', env: { ...process.env, HOME: home, USERPROFILE: home } });
    seconds += result.seconds;
    if (result.timedOut) findings.push(`${path}: no answer within ${PROBE_TIMEOUT_MS / 1000} s on an empty input`);
    else if (result.exit !== 0 && result.exit !== 2) findings.push(`${path}: exit ${result.exit} on an empty input: ${linesOf(result.out)[0] ?? ''}`);
  }
  return findings.length ? { result: 'catch', findings, seconds } : { result: 'pass', seconds };
}

function runReview(row, plan) {
  if (row.level === 'full') {
    return { result: 'handoff', note: `review: deep set: commit, then run node ${join(homedir(), '.claude', 'tools', 'review-tier', 'review-tier.mjs')} --base ${plan.base} and start the set it prints` };
  }
  return null; // the cheap lens is async: run.mjs awaits cheapLens
}

const RUNNERS = { types: runTypes, lint: runLint, build: (row, plan, deadline) => (plan.project.build ? outcome(scriptRun(plan, 'build', deadline), 'build') : { result: 'not-run', note: 'build: no build script' }),
  tests: runTests, visual: runVisual, probes: runProbes, review: runReview, security: () => ({ result: 'pass', note: 'security: pinned scans' }) };

/**
 * Runs one plan row.
 * @param {{check: string, level: string, how: string, by: string}} row a plan row with level scoped or full
 * @param {object} plan from buildPlan
 * @param {number} deadline epoch ms when every check must have ended
 * @returns {Promise<{result: 'pass'|'catch'|'error'|'not-run'|'handoff', findings?: string[], note?: string, seconds?: number, tokens?: number}>}
 */
export async function runKind(row, plan, deadline) {
  if (Date.now() >= deadline) return { result: 'not-run', note: `${row.check}: out of time` };
  if (row.check === 'review' && row.level === 'scoped') return cheapLens(plan);
  try {
    return RUNNERS[row.check](row, plan, deadline);
  } catch (error) {
    return { result: 'error', note: `${row.check}: ${clean(error.message)}` };
  }
}
