// Purpose: the UI proof records (F7, P8): one JSON file per repository under ~/.claude/state/ui-proof (override:
// UI_PROOF_STATE_DIR), one record per `ui-check run`, whatever its verdict. Exports: MAX_RECORDS, PROOF_AGENT, RENDER_PROOF_AGENTS,
// storeFile, readRecords, appendRecord, buildRecord, findPass, findLabelled, findAtCommit, newestForTree.
// A record: {id, createdAt, head, uiTree, verdict, rule, conditions, matrixHash, agentType, step, widths, frames, results,
// reference: {comparator, renderer, states: [{key, sha256, pixels, drift, rows, scale, status}]}, ledgerSha256, same, captures}.
// ledgerSha256 is the sha256 of the run's ledger.json as read (a later run's `--same` names its base by it); same is the ledger's
// `same` section (null without `--same`); captures are the ledger's responsive captures without their file paths ([] in an older
// ledger). The agent type comes from the hook input only (never from the command line); a record without one is nobody's (it never
// counts as visual-qa's or a runner's: fail closed). Diagnostic records never enter `reference` (ui-check's ledger leaves them out).
// Invariants: the file is replaced atomically (temp name unique to this process) with mode 0600; a missing file reads as no records, an
// unreadable or malformed one throws (callers fail closed); the newest MAX_RECORDS records are kept.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './ui-files.mjs';

export const MAX_RECORDS = 200;
export const PROOF_AGENT = 'visual-qa'; // only its PASS on the tree that lands is the final gate
// The non-writers whose runs prove a `same` or `render` plan (ui-plan.mjs), at the base and at the tip alike (P14).
export const RENDER_PROOF_AGENTS = Object.freeze(['runner', PROOF_AGENT]);
const FILE_MODE = 0o600;
const NAME_HASH_CHARS = 16;

const stateDir = (env) => env.UI_PROOF_STATE_DIR ?? path.join(env.HOME || env.USERPROFILE || os.homedir(), '.claude', 'state', 'ui-proof');

/** The record file of the repository `cwd` belongs to (worktrees of one clone share it: keyed by the real common git folder). */
export function storeFile(cwd, env = process.env) {
  const common = fs.realpathSync.native(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
  const repo = path.basename(path.dirname(common)).replace(/[^A-Za-z0-9_.-]/g, '-');
  const hash = crypto.createHash('sha256').update(common).digest('hex').slice(0, NAME_HASH_CHARS);
  return path.join(stateDir(env), `${repo}-${hash}.json`);
}

/** @returns {object[]} the records, oldest first; [] when the file does not exist @throws {Error} when it cannot be read or parsed */
export function readRecords(file) {
  if (!fs.existsSync(file)) return [];
  const stats = fs.lstatSync(file);
  if (!stats.isFile()) throw new Error(`ui-proof record ${file} is not a regular file`);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`ui-proof record ${file} is not a list of records`);
  return parsed;
}

/** Append a record (keeping the newest MAX_RECORDS) by an atomic replace. */
export function appendRecord(file, record) {
  const records = [...readRecords(file), record].slice(-MAX_RECORDS);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(records, null, 1)}\n`, { mode: FILE_MODE });
  fs.renameSync(temp, file);
}

/** The ledger's `same` section as a record keeps it, or null when the run had no `--same` base. */
function sameOf(same) {
  if (!same || typeof same !== 'object' || !Array.isArray(same.rows)) return null;
  return { ref: same.ref ?? null, mismatch: same.mismatch ?? null, refused: same.refused ?? null, rows: same.rows };
}

/** The ledger's capture rows without the file path (a path names a folder that may move; the sha256 names the bytes). */
const capturesOf = (captures) => (Array.isArray(captures) ? captures : []).map(({ key, sha256, findings, pageErrors }) => ({ key, sha256, findings, pageErrors }));

/**
 * Build the record of one `ui-check run`.
 * @param {{ledger: object, results: object[], verdict: 'PASS'|'FAIL', agentType: string|null, matrixHash: string|null, resultsPath: string,
 *   uiTree: string, ledgerSha256?: string|null}} run ledgerSha256: the sha256 of the ledger.json bytes the ledger was parsed from
 * @returns {object} the record (see the header)
 */
export function buildRecord({ ledger, results, verdict, agentType, matrixHash, resultsPath, uiTree, ledgerSha256 = null }) {
  const gate = results.filter((r) => !r.diagnostic);
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    head: ledger.head ?? null,
    uiTree,
    verdict,
    rule: ledger.rule ?? 'default',
    conditions: ledger.conditions ?? null,
    matrixHash,
    agentType: agentType ?? null,
    step: ledger.step ?? null,
    widths: [...new Set(gate.map((r) => r.width).filter(Number.isInteger))].sort((a, b) => a - b),
    frames: ledger.states.map((row) => row.key),
    results: resultsPath,
    reference: { comparator: ledger.comparator, renderer: ledger.renderer, states: ledger.states },
    ledgerSha256,
    same: sameOf(ledger.same),
    captures: capturesOf(ledger.captures),
  };
}

const newest = (records, test) => [...records].reverse().find(test) ?? null;

/** The newest PASS for a UI tree made by one of `agentTypes`. */
export const findPass = (records, uiTree, agentTypes) => newest(records, (r) => r.verdict === 'PASS' && r.uiTree === uiTree && r.agentType !== null && agentTypes.includes(r.agentType));

/** The newest record with a `--step` label. */
export const findLabelled = (records, label) => newest(records, (r) => r.step === label);

/** The newest record taken at a commit. */
export const findAtCommit = (records, sha) => newest(records, (r) => r.head === sha);

/** The newest record of a UI tree, whatever its verdict or agent. */
export const newestForTree = (records, uiTree) => newest(records, (r) => r.uiTree === uiTree);
