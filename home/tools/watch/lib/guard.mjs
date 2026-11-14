// Filters guard-log lines (~/.claude/logs/guard.jsonl) down to the ones a watcher should be woken for.
// Exports: guardAction(rawLine, watched) -> string | undefined, watched = Map<sessionId, label>.
// Printed: outcome deny, timeout, no-gui or dialog-failed, for a watched session only. A secret-ask that timed out or had no
// dialog is skipped (the guard goes ahead as Allow by design); a secret-ask deny is printed.
// Invariants: never prints the command whole: it is masked with the guard's own maskSecrets, flattened and cut to 60 chars;
// the reason is masked and cut too; control characters become spaces so one record is one notification line.
import { maskSecrets } from '../../../hooks/lib/secrets.mjs';

const REPORTED_OUTCOMES = new Set(['deny', 'timeout', 'no-gui', 'dialog-failed']);
const SECRET_ASK = 'literal password/token';
const COMMAND_CHARS = 60;
const REASON_CHARS = 120;
const CONTROL_CHARS = /[\p{Cc}\u2028\u2029]/gu;

const clean = (text, limit) => Array.from(maskSecrets(String(text ?? '')).replace(CONTROL_CHARS, ' ')).slice(0, limit).join('');

/**
 * @param {string} rawLine one line of the guard log
 * @param {Map<string, string>} watched session id -> short label of every watched session
 * @returns {string | undefined} `label: GUARD <outcome> <hook>: <reason> | <command>`, or undefined when not reportable
 */
export function guardAction(rawLine, watched) {
  let record;
  try { record = JSON.parse(rawLine); } catch { return undefined; }
  if (record === null || typeof record !== 'object') return undefined;
  const label = watched.get(record.session);
  if (label === undefined || !REPORTED_OUTCOMES.has(record.outcome)) return undefined;
  const reason = String(record.reason ?? '');
  if (reason.includes(SECRET_ASK) && record.outcome !== 'deny') return undefined;
  return `${label}: GUARD ${record.outcome} ${clean(record.hook, 40)}: ${clean(reason, REASON_CHARS)} | ${clean(record.command, COMMAND_CHARS)}`;
}
