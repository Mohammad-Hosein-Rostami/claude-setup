// Advice for the Bash guard: a command that waits by sleeping. Every poll is a model call that re-reads the whole conversation, so a
// `for|while|until ... sleep N` loop (N >= 5 s) or one long `sleep` (>= 30 s) is bounced once with the better way to wait. A quality rule,
// not a safety rule: lib/bounce-once.mjs denies the first send with this text and lets the identical retry run, never the owner.
// Exports: WAIT_ADVICE (the text, classed exactly in lib/reason-classes.mjs), waitAdvice(command) -> [] | [WAIT_ADVICE].
// Reads the command like the other guard rules (lib/shell-words.mjs segments): heredoc bodies are dropped and `$(...)` bodies cut out, a
// quoted word (`echo "for i; do sleep 9; done"`) is one word, so text that only mentions sleep never counts. The sleep must be a command
// (through wrappers such as `timeout 100 sleep 40`); its time is the sum of its literal arguments (`5`, `0.5`, `1m`, `2h`, `infinity`), and
// a time it cannot read (`sleep $n`) gives no advice. Loops are counted from `for|while|until` to `done`. Not looked into: `bash -c`
// scripts, eval, aliases. A missed advice costs only a poll; this rule never decides an ask. Pure, no I/O.
// The text's facts (Claude Code tools reference, Bash tool; changelog 2.1.285 and 2.1.288): in an unattended run (`-p`, Agent SDK, CI, cloud) a
// background command stops after 30 min (10 min for a text `-p` prompt) unless `timeout` is passed, and 7200000 ms is the most; an interactive
// session has no limit. No page says which of the two a workflow agent is, so the advice is "set timeout" for every background command.
// watch.mjs watches session transcripts: it is named for waiting on a session or an agent, never as a way to run or bound a command.
import { commandOf, KEYWORDS } from './command-of.mjs';
import { withoutSubstitutions } from './merge-commit.mjs';
import { segments, stripHeredocs } from './shell-words.mjs';

const BACKGROUND_TIMEOUT_MAX_MS = 7200000; // 2 h: the longest `timeout` the Bash tool takes for a background command

export const WAIT_ADVICE = 'Waiting (speed): do not wait with a sleep loop, every poll is a model call that re-reads the whole conversation. '
  + `Run the long command with run_in_background: true and set timeout to its expected run plus a margin, at most ${BACKGROUND_TIMEOUT_MAX_MS} ms (2 h): `
  + 'you are woken when it exits, then read its result file in one call. '
  + 'Set timeout for every background command: in an unattended run (-p, Agent SDK, CI, cloud) one without it stops after 30 min '
  + '(10 min for a text -p prompt). A run over 2 h is split, or started in an interactive session, where background commands have no limit. '
  + 'node ~/.claude/tools/watch/watch.mjs waits on a session or an agent only: it never runs or bounds a command. '
  + 'If a sleep is what you need, send the same command again and it runs.';

const LOOP_SLEEP_SECONDS = 5; // a shorter sleep inside a loop is a pause between steps, not a wait
const LONE_SLEEP_SECONDS = 30; // a single sleep this long (or longer) is a wait, loop or not
const LOOP_OPENERS = new Set(['for', 'while', 'until']);
const SECONDS_PER_UNIT = { s: 1, m: 60, h: 3600, d: 86400 };
const SLEEP_TIME = /^(\d+(?:\.\d+)?)([smhd]?)$/;

/** @returns {number | undefined} seconds the `sleep` arguments add up to, or undefined when one is not a literal time (`$n`, `$((i*2))`) */
function sleepSeconds(args) {
  if (args.length === 0) return undefined;
  let total = 0;
  for (const arg of args) {
    if (arg === 'infinity') return Infinity;
    const [, amount, unit] = SLEEP_TIME.exec(arg) ?? [];
    if (amount === undefined) return undefined;
    total += Number(amount) * SECONDS_PER_UNIT[unit || 's'];
  }
  return total;
}

/** How a segment changes the loop depth: +1 when it opens a loop (`for`, `while`, `until`, after any leading keywords), -1 for `done`. */
function loopChange(words) {
  const lead = words.findIndex((word) => !KEYWORDS.has(word));
  const leadingWords = lead === -1 ? words : words.slice(0, lead + 1);
  if (leadingWords.some((word) => LOOP_OPENERS.has(word))) return 1;
  return words[0] === 'done' ? -1 : 0;
}

/**
 * @param {string} command raw command text
 * @returns {string[]} [WAIT_ADVICE] when the line sleeps in a loop for 5 s or more, or sleeps 30 s or more at all; else []
 */
export function waitAdvice(command) {
  if (!command.toLowerCase().includes('sleep')) return []; // any case: commandOf folds the command word where the platform does
  let loopDepth = 0;
  for (const words of segments(withoutSubstitutions(stripHeredocs(command)))) {
    loopDepth = Math.max(0, loopDepth + loopChange(words));
    const { cmd, args } = commandOf(words);
    if (cmd !== 'sleep') continue;
    const seconds = sleepSeconds(args);
    if (seconds !== undefined && (seconds >= LONE_SLEEP_SECONDS || (loopDepth > 0 && seconds >= LOOP_SLEEP_SECONDS))) return [WAIT_ADVICE];
  }
  return [];
}
