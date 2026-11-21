// Stop / SubagentStop: the smart check (spec round 9 `r9-smart-check` 4), the one check category on by default. It reads the files this
// session (or this subagent) edited from its smart edit log (post-edit.mjs and bash-writes.mjs write it), keeps those whose content
// changed since the last smart check of the session, and runs home/tools/smart-check/run.mjs on them per git work tree: the pinned
// checks, then each check kind at the level the plan picks. A FAIL (a pinned block, a catch, a hand-over such as the deep review set)
// blocks the stop once with the report on stderr (exit 2), so the agent acts on it; otherwise the report goes to the user as a
// systemMessage. `/check off smart` turns it off for the session.
// Exports: decide(input, nowMs), HOOK_BUDGET_MS.
// Invariants: passes at once (exit 0, no output, nothing imported past the switch and the edit log) when smart is off, outside a git
// repo, or when nothing changed; one block per distinct report (the same report never blocks twice, so no stop loop); its own error
// never blocks: it is one guard-log line (`smart-check-error`) and exit 0, like every live hook. State: <smart-check state>/sessions/
// <session-id>.json (content hashes of the files already checked, the last open FAIL).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isOn, onCategories, readChecks, sessionIdOf } from './lib/checks-on.mjs';
import { readEdits, smartEditLogs } from './lib/edit-log.mjs';
import { logDecision } from './lib/guard-log.mjs';
import { readPlainFile } from './lib/plain-file.mjs';

export const HOOK_BUDGET_MS = 540_000; // below the 600 s timeout in settings/base.json: room to write state and answer
const STATE_MAX_BYTES = 1024 * 1024;
const FILE_HASH_MAX_BYTES = 4 * 1024 * 1024;
const MAX_TREES = 3; // work trees checked in one stop; more are left for the next stop
const MAX_INPUT_BYTES = 1024 * 1024;
const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'smart-check');

const stateDir = () => join(process.env.SMART_CHECK_STATE || join(homedir(), '.claude', 'state', 'smart-check'), 'sessions');

/** The session's record: {seen: {path: hash}, blocked: fingerprint, lastFail: text}; a fresh one when missing or unreadable. */
function readState(sessionId) {
  try {
    const parsed = JSON.parse(readPlainFile(join(stateDir(), `${sessionId}.json`), STATE_MAX_BYTES));
    return { seen: parsed.seen ?? {}, blocked: parsed.blocked ?? '', lastFail: parsed.lastFail ?? '' };
  } catch {
    return { seen: {}, blocked: '', lastFail: '' };
  }
}

function writeState(sessionId, state) {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDir(), `${sessionId}.json`), JSON.stringify(state), { mode: 0o600 });
}

/** The content hash of a file, or 'gone'. */
function hashOf(path) {
  try {
    return createHash('sha256').update(readPlainFile(path, FILE_HASH_MAX_BYTES)).digest('hex').slice(0, 16);
  } catch {
    return 'gone';
  }
}

/** The edited files grouped by the git work tree that holds them (files outside any repo are dropped). */
async function byWorkTree(paths) {
  const { gitTop } = await import(pathToFileURL(join(TOOLS_DIR, 'lib', 'git-changes.mjs')).href);
  const trees = new Map();
  const topOf = new Map();
  for (const path of paths) {
    let dir;
    try { dir = realpathSync(dirname(path)); } catch { continue; } // the folder is gone: nothing left to check there
    if (!topOf.has(dir)) topOf.set(dir, gitTop(dir));
    const top = topOf.get(dir);
    if (top === null) continue;
    const real = join(dir, basename(path));
    trees.set(top, [...(trees.get(top) ?? []), relative(top, real).split('\\').join('/')]);
  }
  return [...trees.entries()].slice(0, MAX_TREES);
}

/** Runs the smart check on each work tree; returns the reports and whether any must be acted on. */
async function checkTrees(trees, sessionId, deadline) {
  const { runSmartCheck } = await import(pathToFileURL(join(TOOLS_DIR, 'run.mjs')).href);
  const { labelChange } = await import(pathToFileURL(join(TOOLS_DIR, 'lib', 'label.mjs')).href).catch(() => ({ labelChange: null }));
  const ownerOn = onCategories(sessionId).filter((name) => name !== 'smart');
  const scope = readChecks(sessionId)?.scope ?? '';
  const results = [];
  for (const [top, paths] of trees) {
    const seconds = Math.floor((deadline - Date.now()) / 1000);
    if (seconds <= 0) { results.push({ block: `smart-check: ${top}: not checked (out of time)`, act: false }); continue; }
    results.push(await runSmartCheck({ cwd: top, paths, ownerOn, scope, label: labelChange, seconds }));
  }
  return results.filter((result) => !result.skip);
}

/**
 * What the hook does for one input.
 * @param {object} input the hook input (session_id, agent_id, hook_event_name)
 * @param {number} [nowMs] the start time
 * @returns {Promise<{exit: 0|2, stdout?: string, stderr?: string} | null>} null: pass silently
 */
export async function decide(input, nowMs = Date.now()) {
  const sessionId = sessionIdOf(input);
  if (!sessionId || !isOn('smart', sessionId)) return null;
  const edited = [...new Set(smartEditLogs(sessionId, input.agent_id).flatMap(readEdits))];
  if (edited.length === 0) return null;
  const state = readState(sessionId);
  const fresh = edited.filter((path) => hashOf(path) !== state.seen[path]);
  if (fresh.length === 0) return state.lastFail ? { exit: 0, stdout: JSON.stringify({ systemMessage: `smart-check: no new change; still open:\n${state.lastFail}` }) } : null;
  const trees = await byWorkTree(fresh);
  const results = trees.length ? await checkTrees(trees, sessionId, nowMs + HOOK_BUDGET_MS) : [];
  for (const path of fresh) state.seen[path] = hashOf(path);
  if (results.length === 0) { writeState(sessionId, state); return null; }
  const block = results.map((result) => result.block).join('\n');
  const act = results.some((result) => result.act);
  const fingerprint = createHash('sha256').update(block.split('\n').filter((line) => !line.startsWith('smart-check ')).join('\n')).digest('hex').slice(0, 16);
  state.lastFail = act ? block : '';
  const blockNow = act && fingerprint !== state.blocked;
  if (blockNow) state.blocked = fingerprint;
  writeState(sessionId, state);
  if (blockNow) return { exit: 2, stderr: `${block}\nAct on these before you stop; a finding you judge wrong: node ~/.claude/tools/smart-check/ledger.mjs truth --change <id> --check <kind> --truth false-alarm\n` };
  return { exit: 0, stdout: JSON.stringify({ systemMessage: block }) };
}

async function main() {
  let input = {};
  try {
    const raw = readFileSync(0, 'utf8');
    if (raw.length > MAX_INPUT_BYTES) return;
    try { input = JSON.parse(raw); } catch { return; } // not hook JSON: nothing to check, never a block
    const answer = await decide(input);
    if (answer === null) return;
    if (answer.stdout) process.stdout.write(`${answer.stdout}\n`);
    if (answer.stderr) process.stderr.write(answer.stderr);
    process.exitCode = answer.exit;
  } catch (error) {
    logDecision({ hook: 'smart-check', tool: String(input?.hook_event_name ?? 'Stop'), decision: 'pass', outcome: 'smart-check-error', reason: String(error?.message ?? error).slice(0, 200), command: '', session: String(input?.session_id ?? '') });
    process.exitCode = 0; // the smart check's own error never blocks a session
  }
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
