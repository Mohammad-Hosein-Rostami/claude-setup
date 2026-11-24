// Purpose: writes the proof record (records.mjs) of one finished `ui-check run`. `ui-proof record` runs `ui-check run` itself and
// hands its output here. The ui-proof-gate hook did this on PostToolUse until it was removed (2026-11-24); the writer now lives in
// this tool, so dev-run and pixel-qa record their runs with one command.
// Exports: RECORD_KINDS, RESULT_LINE, matrixArg(args) -> string|null, recordRun({output, args, cwd, kind}) -> record|null.
// Trust: the verdict and the results folder come from the run's own `result:` line, which `ui-proof record` reads from the child it
// started (never from a flag); the kind is the caller's word (`--as`, one of RECORD_KINDS), since no hook input names the agent any
// more. A run file (ledger, results, matrix) is read through hooks/lib/plain-file.mjs after one realpath: a FIFO, device or folder is
// refused at once (ENOTPLAIN) and no record is written.
// Invariants: no result line -> null and nothing written; any read or parse failure throws before the store is touched; the UI tree
// is the one of the ledger's `root` (the git top-level the run started in) when that is a folder of the same repository as `cwd`,
// else of `cwd`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readPlainFile } from '../../../hooks/lib/plain-file.mjs';
import { RENDER_PROOF_AGENTS, appendRecord, buildRecord, storeFile } from './records.mjs';
import { git, workingUiTree } from './ui-files.mjs';

/** The kinds a record may carry: the agents whose runs prove a plan (dev-run renders, pixel-qa is the final pixel gate). */
export const RECORD_KINDS = RENDER_PROOF_AGENTS;
/** The last line of `ui-check run` (commands/run.mjs): the verdict and the results.json path. */
export const RESULT_LINE = /^result: (PASS|FAIL) run - .* - results (.+)$/m;
const RUN_FILE_MAX_BYTES = 64 * 1024 * 1024; // a ui-check ledger, results or matrix JSON; far above any real one
const MATRIX_FLAG = '--matrix';

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** The text of a run file: a link is followed once by realpath, the read never waits (plain-file.mjs). */
const readRunFile = (file) => readPlainFile(fs.realpathSync(file), RUN_FILE_MAX_BYTES);

/**
 * @param {string[]} args the `ui-check run` arguments
 * @returns {string|null} the value of `--matrix <path>` or `--matrix=<path>`, or null when there is none
 */
export function matrixArg(args) {
  for (const [index, arg] of args.entries()) {
    if (arg === MATRIX_FLAG) return args[index + 1] ?? null;
    if (arg.startsWith(`${MATRIX_FLAG}=`)) return arg.slice(MATRIX_FLAG.length + 1);
  }
  return null;
}

/** The real path of a repository's common git folder, or null when `dir` is not inside one (git throws there). */
function commonGitDir(dir) {
  try {
    return fs.realpathSync.native(git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
  } catch {
    return null; // not a repository, or gone: the caller falls back to cwd
  }
}

/** The folder whose UI files the run rendered: the ledger's absolute `root` when it shares cwd's repository, else cwd. */
function treeFolder(root, cwd) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !fs.existsSync(root)) return cwd;
  const own = commonGitDir(cwd);
  return own !== null && commonGitDir(root) === own ? root : cwd;
}

/**
 * Write the proof record of a finished `ui-check run`.
 * @param {{output: string, args: string[], cwd: string, kind: string}} run output: what the run printed on stdout; args: its
 *   arguments (for the matrix); cwd: the folder it ran in (relative paths and the record store); kind: one of RECORD_KINDS
 * @returns {object|null} the record written, or null when the output has no `result:` line (the run ended before its verdict)
 * @throws {Error} for an unknown kind, or a run file that cannot be read or parsed (nothing is written then)
 */
export function recordRun({ output, args, cwd, kind }) {
  if (!RECORD_KINDS.includes(kind)) throw new Error(`unknown record kind ${JSON.stringify(kind)} (one of ${RECORD_KINDS.join(', ')})`);
  const line = RESULT_LINE.exec(output);
  if (!line) return null;
  const resultsPath = path.resolve(cwd, line[2].trim());
  const ledgerText = readRunFile(path.join(path.dirname(resultsPath), 'ledger.json'));
  const ledger = JSON.parse(ledgerText);
  const results = JSON.parse(readRunFile(resultsPath));
  const matrix = matrixArg(args);
  const matrixFile = matrix === null ? null : path.resolve(cwd, matrix);
  const matrixHash = matrixFile !== null && fs.existsSync(matrixFile) ? sha256(readRunFile(matrixFile)) : null; // read before git runs
  const uiTree = workingUiTree(treeFolder(ledger.root, cwd));
  const record = buildRecord({ ledger, results, verdict: line[1], agentType: kind, matrixHash, resultsPath, uiTree, ledgerSha256: sha256(ledgerText) });
  appendRecord(storeFile(cwd), record);
  return record;
}
