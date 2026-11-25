// What E11 compares before and after a run, so nothing of the run reached the owner's real setup. Exports: WATCHED_TOOLS,
// realRepoOf(realHome, fallback), leakSnapshot({realHome, realRepo}), resolveTools(env, tools).
// Why (plan section 9): the real checkout's `git status --porcelain` and the real `~/.claude/state/long-run` listing must be the
// same after the run; the real guard log must hold no line of the run's sessions; the dialog, note and sound tools must resolve to
// the run's shims on the children's PATH (so the real ones cannot have run).
// Invariants: reads only (git status, a folder listing, a log); a part that cannot be read is recorded as such, so a comparison
// of two unreadable snapshots is still equal but says so in its observed text.
import { readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runQuick } from './spawn.mjs';
import { readJsonl } from './transcripts.mjs';

/** The tools that would show a dialog, a note or play a sound on the owner's desktop. */
export const WATCHED_TOOLS = Object.freeze(['osascript', 'notify-send', 'afplay']);

/** @returns {string} the checkout the real `~/.claude/agents` links into, else the fallback (the checkout under test) */
export function realRepoOf(realHome, fallback) {
  try {
    return dirname(dirname(realpathSync(join(realHome, '.claude', 'agents'))));
  } catch {
    return fallback;
  }
}

/**
 * @param {{realHome: string, realRepo: string}} where
 * @returns {{gitStatus: string, longRun: string, realGuardSessions: Set<string>}} the state E11 compares
 */
export function leakSnapshot({ realHome, realRepo }) {
  const status = runQuick('git', ['-C', realRepo, 'status', '--porcelain']);
  let longRun;
  try { longRun = readdirSync(join(realHome, '.claude', 'state', 'long-run')).sort().join('\n'); } catch (error) { longRun = `(unreadable: ${error.code})`; }
  const guard = readJsonl(join(realHome, '.claude', 'logs', 'guard.jsonl'));
  return {
    gitStatus: status.code === 0 ? status.stdout : `(git status failed: ${status.stderr.trim().slice(0, 120)})`,
    longRun, realGuardSessions: new Set(guard.map((line) => String(line.session ?? ''))),
  };
}

/**
 * @param {object} env a child's environment (its PATH)
 * @param {readonly string[]} tools
 * @returns {Record<string, string>} where each tool resolves on that PATH ('' when it does not)
 */
export function resolveTools(env, tools = WATCHED_TOOLS) {
  return Object.fromEntries(tools.map((tool) => [tool, runQuick('/bin/sh', ['-c', `command -v ${tool} || true`], { env }).stdout.trim()]));
}
