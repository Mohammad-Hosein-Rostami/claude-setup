// Shows a desktop note only when work waits on the owner or has stopped, such as a question or a rate limit.
// Notification and StopFailure hook: a desktop note only when work waits on the owner or stopped (display design 7.10;
// spec-p5 `r9-notify`). Notification `permission_prompt` and `elicitation_*` give `Needs you: ...` (with the asking marker's
// count and time to the default), `quota_auto_resume_stale|disabled` give `Stopped: ...`; StopFailure `rate_limit` gives
// `Stopped: 5-hour limit, resumes 17:40` from this account's last limit sample (CLAUDE_ACCOUNT, limits-store.mjs). No Stop entry
// is registered (the queued agent-failed note and its Stop entry were removed on 2026-11-24).
// The note goes out as `terminalSequence` (hooks docs, "Emit terminal notifications": kept on Notification and StopFailure, whose
// other output is discarded; written only in an interactive session); no other output field is printed.
// Exports: noteFor(input, env, now) -> text | null, hookOutput(text, env) -> stdout string.
// Invariants: prints at most one JSON object and always exits 0, never blocks or changes a turn; a note needs a known event and
// type, everything else prints nothing; nothing from the hook input reaches the note except the event and type names it matches.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readAsking } from './lib/asking-marker.mjs';
import { effectiveChannel, needsYouText, noteSequence, quotaText, stoppedText } from './lib/notify-note.mjs';
import { latestSample, readLimits } from './lib/limits-store.mjs';

const MAX_INPUT_BYTES = 1024 * 1024;

/**
 * @param {{ hook_event_name?: string, notification_type?: string, error?: string, session_id?: string }} input the hook JSON
 * @param {Record<string, string | undefined>} [env] process environment (HOME, CLAUDE_ACCOUNT)
 * @param {number} [now] epoch ms
 * @returns {string | null} the note to send, or null for none
 */
export function noteFor(input, env = process.env, now = Date.now()) {
  const event = input?.hook_event_name;
  if (event === 'Notification') {
    const type = String(input.notification_type ?? '');
    return quotaText(type) ?? needsYouText(type, readAsking(input.session_id, env, now), now);
  }
  if (event === 'StopFailure') {
    return input.error === 'rate_limit' ? stoppedText(latestSample(readLimits(env.CLAUDE_ACCOUNT))) : null;
  }
  return null;
}

/** @returns {string} the hook's stdout: `{"terminalSequence": ...}` on the owner's channel, or '' for no note */
export function hookOutput(text, env = process.env) {
  const sequence = text ? noteSequence(text, effectiveChannel(env)) : '';
  return sequence ? JSON.stringify({ terminalSequence: sequence }) : '';
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) return null;
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function main() {
  try {
    const out = hookOutput(noteFor(await readInput()));
    if (out) process.stdout.write(out);
  } catch {
    // not hook JSON or an unreadable store: no note, never a failed hook
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().finally(() => { process.exitCode = 0; });
}
