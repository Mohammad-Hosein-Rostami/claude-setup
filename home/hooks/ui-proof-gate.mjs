// PostToolUse(Bash), Stop and SubagentStop: the UI proof gate (spec-p2-pixel.md F7, P8).
//   PostToolUse Bash -> after every `ui-check run` (whatever its verdict) writes a proof record (home/tools/ui-proof/lib/records.mjs):
//                   the UI tree hash, the verdict, rule, conditions, matrix hash, `--step` label, HEAD, and the batch reference from the
//                   run's ledger.json. The agent type comes from the hook input (`agent_type`, set inside a subagent), never from the
//                   command line; the lead's own runs carry none and never count as visual-qa's.
//   Stop (the lead) -> when the working tree's UI files differ from the merge base with the default branch (or are uncommitted) and no
//                   visual-qa PASS matches the tree, or a newer run on the same tree is worse than that PASS's reference, blocks once
//                   per state. SubagentStop -> the same for ui-implementer and visual-qa only; an agent's own PASS counts for its own stop.
// Not the hard check: Claude Code overrides a Stop gate after 8 blocks in a row and lets a crashed or timed-out Stop gate through, so
// `git-tidy land` and the road gate (`ui-proof check`) hold the bar; this gate counts its blocks through hooks/lib/stop-block-count.mjs.
// Always on: it runs on every UI change.
// Outside a git work tree (a lead started in ~) there are no UI files to prove: the stop passes (this threw `not a git repository` on
// every such stop, which stop-block-count recorded as "gate crashed or timed out", 32 records by 2026-11-21).
// Exports: recordRun, stopDecision. Invariants: never crashes a session: every error on PostToolUse is silent (no record), on Stop an
// unreadable record blocks once (fail closed) and any other error lets the stop through; one total deadline below the hook timeout;
// the reason text is fixed text plus hashes, counts and state keys, never tool output.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readSessionFile, writeSessionFile } from './lib/session-store.mjs';

const DEADLINE_MS = 12_000; // the settings timeout is 15 s
const UI_AGENTS = new Set(['ui-implementer', 'visual-qa']);
const DEFAULT_BRANCHES = ['main', 'master', 'develop'];
const RESULT_LINE = /^result: (PASS|FAIL) run - .* - results (.+)$/m;
const RUN_COMMAND = /ui-check[\\/]cli\.mjs["']?\s+run\b|ui-check\s+run\b/;
const MATRIX_FLAG = /--matrix[= ](?:"([^"]+)"|'([^']+)'|(\S+))/;
const BLOCKED_KEPT = 50;
const STORE_MAX_BYTES = 64 * 1024;
const blockedDir = (env) => path.join(env.HOME || env.USERPROFILE || os.homedir(), '.claude', 'state', 'ui-proof-gate');

const proofLib = () => Promise.all([import('../tools/ui-proof/lib/records.mjs'), import('../tools/ui-proof/lib/ui-files.mjs')]);

/** The text Claude Code gave as the Bash result (a string or {stdout, stderr}). */
const outputOf = (response) => (typeof response === 'string' ? response : `${response?.stdout ?? ''}\n${response?.stderr ?? ''}`);

function matrixHash(command, cwd) {
  const match = MATRIX_FLAG.exec(command);
  const file = match ? path.resolve(cwd, match[1] ?? match[2] ?? match[3]) : null;
  return file && fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
}

/**
 * PostToolUse(Bash): write the proof record of a finished `ui-check run`.
 * @param {{cwd?: string, agent_type?: string, tool_input?: {command?: string}, tool_response?: unknown}} input hook JSON
 * @returns {Promise<boolean>} true when a record was written
 */
export async function recordRun(input) {
  const command = input.tool_input?.command ?? '';
  if (!RUN_COMMAND.test(command)) return false;
  const line = RESULT_LINE.exec(outputOf(input.tool_response));
  if (!line) return false;
  const cwd = input.cwd ?? process.cwd();
  const resultsPath = path.resolve(cwd, line[2].trim());
  const ledger = JSON.parse(fs.readFileSync(path.join(path.dirname(resultsPath), 'ledger.json'), 'utf8'));
  const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  const [{ appendRecord, buildRecord, storeFile }, { workingUiTree }] = await proofLib();
  const record = buildRecord({ ledger, results, verdict: line[1], agentType: input.agent_type ?? null, matrixHash: matrixHash(command, cwd), resultsPath, uiTree: workingUiTree(cwd) });
  appendRecord(storeFile(cwd), record);
  return true;
}

/** The UI tree at the merge base of HEAD with the first default branch that exists (HEAD itself when none). */
function baseTree(cwd, { git, uiTreeAt }) {
  for (const branch of DEFAULT_BRANCHES) {
    try {
      git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    } catch {
      continue; // that branch does not exist here: try the next name
    }
    return uiTreeAt(cwd, git(cwd, ['merge-base', 'HEAD', `refs/heads/${branch}`]).trim());
  }
  return uiTreeAt(cwd, 'HEAD');
}

/** True when cwd is inside a git work tree (git exits non-zero, which `git` throws on, outside one or in a bare repository). */
function insideWorkTree(cwd, git) {
  try {
    return git(cwd, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    return false;
  }
}

/** The block reason for a tree, or null when its proof stands. */
async function proofProblem(cwd, input, event) {
  const [{ PROOF_AGENT, findPass, newestForTree, readRecords, storeFile }, files] = await proofLib();
  if (!insideWorkTree(cwd, files.git)) return null; // no repository, no UI files to prove
  const tree = files.workingUiTree(cwd);
  if (tree === baseTree(cwd, files)) return null;
  let records;
  try {
    records = readRecords(storeFile(cwd));
  } catch (error) {
    return { key: `${tree}:unreadable`, reason: `ui-proof: the proof record cannot be read (${error.message.split('\n')[0]}): UI files changed and nothing proves them` };
  }
  const accepted = event === 'Stop' ? [PROOF_AGENT] : [input.agent_type, PROOF_AGENT];
  const pass = findPass(records, tree, accepted);
  if (!pass) return { key: `${tree}:none`, reason: `ui-proof: UI files changed and no ${accepted.join(' or ')} PASS matches this tree (UI tree ${tree.slice(0, 12)}): visual-qa runs \`ui-check run\` on the tree that lands; a ui-implementer's own PASS does not count for the lead` };
  const latest = newestForTree(records, tree);
  if (!latest || latest.id === pass.id) return null;
  const { compareReference, formatReference } = await import('../tools/ui-check/lib/ledger.mjs');
  const result = compareReference(latest.reference, pass.reference);
  return result.ok ? null : { key: `${tree}:${latest.id}`, reason: `ui-proof: a newer run on this tree is worse than the PASS reference:\n${formatReference(result).slice(0, 12).join('\n')}` };
}

/** Once per state: true the first time a state key is seen in this session (the store keeps the last BLOCKED_KEPT keys). */
function firstTime(env, session, key) {
  const text = readSessionFile(blockedDir(env), session, STORE_MAX_BYTES);
  if (text === undefined) return false; // an unusable store: never block in a loop
  const keys = text ? JSON.parse(text) : [];
  if (keys.includes(key)) return false;
  return writeSessionFile(blockedDir(env), session, JSON.stringify([...keys, key].slice(-BLOCKED_KEPT)));
}

/**
 * Run the stop decision through the shared Stop-block counter (phase 1 r9-stop-cap: countedGate counts a `{block: true}` result and
 * records a crash); until that module is installed the decision runs uncounted.
 */
async function countedDecision(input) {
  let counter;
  try {
    counter = await import('./lib/stop-block-count.mjs');
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return stopDecision(input);
  }
  return counter.countedGate('ui-proof-gate', input, () => stopDecision(input));
}

/**
 * Stop / SubagentStop: the gate decision.
 * @param {{hook_event_name?: string, cwd?: string, session_id?: string, agent_id?: string, agent_type?: string}} input hook JSON
 * @param {Record<string, string|undefined>} [env]
 * @returns {Promise<{block: boolean, reason?: string}>}
 */
export async function stopDecision(input, env = process.env) {
  const event = input.hook_event_name;
  if (event === 'SubagentStop' && !UI_AGENTS.has(input.agent_type)) return { block: false };
  const cwd = input.cwd ?? process.cwd();
  const problem = await proofProblem(cwd, input, event);
  if (!problem || !firstTime(env, `${input.session_id}`, `${input.agent_id ?? 'lead'}:${problem.key}`)) return { block: false };
  return { block: true, reason: problem.reason };
}

async function main() {
  setTimeout(() => process.exit(0), DEADLINE_MS).unref(); // past the deadline the stop goes through (the hard checks are at landing)
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  if (input.hook_event_name === 'PostToolUse') {
    await recordRun(input).catch(() => false); // a run whose output or ledger cannot be read leaves no record: the stop then finds no PASS
    return;
  }
  const result = await countedDecision(input);
  if (result.block) process.stdout.write(`${JSON.stringify({ decision: 'block', reason: result.reason })}\n`);
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`ui-proof-gate: ${String(error?.message ?? error).split('\n')[0]} (stop allowed)\n`);
    process.exitCode = 0;
  }
}
