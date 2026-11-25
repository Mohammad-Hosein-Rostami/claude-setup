// Reads the stream-json output of one `claude -p` run. Exports: parseStream(text), readStream(file), sessionIdOf(events),
// initOf(events), resultOf(events), limitOf(events, stderr), limitLine(event), resetText(limit).
// Format (Claude Code 2.1.330, observed in long-run step logs): one JSON object per line; `{type: "system", subtype: "init",
// session_id, model, apiKeySource, permissionMode, ...}`, `assistant` / `user` lines, `{type: "rate_limit_event", rate_limit_info:
// {status: allowed | allowed_warning | rejected, resetsAt (epoch s), rateLimitType, isUsingOverage}}`, and one `{type: "result",
// subtype, is_error, result, session_id, modelUsage, permission_denials, api_error_status}` per turn.
// A usage limit (plan section 9: stop every scenario, print the reset time, never retry): a rate_limit_event whose status is
// `rejected`, a result whose text or error matches long-run's LIMIT_TEXT (the printed `You've hit your ... limit · resets ...`), or
// an api_error_status of 429. Usage credits in use (`isUsingOverage: true`) stop the run the same way: credits are off by the
// owner's rule, so a run that spends them must not go on.
// Invariants: a line that is not JSON is skipped (stderr text, a cut line); nothing here throws on bad input.
import { readFileSync } from 'node:fs';
import { LIMIT_TEXT } from '../../../home/tools/long-run/lib/limit-time.mjs';

const RATE_LIMITED_STATUS = 429;
const MS_PER_S = 1000;

/** @returns {object[]} the JSON objects of the text, one per line */
export function parseStream(text) {
  return String(text ?? '').split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const event = JSON.parse(line);
      return event !== null && typeof event === 'object' ? [event] : [];
    } catch {
      return [];
    }
  });
}

/** @returns {object[]} the events of a stream file; none when it is missing */
export function readStream(file) {
  try {
    return parseStream(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

/** @returns {object | null} the init event */
export const initOf = (events) => events.find((event) => event.type === 'system' && event.subtype === 'init') ?? null;

/** @returns {string | null} the session id of the run (init first, else any event that names one) */
export const sessionIdOf = (events) => initOf(events)?.session_id ?? events.find((event) => typeof event.session_id === 'string')?.session_id ?? null;

/** @returns {object | null} the last result event (a run with background agents can print more than one) */
export const resultOf = (events) => [...events].reverse().find((event) => event.type === 'result') ?? null;

/**
 * @param {object} event one stream event
 * @returns {{kind: 'limit' | 'credits', resetsAtMs: number | null, text: string} | null} a stop reason, or null
 */
export function limitLine(event) {
  if (event?.type === 'rate_limit_event') {
    const info = event.rate_limit_info ?? {};
    const resetsAtMs = Number.isFinite(info.resetsAt) ? info.resetsAt * MS_PER_S : null;
    if (info.isUsingOverage === true) return { kind: 'credits', resetsAtMs, text: 'usage credits are in use (isUsingOverage)' };
    if (info.status === 'rejected') return { kind: 'limit', resetsAtMs, text: `${info.rateLimitType ?? 'usage'} limit reached` };
    return null;
  }
  if (event?.type === 'result') {
    const text = [event.result, event.error, ...(Array.isArray(event.errors) ? event.errors : [])].filter(Boolean).join(' ');
    if (event.api_error_status === RATE_LIMITED_STATUS || (event.is_error === true && LIMIT_TEXT.test(text)) || LIMIT_TEXT.test(String(event.error ?? ''))) {
      return { kind: 'limit', resetsAtMs: null, text: text.slice(0, 200) || 'rate limited (429)' };
    }
  }
  return null;
}

/**
 * @param {object[]} events the run's events
 * @param {string} stderr the run's stderr (a limit can be printed there)
 * @returns {{kind: 'limit' | 'credits', resetsAtMs: number | null, text: string} | null} the first stop reason of the run
 */
export function limitOf(events, stderr = '') {
  for (const event of events) {
    const found = limitLine(event);
    if (found !== null) return found;
  }
  const printed = LIMIT_TEXT.exec(String(stderr));
  return printed ? { kind: 'limit', resetsAtMs: null, text: String(stderr).slice(Math.max(0, printed.index - 40), printed.index + 160) } : null;
}

/** @returns {string} the reset time in words: an ISO time when the event gave one, else the printed text */
export const resetText = (limit) => (limit.resetsAtMs !== null ? new Date(limit.resetsAtMs).toISOString() : `see: ${limit.text}`);
