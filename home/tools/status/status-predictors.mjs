// What each done row stores beside its times for the 40-job re-run of the estimate backtest (R70, research2/estimate.md P4): files
// planned, lines and files changed, suite seconds, review rounds, writers in parallel, and the model, effort and harness. Nothing
// reads them until that re-run; they are recorded now so the history has them.
// Exports: splitPredictorFlags(words) -> { words, flags, error? }; recordPredictors(entry, deps) -> boolean; PREDICTOR_FLAGS.
// File: <estimate store>/predictors/<table id>.jsonl, one line per done row: { id, at, model, effort, harness, filesPlanned,
// filesChanged, linesChanged, suiteS, reviewRounds, writers } (null where nothing is known). `done` fills the model and effort from
// its flags, else from ANTHROPIC_MODEL and CLAUDE_CODE_EFFORT_LEVEL; lines and files changed from git (`git log --shortstat` of the
// commits since the row's start in the STATUS.md folder's repo).
// Invariants: a failure here never fails the edit (the caller ignores false); every git call has a timeout and fixed flags; a flag
// value is a short plain token or a whole number, never free text.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tableId } from '../estimate/lib/table-store.mjs';

/** done's optional flags: flag -> field and value kind. */
export const PREDICTOR_FLAGS = {
  '--files-planned': ['filesPlanned', 'count'], '--suite-s': ['suiteS', 'count'], '--review-rounds': ['reviewRounds', 'count'],
  '--writers': ['writers', 'count'], '--model': ['model', 'token'], '--effort': ['effort', 'token'],
};
const TOKEN = /^[A-Za-z0-9][\w.:-]{0,63}$/;
const COUNT = /^\d{1,7}$/;
const GIT_TIMEOUT_MS = 2000;
const SHORTSTAT = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/;

/**
 * Takes the predictor flags out of done's words (anywhere after the id).
 * @param {string[]} words done's arguments after the command
 * @returns {{ words: string[], flags: Record<string, string | number>, error?: string }} the words left; error names a bad flag value
 */
export function splitPredictorFlags(words) {
  const left = [];
  const flags = {};
  for (let k = 0; k < words.length; k += 1) {
    const spec = PREDICTOR_FLAGS[words[k]];
    if (!spec) {
      left.push(words[k]);
      continue;
    }
    const value = words[k + 1] ?? '';
    const [field, kind] = spec;
    if (!(kind === 'count' ? COUNT : TOKEN).test(value)) return { words, flags, error: `${words[k]} needs a ${kind === 'count' ? 'whole number' : 'plain word'}` };
    flags[field] = kind === 'count' ? Number(value) : value;
    k += 1;
  }
  return { words: left, flags };
}

/** Files and lines changed by the commits since `sinceMs` in the folder's repo; nulls outside a repo or when git fails. */
function gitChanges(folder, sinceMs) {
  try {
    const out = execFileSync('git', ['-C', folder, 'log', `--since=${new Date(sinceMs).toISOString()}`, '--shortstat', '--format='], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
    const stats = out.split('\n').map((line) => SHORTSTAT.exec(line)).filter(Boolean);
    return {
      filesChanged: stats.reduce((sum, match) => sum + Number(match[1]), 0),
      linesChanged: stats.reduce((sum, match) => sum + Number(match[2] ?? 0) + Number(match[3] ?? 0), 0),
    };
  } catch {
    return { filesChanged: null, linesChanged: null }; // not a repo, or git did not answer in time
  }
}

/**
 * Appends one predictor line for a done row.
 * @param {{ statusFile: string, folder: string, id: string, startedMs: number | null, nowMs: number, flags: object }} entry
 * @param {{ stateDir: string, env?: Record<string, string | undefined> }} deps the estimate store and the environment
 * @returns {boolean} true when written
 */
export function recordPredictors({ statusFile, folder, id, startedMs, nowMs, flags }, { stateDir, env = process.env }) {
  try {
    const changes = startedMs === null ? { filesChanged: null, linesChanged: null } : gitChanges(folder, startedMs);
    const model = flags.model ?? (TOKEN.test(env.ANTHROPIC_MODEL ?? '') ? env.ANTHROPIC_MODEL : null);
    const effort = flags.effort ?? (TOKEN.test(env.CLAUDE_CODE_EFFORT_LEVEL ?? '') ? env.CLAUDE_CODE_EFFORT_LEVEL : null);
    const line = {
      id, at: new Date(nowMs).toISOString(), model, effort, harness: 'claude-code', filesPlanned: flags.filesPlanned ?? null, ...changes,
      suiteS: flags.suiteS ?? null, reviewRounds: flags.reviewRounds ?? null, writers: flags.writers ?? null,
    };
    const dir = join(stateDir, 'predictors');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, `${tableId(statusFile)}.jsonl`), `${JSON.stringify(line)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false; // the store is unusable: the row edit stands without its predictors
  }
}
