// Purpose: `run` - the one call of a UI round: `ui-coverage scaffold` (states file from the matrix) + `batch` + `ui-coverage check`,
// then the numbers: per-state counts, failing rows with crop paths (native scale, at most 2,576 px on the long edge, lib/crops.mjs),
// the round table against `--prev`, the "0 worse" table against `--no-worse <reference run>`, and the `--self-test` determinism check.
// Exports: options, run. Exit 0 every record passes, the matrix check passes, nothing is worse and the self-test is clean / 1 otherwise /
// 2 usage or setup error (an open states entry without a url, a bad flag, an unreadable ledger).
// Invariants: images are printed only for failures, as crops; PASS and FAIL are the numbers, never a look at an image. `--step
// <road>.s<N>` and the commit sha of HEAD are stored in ledger.json, so a baseline run on the base tip is that step's start record.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, need } from '../lib/args.mjs';
import { writeCrops } from '../lib/crops.mjs';
import { UsageError } from '../lib/errors.mjs';
import { compareReference, formatReference, formatRounds, readLedger } from '../lib/ledger.mjs';
import { executeBatch } from './batch.mjs';

const COVERAGE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui-coverage', 'ui-coverage.mjs');
const CHILD_TIMEOUT_MS = 60_000; // scaffold and check read a few JSON files; a minute is far beyond normal
const STEP_LABEL = /^[A-Za-z0-9_-]+\.s\d+$/;
const FINDINGS_SHOWN = 5; // per failing record; the rest are in its report

export const options = {
  matrix: { type: 'string' },
  'base-url': { type: 'string' },
  states: { type: 'string' }, // default: states.json beside the matrix
  out: { type: 'string' },
  jobs: { type: 'string' },
  prev: { type: 'string' },
  'no-worse': { type: 'string' },
  'self-test': { type: 'boolean', default: false },
  step: { type: 'string' },
  only: { type: 'string' },
  project: { type: 'string' },
};

/** Run the ui-coverage CLI; a crash or timeout is a setup error, a non-zero exit is returned to the caller. */
function coverage(args) {
  const child = spawnSync(process.execPath, [COVERAGE_CLI, ...args], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS });
  if (child.error) throw new UsageError(`ui-coverage ${args[0]} did not finish: ${child.error.message}`);
  return { code: child.status, out: `${child.stdout}${child.stderr}`.trim() };
}

/** Write or extend the states file from the matrix, set defaults.baseUrl, and refuse open entries without a url. */
function prepareStates(matrix, statesFile, baseUrl) {
  const scaffold = coverage(['scaffold', matrix, '--out', statesFile]);
  if (scaffold.code !== 0) throw new UsageError(`ui-coverage scaffold failed:\n${scaffold.out}`);
  const file = JSON.parse(fs.readFileSync(statesFile, 'utf8'));
  if (baseUrl !== undefined) {
    file.defaults = { ...file.defaults, baseUrl };
    fs.writeFileSync(statesFile, `${JSON.stringify(file, null, 2)}\n`);
  }
  const empty = file.states.filter((entry) => entry.url === '').map((entry) => `${entry.surface} / ${entry.state} / ${entry.locale ?? 'default'}`);
  if (empty.length > 0) throw new UsageError(`${statesFile}: fill url (and steps) for ${empty.length} entr${empty.length === 1 ? 'y' : 'ies'}: ${empty.join('; ')}`);
}

/** The commit sha of HEAD in the current folder, or null outside a git repo (the ledger then says so). */
function headSha() {
  const git = spawnSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS });
  return git.status === 0 ? git.stdout.trim() : null;
}

/** Lines for the failing records: the first findings and the crop paths of the pixel region. */
function failingLines(records) {
  return records.filter((r) => r.status === 'fail').flatMap((r) => {
    const pixel = r.findings.find((f) => f.check === 'pixel' && f.region);
    const crops = pixel && r.images?.actual && fs.existsSync(r.images.actual) ? writeCrops(r.images.actual, pixel.region, path.dirname(r.images.actual)) : [];
    const shown = r.findings.slice(0, FINDINGS_SHOWN).map((f) => `    ${f.check} ${f.element}: ${f.detail}`);
    const more = r.findings.length > FINDINGS_SHOWN ? [`    ... ${r.findings.length - FINDINGS_SHOWN} more in ${r.evidence}`] : [];
    return [`  FAIL ${r.surface} / ${r.state} / ${r.locale ?? 'default'} @${r.width} (${r.part}): ${r.findings.length} finding(s), report ${r.evidence}`, ...shown, ...more, ...crops.map((c) => `    crop: ${c}`)];
  });
}

/** The determinism self-test: a second capture of every compare state must give the same sha256. */
async function selfTest(values, first) {
  const second = await executeBatch({ ...values, prev: undefined, out: path.join(first.outDir, 'self-test') });
  const shaOf = new Map(second.ledger?.states.map((row) => [row.key, row.sha256]) ?? []);
  const differ = (first.ledger?.states ?? []).filter((row) => shaOf.get(row.key) !== row.sha256).map((row) => row.key);
  const lines = differ.length === 0 ? [`self-test: PASS - ${first.ledger?.states.length ?? 0} captures identical twice`] : [`self-test: FAIL - ${differ.length} nondeterministic: ${differ.join('; ')}`];
  return { ok: differ.length === 0, lines };
}

function countsLine(records) {
  const fail = records.filter((r) => r.status === 'fail').length;
  return `records: ${records.length}, pass ${records.length - fail}, fail ${fail}`;
}

/** Validate the flags that need more than parseArgs. */
function readFlags(argv) {
  const values = parse(argv, options);
  need(values, 'matrix');
  if (values.step !== undefined && !STEP_LABEL.test(values.step)) throw new UsageError(`--step must look like <road>.s<N> (e.g. r9p3.s2), got ${JSON.stringify(values.step)}`);
  return values;
}

/** Run run. @param {string[]} argv @returns {Promise<number>} exit code */
export async function run(argv) {
  const values = readFlags(argv);
  const matrix = path.resolve(values.matrix);
  const statesFile = path.resolve(values.states ?? path.join(path.dirname(matrix), 'states.json'));
  const reference = values['no-worse'] === undefined ? null : readLedger(path.resolve(values['no-worse']), 'no-worse');
  prepareStates(matrix, statesFile, values['base-url']);
  const outDir = path.resolve(values.out ?? path.join(os.tmpdir(), 'ui-check', 'run', new Date().toISOString().replace(/[:.]/g, '-')));
  const batchValues = { states: statesFile, only: values.only, out: outDir, jobs: values.jobs, project: values.project, prev: values.prev };
  const batch = await executeBatch(batchValues, { step: values.step ?? null, head: headSha() });
  const lines = [countsLine(batch.records), ...failingLines(batch.records)];
  if (batch.rounds) lines.push('rounds (against --prev):', ...formatRounds(batch.rounds));
  const noWorse = reference && batch.ledger ? compareReference(batch.ledger, reference) : null;
  if (noWorse) lines.push(...formatReference(noWorse));
  const determinism = values['self-test'] ? await selfTest(batchValues, batch) : null;
  if (determinism) lines.push(...determinism.lines);
  const check = coverage(['check', matrix, '--results', path.join(outDir, 'results.json')]);
  lines.push('ui-coverage check:', check.out);
  const ok = batch.code === 0 && check.code === 0 && (noWorse?.ok ?? true) && (determinism?.ok ?? true);
  lines.push(`result: ${ok ? 'PASS' : 'FAIL'} run - ${countsLine(batch.records)} - results ${path.join(outDir, 'results.json')}`);
  console.log(lines.join('\n'));
  return ok ? 0 : 1;
}
