// Advice for the Bash guard: a command that waits by sleeping. A sleep loop holds the turn, and a repeated check costs a model call each time, so a
// `for|while|until ... sleep N` loop (N >= 5 s) or one long `sleep` (>= 30 s) is bounced once with the better way to wait. A quality rule,
// not a safety rule: lib/bounce-once.mjs denies the first send with this text and lets the identical retry run, never the owner.
// Exports: WAIT_ADVICE (the text, classed exactly in lib/reason-classes.mjs), WAIT_START_FORM and WAIT_CALL (the two commands the text and
// the agents' Waiting lines name, so tests can hold them equal), waitAdvice(command) -> [] | [WAIT_ADVICE],
// withoutWaitAdvice(verdict) -> verdict (the hook uses it for a call sent with `run_in_background: true`: that wait needs no advice).
// Reads the command like the other guard rules (lib/shell-words.mjs segments): heredoc bodies are dropped, a
// quoted word (`echo "for i; do sleep 9; done"`) is one word, so text that only mentions sleep never counts. The sleep must be a command
// (through wrappers such as `timeout 100 sleep 40`); its time is the sum of its literal arguments (`5`, `0.5`, `1m`, `2h`, `infinity`), and
// a time it cannot read (`sleep $n`) gives no advice. Loops are counted from `for|while|until` to `done`. Not looked into: `$(...)` and
// backtick bodies (cut out, though they run: `x=$(sleep 60; cat out)` sleeps 60 s), `bash -c` scripts, eval, aliases. A missed advice costs only a poll; this rule never decides an ask. Pure, no I/O.
// The text's facts (Claude Code tools reference, Bash tool; changelog 2.1.285 and 2.1.288): in an unattended run (`-p`, Agent SDK, CI, cloud) a
// background command stops after 30 min (10 min for a text `-p` prompt) unless `timeout` is passed, and 7200000 ms is the most; an interactive
// session has no limit. No page says which of the two a workflow agent is, so the advice is "set timeout" for every background command.
// Same page: a background command of a foreground subagent stops when that agent's run ends, while the main session's or a background
// subagent's keeps running (only those are told of its exit). Changelog: a background subagent's foreground command is moved to the
// background after 3 min (seen at 180 s with `timeout` 600000, Claude Code 2.1.329). No agent is told which it is, so the text names one
// way to wait that holds for all: over 3 min, start in the background, then wait inside the turn with a call that ends by itself in
// 160 s. The wait call's 2 s pause is under this rule's own 5 s loop limit, so the guard lets it run (tests hold that).
// watch.mjs watches session transcripts: it is named for waiting on a session or an agent, never as a way to run or bound a command.
import { commandOf, KEYWORDS } from './command-of.mjs';
import { withoutSubstitutions } from './merge-commit.mjs';
import { segments, stripHeredocs } from './shell-words.mjs';

const BACKGROUND_TIMEOUT_MAX_MS = 7200000; // 2 h: the longest `timeout` the Bash tool takes for a background command
const WAIT_CALL_TIMEOUT_MS = 180000; // 3 min: a background subagent's foreground command is moved to the background after this long
const WAIT_ROUNDS = 80; // rounds of one wait call: 80 x 2 s = 160 s, so the call ends by itself before it would be moved
const WAIT_PAUSE_SECONDS = 2; // a pause between two looks at one file, under LOOP_SLEEP_SECONDS

/** How a command over 3 min is started (with `run_in_background: true` and `timeout`): output to a log, exit code to `<log>.exit`. */
export const WAIT_START_FORM = '<command> > <log> 2>&1; echo $? > <log>.exit';
/** The foreground call that waits for that command inside the agent's turn: it ends when `<log>.exit` is there, or after 160 s. */
export const WAIT_CALL = `for i in $(seq ${WAIT_ROUNDS}); do [ -f <log>.exit ] && break; sleep ${WAIT_PAUSE_SECONDS}; done`;

export const WAIT_ADVICE = 'Waiting (speed): do not wait with a long sleep or a sleep loop: it holds the turn, and a repeated check costs a model call each time. '
  + 'A command that ends within 3 min runs in the foreground with an explicit timeout. '
  + `Run a longer one with run_in_background: true and set timeout to its expected run plus a margin, at most ${BACKGROUND_TIMEOUT_MAX_MS} ms (2 h), started as ${WAIT_START_FORM}. `
  + `Then wait inside your turn with one foreground call (timeout ${WAIT_CALL_TIMEOUT_MS}) that ends by itself in ${WAIT_ROUNDS * WAIT_PAUSE_SECONDS} s (a background subagent's foreground command is moved to the background after 3 min): ${WAIT_CALL}; send it again until <log>.exit is there, then read the log in one call. `
  + "Never end your turn while the command runs: a background command of a foreground subagent stops when that agent's run ends and nobody is woken; "
  + "only the main session's or a background subagent's keeps running. "
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

/**
 * The verdict for a call the agent already sends with `run_in_background: true`: a wait in the background holds no turn and costs no
 * model call while it runs, which is what the advice asks for, so the wait advice is dropped. Every ask and every other advice stays.
 * @param {{advice?: string[]}} verdict what decide() returned
 * @returns {object} the same verdict without WAIT_ADVICE, and without an `advice` key when none is left
 */
export function withoutWaitAdvice(verdict) {
  const { advice = [], ...rest } = verdict;
  const kept = advice.filter((text) => text !== WAIT_ADVICE);
  return kept.length === 0 ? rest : { ...rest, advice: kept };
}
