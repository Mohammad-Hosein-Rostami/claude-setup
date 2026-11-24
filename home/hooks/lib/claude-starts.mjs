// Does a command line start a new Claude Code session or a long-run? The Bash guard denies that from max's work (plan M2b): a session
// started there is a new session with no agent_type, so it would act outside max's click rule (lib/click-only.mjs).
// A start: a command word that is `claude` with any words but a help or version flag, the @anthropic-ai/claude-code package (any
// version) or a script file inside it (`node .../@anthropic-ai/claude-code/cli.js`), or the long-run tool (`long-run.mjs`) with a verb
// that starts or drives a run. Every word of a simple command is tried as a command word, as lib/dangerous-scan.mjs does, so a launcher
// no list knows (`setsid`, `screen -dm`, `script -q f`, `caffeinate`) and a package runner (`pnpm dlx`, `npm exec`) count too; a
// command that only shows or forwards its words (lib/dangerous-scan.mjs SCAN_STOP: `echo`, `grep`, `git`, `ssh` ...) is not scanned
// unless it is a package runner, and for `find` only the command after -exec|-execdir|-ok|-okdir is. A scanned word that holds a blank
// is read as a command line of its own (`tmux new -d 'claude -p hi'`; a `git commit -m '...'` message is not scanned), and so are
// `$(...)` bodies, `bash -c` scripts and `eval` words. Both parsers (lib/shell-words.mjs) are read.
// Limits: a command word filled in at run time and a script file that starts claude are not seen (the guard asks about the run-time
// word on its own); a word `claude` given as data to a command that is not in SCAN_STOP (`mkdir claude`) counts as a start.
// Exports: startsClaudeSession(segment) -> boolean, lineStartsClaude(command) -> boolean.
// Invariants: pure (no I/O); a false answer never blocks anything.
import { commandName, commandOf } from './command-of.mjs';
import { SCAN_STOP, packageName, runsBin, runsCommand } from './dangerous-scan.mjs';
import { SHELLS, shellScript } from './other-deleters.mjs';
import { lex, tokenize } from './shell-words.mjs';

const CLAUDE = 'claude';
const CLAUDE_BIN = new Set([CLAUDE]);
const INFO_FLAGS = new Set(['--version', '--help', '-v', '-h']); // claude prints and exits: no session
const CLAUDE_PACKAGE = '@anthropic-ai/claude-code';
const CLAUDE_PACKAGE_SCRIPT = /(?:^|[/\\])@anthropic-ai[/\\]claude-code[/\\].*\.[cm]?js$/; // node_modules/@anthropic-ai/claude-code/cli.js
const LONG_RUN_SCRIPT = 'long-run.mjs';
const LONG_RUN_STARTS = new Set(['start', 'resume', 'rerun', 'schedule', 'tell', 'takeover']); // each starts or drives a `claude -p`
const FIND_RUNS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const MAX_SCAN_WORDS = 100; // as lib/dangerous-scan.mjs: a launcher's own words are few
const MAX_NESTING = 24; // like the guard's own limit; deeper bodies are not read (the guard asks about those)
const BLANK = /\s/;

/** True when `words` (a command word first) start a Claude Code session or a long-run (see the header). */
function startsAt(words) {
  const { cmd, args, at } = commandOf(words);
  if (cmd === undefined) return false;
  if (cmd === CLAUDE) return !args.some((word) => INFO_FLAGS.has(word));
  if (packageName(words[at]) === CLAUDE_PACKAGE || CLAUDE_PACKAGE_SCRIPT.test(words[at])) return true;
  return cmd === LONG_RUN_SCRIPT && LONG_RUN_STARTS.has(args[0] ?? '');
}

/** The indexes of `segment` that may start a command: the real command word, and the later words the header names. */
function commandStarts(segment) {
  const { cmd, args, at } = commandOf(segment);
  if (cmd === undefined) return [];
  const end = Math.min(segment.length, at + 1 + MAX_SCAN_WORDS);
  const later = Array.from({ length: Math.max(0, end - at - 1) }, (_, offset) => at + 1 + offset);
  if (cmd === 'find') return [at, ...later.filter((i) => FIND_RUNS.has(segment[i - 1]))];
  const scanned = !SCAN_STOP.has(commandName(segment[at])) || runsCommand(cmd, args) || runsBin(cmd, args, CLAUDE_BIN);
  return scanned ? [at, ...later] : [at];
}

/**
 * @param {string[]} segment the unquoted words of one simple command
 * @returns {boolean} true when it starts a Claude Code session or a long-run (see the header)
 */
export const startsClaudeSession = (segment) => commandStarts(segment).some((i) => startsAt(segment.slice(i)));

/** The command lines a segment hands on: at each command start, a `bash -c` script, the words of `eval`, or a word with a blank. */
function innerLines(segment) {
  return commandStarts(segment).flatMap((i) => {
    const { cmd, args } = commandOf(segment.slice(i));
    if (SHELLS.has(cmd)) return [shellScript(args)].filter((script) => script !== undefined);
    if (cmd === 'eval') return [args.join(' ')];
    return BLANK.test(segment[i]) ? [segment[i]] : [];
  });
}

/** True when a command of the line or of a body inside it, read by `parse` alone (one parser per walk keeps it linear), starts one. */
function startsIn(command, parse, depth) {
  if (depth > MAX_NESTING) return false;
  const { segs, nested } = parse(command);
  if (segs.some(startsClaudeSession)) return true;
  return [...new Set([...nested, ...segs.flatMap(innerLines)])].some((line) => startsIn(line, parse, depth + 1));
}

/**
 * @param {string} command one Bash command line
 * @returns {boolean} true when any command of the line, read by either parser, starts a Claude Code session or a long-run
 */
export const lineStartsClaude = (command) => [tokenize, lex].some((parse) => startsIn(command, parse, 0));
