// Advice for the Bash guard: a command that waits by sleeping. A sleep loop holds the turn, and a repeated check costs a model call each time, so a
// `for|while|until ... sleep N` loop (N >= 5 s) or one long `sleep` (>= 30 s) is bounced once with the better way to wait. A quality rule,
// not a safety rule: lib/bounce-once.mjs denies the first send with this text and lets the identical retry run, never the owner.
// Exports: WAIT_ADVICE (the text, classed exactly in lib/reason-classes.mjs), WAIT_START_FORM (the start command the text and
// home/agents/dev-run.md name, so tests can hold them equal), waitAdvice(command) -> [] | [WAIT_ADVICE],
// withoutWaitAdvice(verdict) -> verdict (the hook uses it for a call sent with `run_in_background: true`: that wait needs no advice).
// Reads the command like the other guard rules (lib/shell-words.mjs segments): heredoc bodies are dropped, a
// quoted word (`echo "for i; do sleep 9; done"`) is one word, so text that only mentions sleep never counts. The sleep must be a command
// (through wrappers such as `timeout 100 sleep 40`); its time is the sum of its literal arguments (`5`, `0.5`, `1m`, `2h`, `infinity`), and
// a time it cannot read (`sleep $n`) gives no advice. Loops are counted from `for|while|until` to `done`. Not looked into: `$(...)` and
// backtick bodies (cut out, though they run: `x=$(sleep 60; cat out)` sleeps 60 s), `bash -c` scripts, eval, aliases. A missed advice costs only a poll; this rule never decides an ask. Pure, no I/O.
// The text's facts (Claude Code tools reference, Bash tool; changelog 2.1.285 and 2.1.288): in an unattended run (`-p`, Agent SDK, CI, cloud) a
// background command stops after 30 min (10 min for a text `-p` prompt) unless `timeout` is passed, and 7200000 ms is the most; an interactive
// session has no limit. No page says which of the two a background subagent is, so the advice is "set timeout" for every background command.
// Same page: a background command of a foreground subagent stops when that agent's run ends, while the main session's or a background
// subagent's keeps running and its exit is a completion notice. So the text names one way to wait: over 3 min, start in the background
// and wait for that notice; to wait for anything else, the Monitor tool (each line its command prints is a notice; it ends when the
// command exits). A shell still running at the final report keeps the agent listed as running, so the text says to stop it first.
// Condition loops (spec-p3 `r9-waits-more`): a `while` or `until` loop whose condition polls (`kill -0`, `pgrep`, `grep -q`, `test`, `[`, `[[`)
// and that sleeps at all is a wait at any sleep length (`while kill -0 $pid; do sleep 2; done`); a `for` loop keeps the 5 s rule, so
// a bounded `for` pause loop still runs. Plain retries (`until npm ci; do sleep 1; done`) stay allowed. A background subagent's
// result arrives as a notification (sub-agents docs), so the text says not to poll its output file.
import { commandOf, KEYWORDS } from './command-of.mjs';
import { withoutSubstitutions } from './merge-commit.mjs';
import { segments, stripHeredocs } from './shell-words.mjs';

const BACKGROUND_TIMEOUT_MAX_MS = 7200000; // 2 h: the longest `timeout` the Bash tool takes for a background command
const FOREGROUND_TIMEOUT_MAX_MS = 600000; // 10 min: the longest `timeout` a foreground Bash call takes by default (BASH_MAX_TIMEOUT_MS)

/**
 * How a command over 3 min is started (with `run_in_background: true` and `timeout`): output to a log, exit code to `<log>.exit`. The old
 * `<log>.exit` is removed first, so a Monitor that waits for that file never ends at once on the exit file of an earlier run.
 */
export const WAIT_START_FORM = 'rm -f <log>.exit; <command> > <log> 2>&1; echo $? > <log>.exit';

export const WAIT_ADVICE = 'Waiting (speed): do not wait with a long sleep or a sleep loop: it holds the turn, and a repeated check costs a model call each time. '
  + 'A command that ends within 3 min runs in the foreground with an explicit timeout. '
  + `Run a longer one with run_in_background: true and set timeout to its expected run plus a margin, at most ${BACKGROUND_TIMEOUT_MAX_MS} ms (2 h), started as ${WAIT_START_FORM}. `
  + 'Its completion notice is the wait: work on or end your turn, then read the log once. '
  + 'To wait for anything else (a file, a log line, a server), use the Monitor tool with a command that prints a line on success and on failure and then exits, '
  + 'or send the check loop itself with run_in_background: true: its exit is the notice. '
  + `A foreground subagent gets no notice and its background commands stop when its run ends: there, run the command in the foreground with timeout ${FOREGROUND_TIMEOUT_MAX_MS}. `
  + 'Before your final report, stop every background command and monitor you started (TaskStop); never report while one runs. '
  + 'Set timeout for every background command: in an unattended run (-p, Agent SDK, CI, cloud) one without it stops after 30 min '
  + '(10 min for a text -p prompt). A run over 2 h is split, or started in an interactive session, where background commands have no limit. '
  + "A background subagent's result arrives as a notification (with fork mode on the lead cannot wait on a subagent at all): never poll its output file. "
  + 'If a sleep is what you need, send the same command again and it runs.';

const LOOP_SLEEP_SECONDS = 5; // a shorter sleep inside a loop is a pause between steps, not a wait
const LONE_SLEEP_SECONDS = 30; // a single sleep this long (or longer) is a wait, loop or not
const LOOP_OPENERS = new Set(['for', 'while', 'until']);
const SECONDS_PER_UNIT = { s: 1, m: 60, h: 3600, d: 86400 };
const SLEEP_TIME = /^(\d+(?:\.\d+)?)([smhd]?)$/;
const CONDITION_OPENERS = new Set(['while', 'until']);
// Commands whose exit says whether a thing is there yet: a loop on one of them is a poll, whatever it sleeps.
const POLL_COMMANDS = new Set(['pgrep', 'test', '[', '[[']);
const isPollCondition = (cmd, args) => POLL_COMMANDS.has(cmd) || (cmd === 'kill' && args[0] === '-0') || (cmd === 'grep' && args.some((arg) => /^-[a-zA-Z]*q/.test(arg)));

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

/** True when the segment opens a `while`/`until` loop whose condition command polls (isPollCondition). */
function opensPollLoop(words) {
  const opener = words.findIndex((word) => CONDITION_OPENERS.has(word));
  if (opener === -1) return false;
  const rest = words.slice(opener + 1).filter((word) => word !== '!');
  const { cmd, args } = commandOf(rest);
  return isPollCondition(cmd, args);
}

/**
 * @param {string} command raw command text
 * @returns {string[]} [WAIT_ADVICE] when the line sleeps in a loop for 5 s or more, sleeps at all inside a polling `while`/`until`
 *   loop, or sleeps 30 s or more at all; else []
 */
export function waitAdvice(command) {
  if (!command.toLowerCase().includes('sleep')) return []; // any case: commandOf folds the command word where the platform does
  let loopDepth = 0;
  let pollDepth = 0; // depth of the innermost open poll loop, 0 when none
  for (const words of segments(withoutSubstitutions(stripHeredocs(command)))) {
    const change = loopChange(words);
    if (change < 0 && loopDepth === pollDepth) pollDepth = 0;
    loopDepth = Math.max(0, loopDepth + change);
    if (change > 0 && opensPollLoop(words)) pollDepth = loopDepth;
    const { cmd, args } = commandOf(words);
    if (cmd !== 'sleep') continue;
    const seconds = sleepSeconds(args);
    if (seconds === undefined) continue;
    if (seconds >= LONE_SLEEP_SECONDS || (loopDepth > 0 && seconds >= LOOP_SLEEP_SECONDS) || (pollDepth > 0 && seconds > 0)) return [WAIT_ADVICE];
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
