#!/usr/bin/env node
// Purpose: CLI of the UI proof records (F7, P8): `record`, `check`, `plan`, `changed`, `review-page`.
//   ui-proof record --as <dev-run|pixel-qa> [--repo DIR] -- <ui-check run arguments>
//     runs `ui-check run` with those arguments in DIR (default: here), passes its output through, and writes the proof record of the
//     run from its own `result:` line (lib/record-run.mjs), whatever its verdict. Exit: the run's own code; 2 = usage, or the run
//     ended but its record could not be written (no record then).
//   ui-proof check --tip <sha> [--against <sha>] [--repo DIR]
//     0 = a pixel-qa PASS for the tip's UI tree and (with --against) no state worse than that record; a state with no
//     reference row prints `new` (INFO), never worse. 1 = no such PASS, a state worse, another comparator or renderer, or no record with
//     that sha. 2 = usage.
//   ui-proof changed --from <sha> --to <sha> [--repo DIR]   lists the UI files that differ: 0 none, 1 some, 2 usage
//   ui-proof review-page --results <dir> --out <dir> [--matrix <file>]   the owner review page (review-page.mjs)
//   ui-proof plan --base <sha> --tip <sha> | --files <path>... [--request <file>]... [--matrix <path>] [--json] [--write-run <dir>] [--repo DIR]
//     the check plan (lib/ui-plan.mjs): `plan: <depth>`, the tests line, one line per surface with its needs, the render map line,
//     exempt file and reason. --write-run writes matrix.json (the map's run matrix, byte for byte) and states.json of the surfaces to
//     render under the setup's state (ui-plan-runs), never in the repo. 0, 2 usage.
//   ui-proof check --tip <sha> --plan --base <sha> [--request <file>]... [--matrix <path>] [--repo DIR]
//     the plan of base..tip and its proof: 0 PASS (with `follow-up:` lines for old findings), 1 FAIL, 2 usage. A visual or pixel plan
//     with no `same` need prints exactly what `check --tip` prints. An unreadable record store is FAIL.
// Exports: none. Invariants: only `record` writes a record, and only from a run it started itself; any read or git failure is exit 2
// with the reason (`check --plan`: FAIL), never a PASS; a request file is the request itself: a STATUS.md is not read, and the `## Standing rules` and `## Owner
// decisions` sections of any other request file are cut (each with a plan reason line).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { compareReference, formatReference } from '../ui-check/lib/ledger.mjs';
import { RECORD_KINDS, recordRun } from './lib/record-run.mjs';
import { PROOF_AGENT, findAtCommit, findPass, readRecords, storeFile } from './lib/records.mjs';
import { changedUiFiles, git, uiTreeAt } from './lib/ui-files.mjs';
import { planChecks, planProofProblem, runFiles } from './lib/ui-plan.mjs';

const UI_CHECK_CLI = path.join(import.meta.dirname, '..', 'ui-check', 'cli.mjs');
const ARGS_END = '--'; // `record`: the ui-check run arguments follow it
const USAGE = 'usage: ui-proof <record --as <dev-run|pixel-qa> -- <ui-check run arguments> | check --tip <sha> [--against <sha> | --plan --base <sha> [--request <file>]... [--matrix <path>]] | plan (--base <sha> --tip <sha> | --files <path>...) [--request <file>]... [--matrix <path>] [--json] [--write-run <dir>] | changed --from <sha> --to <sha> | review-page --results <dir> --out <dir> [--matrix <file>]> [--repo DIR]';
const EXIT_USAGE = 2;
const REQUEST_MAX_BYTES = 4 << 20; // a request file read for evidence; requestEvidence reads its first 1 MB
const OWNER_SECTIONS = /^## (?:Standing rules|Owner decisions)\b/; // rules about the work, never request evidence (R4)

class UsageError extends Error {}

function flags(argv, names, extra = {}) {
  const options = { ...Object.fromEntries([...names, 'repo'].map((name) => [name, { type: 'string' }])), ...extra };
  try {
    return parseArgs({ args: argv, options, strict: true, allowPositionals: false }).values;
  } catch (error) {
    throw new UsageError(error.message);
  }
}

const commitOf = (repo, rev) => git(repo, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]).trim();

/** The reference record for --against, or the reason it is missing. */
function referenceOf(records, repo, values) {
  const sha = commitOf(repo, values.against);
  const ref = findAtCommit(records, sha);
  return ref ? { ref } : { why: `no ui-check run record taken at ${sha}` };
}

function check(argv) {
  const values = flags(argv, ['tip', 'against', 'base', 'matrix'], { plan: { type: 'boolean' }, request: { type: 'string', multiple: true } });
  if (values.plan) return checkPlan(values);
  if (values.base !== undefined || values.matrix !== undefined || values.request !== undefined) throw new UsageError('--base, --matrix and --request go with --plan');
  if (values.tip === undefined) throw new UsageError(USAGE);
  return checkPass(values);
}

/** Today's check: a pixel-qa PASS for the tip's UI tree and, with --against, no state worse. */
function checkPass(values) {
  const repo = path.resolve(values.repo ?? '.');
  const tip = commitOf(repo, values.tip);
  const records = readRecords(storeFile(repo));
  const pass = findPass(records, uiTreeAt(repo, tip), [PROOF_AGENT]);
  if (!pass) {
    console.log(`ui-proof: FAIL - no ${PROOF_AGENT} PASS for the UI files of ${tip} (a dev-ui or dev-pixel's own PASS, or a record without an agent type, does not count)`);
    return 1;
  }
  console.log(`ui-proof: ${PROOF_AGENT} PASS ${pass.id} (${pass.createdAt}, rule ${pass.rule}, widths ${pass.widths.join(',')})`);
  if (values.against === undefined) return 0;
  const { ref, why } = referenceOf(records, repo, values);
  if (!ref) {
    console.log(`ui-proof: FAIL - ${why}`);
    return 1;
  }
  const result = compareReference(pass.reference, ref.reference);
  console.log(formatReference(result).join('\n'));
  return result.ok ? 0 : 1;
}

/** A request file's text without its `## Standing rules` and `## Owner decisions` sections (each up to the next `## ` heading). */
const withoutOwnerSections = (text) => {
  let keep = true;
  return text.split('\n').filter((line) => {
    if (line.startsWith('## ')) keep = !OWNER_SECTIONS.test(line);
    return keep;
  }).join('\n');
};

/**
 * The request text: every --request file, the request itself (R4). Standing rules and owner decisions are rules about the work, not
 * the request, so they are never read: a STATUS.md is left out whole, and those sections of any other file are cut.
 * @returns {{text: string, skipped: string[]}} skipped: one plan reason line per file or section left out
 * @throws {UsageError} when a file cannot be read
 */
function requestText(files = []) {
  const skipped = [];
  const texts = files.map((file) => {
    let text;
    try {
      const stats = fs.statSync(file);
      if (!stats.isFile()) throw new Error('not a regular file');
      text = stats.size > REQUEST_MAX_BYTES ? fs.readFileSync(file, 'utf8').slice(0, REQUEST_MAX_BYTES + 1) : fs.readFileSync(file, 'utf8');
    } catch (error) {
      throw new UsageError(`--request ${file}: ${error.message}`);
    }
    if (path.basename(file).toLowerCase() === 'status.md') {
      skipped.push(`request ${path.basename(file)} not read: STATUS rules and decisions are not the request (pass the brief)`);
      return '';
    }
    const kept = withoutOwnerSections(text);
    if (kept !== text) skipped.push(`request ${path.basename(file)}: its standing rules and owner decisions sections not read`);
    return kept;
  });
  return { text: texts.join('\n'), skipped };
}

/** The plan for the flags: base..tip, or --files at HEAD. */
function planFor(values, repo) {
  const byFiles = values.files !== undefined;
  if (byFiles === (values.base !== undefined || values.tip !== undefined) || (!byFiles && (values.base === undefined || values.tip === undefined))) throw new UsageError(USAGE);
  const matrixPath = values.matrix === undefined ? null : path.resolve(values.matrix);
  const request = requestText(values.request);
  const common = { repoDir: repo, requestText: request.text, matrixPath };
  const result = byFiles ? planChecks({ ...common, files: values.files }) : planChecks({ ...common, base: commitOf(repo, values.base), tip: commitOf(repo, values.tip) });
  return { ...result, reasons: [...result.reasons, ...request.skipped] };
}

/** The plan as text lines. */
function planLines(plan) {
  const map = plan.map?.hash ? [`map: widths ${plan.map.widths.join(',')}; locales ${plan.map.locales.map((l) => l.tag).join(',')}; states ${plan.map.states.join(',')} (${plan.map.source}); run matrix sha256 ${plan.map.hash}`] : [];
  return [
    `plan: ${plan.depth}`,
    ...(plan.tests ? ['tests: the related tests must pass (logic changed)'] : []),
    ...plan.surfaces.map((s) => `surface ${s.id}: ${s.needs.join(' + ')} (${s.why})`),
    ...map,
    ...plan.exempt.map((e) => `exempt ${e.file} (${e.why})`),
    ...plan.reasons,
  ];
}

const isInside = (dir, file) => {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};

/** The real path of a folder that may not exist yet: its nearest existing parent resolved, the rest appended. */
function realTarget(dir) {
  const missing = [];
  let at = dir;
  while (!fs.existsSync(at)) { missing.unshift(path.basename(at)); at = path.dirname(at); }
  return path.join(fs.realpathSync.native(at), ...missing);
}

/** Write the run files under the setup's state (UI_PLAN_STATE_DIR overrides it), never inside the repository. */
function writeRun(plan, values, repo) {
  const root = process.env.UI_PLAN_STATE_DIR ?? path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), '.claude', 'state', 'ui-plan-runs');
  const dir = path.resolve(root, values['write-run']);
  if (!isInside(path.resolve(root), dir) || dir === path.resolve(root)) throw new UsageError(`--write-run must name a folder under ${root}`);
  const top = fs.realpathSync.native(git(repo, ['rev-parse', '--show-toplevel']).trim());
  if (isInside(top, realTarget(dir))) throw new UsageError(`--write-run ${dir} lies inside the repository ${top}: the project is never written`);
  const run = plan.map ? runFiles(plan.surfaces, plan.map) : { count: 0 };
  if (run.count === 0) return ['run: nothing for dev-run to render (no same or render surface with a url)'];
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'matrix.json'), run.matrixText);
  fs.writeFileSync(path.join(dir, 'states.json'), run.statesText);
  return [`run: ${path.join(dir, 'matrix.json')} and ${path.join(dir, 'states.json')}, ${run.count} surface(s) (${plan.map.source}); render both ends with this matrix.json`];
}

function plan(argv) {
  const values = flags(argv, ['base', 'tip', 'matrix', 'write-run'], { files: { type: 'string', multiple: true }, request: { type: 'string', multiple: true }, json: { type: 'boolean' } });
  const repo = path.resolve(values.repo ?? '.');
  const result = planFor(values, repo);
  const run = values['write-run'] === undefined ? [] : writeRun(result, values, repo);
  console.log(values.json ? JSON.stringify(result, null, 1) : [...planLines(result), ...run].join('\n'));
  return 0;
}

/** check --plan: the plan of base..tip and its proof on the records; a visual or pixel plan prints today's check, byte for byte. */
function checkPlan(values) {
  if (values.tip === undefined || values.base === undefined || values.against !== undefined) throw new UsageError(USAGE);
  const repo = path.resolve(values.repo ?? '.');
  const tip = commitOf(repo, values.tip);
  const base = commitOf(repo, values.base);
  const result = planFor({ ...values, tip, base }, repo);
  if (['visual', 'pixel'].includes(result.depth) && !result.surfaces.some((s) => s.needs.includes('same'))) return checkPass({ tip, repo });
  let records;
  try {
    records = readRecords(storeFile(repo));
  } catch (error) {
    console.log(`plan: ${result.depth}\nui-proof: FAIL - the proof records cannot be read (${error.message.split('\n')[0]})`);
    return 1;
  }
  const { problem, followUps } = planProofProblem(result, { records, repoDir: repo, base, tip });
  console.log([`plan: ${result.depth}`, ...followUps, problem ? `ui-proof: FAIL - ${problem}` : `ui-proof: PASS - plan ${result.depth} proved`].join('\n'));
  return problem ? 1 : 0;
}

function changed(argv) {
  const values = flags(argv, ['from', 'to']);
  if (values.from === undefined || values.to === undefined) throw new UsageError(USAGE);
  const repo = path.resolve(values.repo ?? '.');
  const files = changedUiFiles(repo, commitOf(repo, values.from), commitOf(repo, values.to));
  console.log(files.length === 0 ? 'ui-proof: no UI file changed' : files.join('\n'));
  return files.length === 0 ? 0 : 1;
}

async function reviewPage(argv) {
  const page = await import('./review-page.mjs');
  return page.run(argv);
}

/** Run `ui-check run` in `cwd`; its stdout is passed through and kept, its stderr goes straight to ours. */
function runUiCheck(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [UI_CHECK_CLI, 'run', ...args], { cwd, stdio: ['inherit', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), output }));
  });
}

/** record: run `ui-check run` and write its proof record as the kind `--as` names. */
async function record(argv) {
  const end = argv.indexOf(ARGS_END);
  if (end === -1) throw new UsageError(USAGE);
  const values = flags(argv.slice(0, end), ['as']);
  if (!RECORD_KINDS.includes(values.as)) throw new UsageError(`--as must be one of ${RECORD_KINDS.join(', ')}`);
  const cwd = path.resolve(values.repo ?? '.');
  const runArgs = argv.slice(end + 1);
  const { code, output } = await runUiCheck(runArgs, cwd);
  const written = recordRun({ output, args: runArgs, cwd, kind: values.as });
  console.log(written
    ? `ui-proof: recorded ${written.verdict} ${written.id} as ${values.as} (UI tree ${written.uiTree.slice(0, 12)}, head ${written.head ?? 'none'})`
    : 'ui-proof: no record (the run printed no result line)');
  return code;
}

const COMMANDS = { record, check, plan, changed, 'review-page': reviewPage };

const [name, ...rest] = process.argv.slice(2);
try {
  if (!Object.hasOwn(COMMANDS, name ?? '')) throw new UsageError(USAGE);
  process.exitCode = await COMMANDS[name](rest);
} catch (error) {
  console.error(`ui-proof: ${error instanceof UsageError ? '' : 'error: '}${error.message}`);
  process.exitCode = EXIT_USAGE;
}
