// Does a command line start a new Claude Code session or a long-run? The Bash guard denies that from max's work (plan M2b): a session
// started there is a new session with no agent_type, so it would act outside max's click rule (lib/click-only.mjs).
// A start: the real command (lib/command-of.mjs, through keywords and known wrappers) is `claude` with any words but a help or version
// flag; `npx`, `bunx` or `pnpx` of @anthropic-ai/claude-code; or the long-run tool (`long-run.mjs`, run by node or by itself) with a
// verb that starts or drives a run. Both parsers (lib/shell-words.mjs) are read, and so are `$(...)` bodies, `bash -c` scripts and
// `eval` words, so a start inside them counts too.
// Limits: an unknown wrapper (`caffeinate claude`), a command word filled in at run time and a script file that starts claude are not
// seen (the guard asks about the run-time word on its own).
// Exports: startsClaudeSession(segment) -> boolean, lineStartsClaude(command) -> boolean.
// Invariants: pure (no I/O); a false answer never blocks anything.
import { commandName, commandOf } from './command-of.mjs';
import { SHELLS, shellScript } from './other-deleters.mjs';
import { lex, tokenize } from './shell-words.mjs';

const CLAUDE = 'claude';
const INFO_FLAGS = new Set(['--version', '--help', '-v', '-h']); // claude prints and exits: no session
const PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'pnpx']);
const CLAUDE_PACKAGE = '@anthropic-ai/claude-code'; // also with a version: @anthropic-ai/claude-code@2
const LONG_RUN_SCRIPT = 'long-run.mjs';
const LONG_RUN_STARTS = new Set(['start', 'resume', 'rerun', 'schedule', 'tell', 'takeover']); // each starts or drives a `claude -p`
const MAX_NESTING = 24; // like the guard's own limit; deeper bodies are not read (the guard asks about those)

const isClaudePackage = (word) => word === CLAUDE_PACKAGE || word.startsWith(`${CLAUDE_PACKAGE}@`);

/** True when a word in `words` is the long-run script and the word after it is a verb that starts or drives a run. */
function runsLongRun(words) {
  const at = words.findIndex((word) => commandName(word) === LONG_RUN_SCRIPT);
  return at !== -1 && LONG_RUN_STARTS.has(words[at + 1] ?? '');
}

/**
 * @param {string[]} segment the unquoted words of one simple command
 * @returns {boolean} true when it starts a Claude Code session or a long-run (see the header)
 */
export function startsClaudeSession(segment) {
  const { cmd, args, at } = commandOf(segment);
  if (cmd === CLAUDE) return !args.some((word) => INFO_FLAGS.has(word));
  if (PACKAGE_RUNNERS.has(cmd)) return args.some(isClaudePackage);
  if (cmd === 'node' || cmd === LONG_RUN_SCRIPT) return runsLongRun(segment.slice(at));
  return false;
}

/** The command lines a segment hands to a shell: a `bash -c` script, or the words of `eval`. */
function innerLines(segment) {
  const { cmd, args } = commandOf(segment);
  if (SHELLS.has(cmd)) return [shellScript(args)].filter((script) => script !== undefined);
  return cmd === 'eval' ? [args.join(' ')] : [];
}

/** True when a command of the line or of a body inside it, read by `parse` alone (one parser per walk keeps it linear), starts one. */
function startsIn(command, parse, depth) {
  if (depth > MAX_NESTING) return false;
  const { segs, nested } = parse(command);
  if (segs.some(startsClaudeSession)) return true;
  return [...nested, ...segs.flatMap(innerLines)].some((line) => startsIn(line, parse, depth + 1));
}

/**
 * @param {string} command one Bash command line
 * @returns {boolean} true when any command of the line, read by either parser, starts a Claude Code session or a long-run
 */
export const lineStartsClaude = (command) => [tokenize, lex].some((parse) => startsIn(command, parse, 0));
