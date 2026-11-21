#!/usr/bin/env node
// Purpose: CLI of the UI proof records (F7, P8): `check`, `has`, `changed`, `review-page`. The records are written by the
// PostToolUse(Bash) hook hooks/ui-proof-gate.mjs after every `ui-check run`.
//   ui-proof check --tip <sha> [--against <sha> | --against-step <road>.s<N>] [--repo DIR]
//     0 = a visual-qa PASS for the tip's UI tree and (with --against / --against-step) no state worse than that record; a state with no
//     reference row prints `new` (INFO), never worse. 1 = no such PASS, a state worse, another comparator or renderer, or no record with
//     that sha or label. 2 = usage.
//   ui-proof has --step <road>.s<N> [--repo DIR]      0 a record with that label exists, 1 none, 2 usage (road.mjs next uses it)
//   ui-proof changed --from <sha> --to <sha> [--repo DIR]   lists the UI files that differ: 0 none, 1 some, 2 usage
//   ui-proof review-page --results <dir> --out <dir> [--matrix <file>]   the owner review page (review-page.mjs)
// Exports: none. Invariants: reads records only (never writes them); any read or git failure is exit 2 with the reason, never a PASS.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { compareReference, formatReference } from '../ui-check/lib/ledger.mjs';
import { PROOF_AGENT, findAtCommit, findLabelled, findPass, readRecords, storeFile } from './lib/records.mjs';
import { changedUiFiles, git, uiTreeAt } from './lib/ui-files.mjs';

const USAGE = 'usage: ui-proof <check --tip <sha> [--against <sha> | --against-step <road>.s<N>] | has --step <label> | changed --from <sha> --to <sha> | review-page --results <dir> --out <dir> [--matrix <file>]> [--repo DIR]';
const STEP_LABEL = /^[A-Za-z0-9_-]+\.s\d+$/;
const EXIT_USAGE = 2;

class UsageError extends Error {}

function flags(argv, names) {
  const options = Object.fromEntries([...names, 'repo'].map((name) => [name, { type: 'string' }]));
  try {
    return parseArgs({ args: argv, options, strict: true, allowPositionals: false }).values;
  } catch (error) {
    throw new UsageError(error.message);
  }
}

const commitOf = (repo, rev) => git(repo, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]).trim();

/** The reference record for --against / --against-step, or the reason it is missing. */
function referenceOf(records, repo, values) {
  if (values['against-step'] !== undefined) {
    if (!STEP_LABEL.test(values['against-step'])) throw new UsageError('--against-step must look like <road>.s<N>');
    const ref = findLabelled(records, values['against-step']);
    return ref ? { ref } : { why: `no record labelled ${values['against-step']} (take the step-start run: ui-check run --step ${values['against-step']} on the base tip)` };
  }
  const sha = commitOf(repo, values.against);
  const ref = findAtCommit(records, sha);
  return ref ? { ref } : { why: `no ui-check run record taken at ${sha}` };
}

function check(argv) {
  const values = flags(argv, ['tip', 'against', 'against-step']);
  if (values.tip === undefined || (values.against !== undefined && values['against-step'] !== undefined)) throw new UsageError(USAGE);
  const repo = path.resolve(values.repo ?? '.');
  const tip = commitOf(repo, values.tip);
  const records = readRecords(storeFile(repo));
  const pass = findPass(records, uiTreeAt(repo, tip), [PROOF_AGENT]);
  if (!pass) {
    console.log(`ui-proof: FAIL - no ${PROOF_AGENT} PASS for the UI files of ${tip} (a ui-implementer's own PASS, or a record without an agent type, does not count)`);
    return 1;
  }
  console.log(`ui-proof: ${PROOF_AGENT} PASS ${pass.id} (${pass.createdAt}, rule ${pass.rule}, widths ${pass.widths.join(',')})`);
  if (values.against === undefined && values['against-step'] === undefined) return 0;
  const { ref, why } = referenceOf(records, repo, values);
  if (!ref) {
    console.log(`ui-proof: FAIL - ${why}`);
    return 1;
  }
  const result = compareReference(pass.reference, ref.reference);
  console.log(formatReference(result).join('\n'));
  return result.ok ? 0 : 1;
}

function has(argv) {
  const values = flags(argv, ['step']);
  if (values.step === undefined || !STEP_LABEL.test(values.step)) throw new UsageError(USAGE);
  const found = findLabelled(readRecords(storeFile(path.resolve(values.repo ?? '.'))), values.step);
  console.log(found ? `ui-proof: record ${values.step} at ${found.head ?? 'unknown sha'}` : `ui-proof: no record labelled ${values.step}`);
  return found ? 0 : 1;
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

const COMMANDS = { check, has, changed, 'review-page': reviewPage };

const [name, ...rest] = process.argv.slice(2);
try {
  if (!Object.hasOwn(COMMANDS, name ?? '')) throw new UsageError(USAGE);
  process.exitCode = await COMMANDS[name](rest);
} catch (error) {
  console.error(`ui-proof: ${error instanceof UsageError ? '' : 'error: '}${error.message}`);
  process.exitCode = EXIT_USAGE;
}
