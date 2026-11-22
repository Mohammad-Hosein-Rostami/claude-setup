#!/usr/bin/env node
// CLI of the owner-decision queue: agents `post` questions (stamped with the session of env CLAUDE_CODE_SESSION_ID when it is a UUID), the lead `watch`es, asks the owner, then `answer`s.
// Usage: ask.mjs init | post [--queue P] --json OBJ | answer --queue P ID [--force] [--default] (--option N | --text-stdin | TEXT) | get --queue P ID
//        | show --queue P ID
//        | list --queue P [--open] | watch --queue P [--interval-ms 1000]    (--queue defaults to env ASK_QUEUE)
// `--` ends the flags; an unknown --flag is an error. Exit codes: 0 ok, 2 usage or validation error, 3 `get` on an open question.
// Invariants: the queue is append-only JSONL confined to ~/.claude/ask (see lib/store.mjs); logic lives in lib/queue.mjs,
// so this file only parses arguments and prints; anything printed from queue data goes through `sanitize`. `answer` never
// overwrites unasked: an already-answered id exits 2 and prints the existing answer (so a forged one is noticed);
// `--force` appends a newer answer, and the last answer wins. `--default` marks the answer `by: "timeout"`: a default taken
// when the owner did not answer, which a reader (ui-coverage) must not count as the owner's decision.
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { BY_TIMEOUT, ID_PATTERN, QUEUE_FULL, SESSION_UUID, answerFor, formatLine, formatShow, formatWatchLine, nextId, openQuestions, parseLine, sanitize, validate } from './lib/queue.mjs';
import { UsageError, appendRecord, confineQueue, createQueue, readNew, readQueue, withLock } from './lib/store.mjs';

const EXIT_USAGE = 2;
const EXIT_OPEN = 3;
const DEFAULT_INTERVAL_MS = 1000;
const MAX_ANSWER_CHARS = 2000;
const VALUE_FLAGS = new Set(['--queue', '--json', '--interval-ms', '--option']);
const BOOLEAN_FLAGS = new Set(['--open', '--text-stdin', '--force', '--default']);
const STDIN_FD = 0;

function fail(message) {
  process.stderr.write(`ask: ${sanitize(message)}\n`);
  process.exit(EXIT_USAGE);
}

// Split argv into {flags, positional}: `--` ends the flags, a value flag takes the next argument, unknown --flags throw.
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') positional.push(...argv.slice(i + 1));
    else if (VALUE_FLAGS.has(arg)) {
      if (i + 1 >= argv.length) throw new UsageError(`${arg} needs a value`);
      flags[arg] = argv[(i += 1)];
    } else if (BOOLEAN_FLAGS.has(arg)) flags[arg] = true;
    else if (arg.startsWith('--')) throw new UsageError(`unknown flag ${arg}`);
    else positional.push(arg);
    if (arg === '--') break;
  }
  return { flags, positional };
}

function queueFile(flags) {
  const path = flags['--queue'] || process.env.ASK_QUEUE;
  if (!path) throw new UsageError('no queue: pass --queue <path> or set ASK_QUEUE');
  return confineQueue(path);
}

function questionFor(records, id) {
  if (!ID_PATTERN.test(id ?? '')) throw new UsageError(`bad question id: ${id}`);
  const question = records.find((r) => r.type === 'q' && r.id === id);
  if (!question) throw new UsageError(`unknown question id: ${id}`);
  return question;
}

function init() {
  console.log(createQueue());
}

function post(flags) {
  const real = queueFile(flags);
  let obj;
  try {
    obj = JSON.parse(flags['--json'] ?? '');
  } catch {
    throw new UsageError('--json must be a JSON object');
  }
  const result = validate(obj);
  if (!result.ok) throw new UsageError(`invalid question: ${result.errors.join('; ')}`);
  const id = withLock(real, () => {
    let next;
    try {
      next = nextId(readQueue(real));
    } catch (err) {
      if (err instanceof RangeError) throw new UsageError(`${QUEUE_FULL}: no free question id left`);
      throw err;
    }
    const session = process.env.CLAUDE_CODE_SESSION_ID ?? '';
    appendRecord(real, { type: 'q', id: next, ...result.value, ...(SESSION_UUID.test(session) ? { session } : {}) });
    if (!readQueue(real).some((r) => r.type === 'q' && r.id === next)) throw new UsageError(`${next} was written but cannot be read back`);
    return next;
  });
  console.log(id);
}

// The answer text: the label of option N (so the lead never pastes agent-written text into a shell), stdin, or the words.
function answerText(flags, question, words) {
  const sources = [flags['--option'] !== undefined, flags['--text-stdin'] === true, words.length > 0].filter(Boolean).length;
  if (sources !== 1) throw new UsageError('usage: answer --queue <path> <id> [--default] (--option <n> | --text-stdin | <text>)');
  if (flags['--option'] !== undefined) {
    const n = Number(flags['--option']);
    const option = Number.isInteger(n) ? question.options[n - 1] : undefined;
    if (!option) throw new UsageError(`--option must be 1 to ${question.options.length}`);
    return option.label;
  }
  return flags['--text-stdin'] ? readFileSync(STDIN_FD, 'utf8').trim() : words.join(' ');
}

function answer(flags, [id, ...words]) {
  const real = queueFile(flags);
  if (!id) throw new UsageError('usage: answer --queue <path> <id> [--default] (--option <n> | --text-stdin | <text>)');
  const outcome = withLock(real, () => {
    const records = readQueue(real);
    const question = questionFor(records, id);
    const existing = answerFor(records, id);
    if (existing !== null && flags['--force'] !== true) return { existing };
    const text = answerText(flags, question, words);
    if (!text) throw new UsageError('the answer is empty');
    if (text.length > MAX_ANSWER_CHARS) throw new UsageError(`answer is longer than ${MAX_ANSWER_CHARS} chars`);
    appendRecord(real, { type: 'a', id, answer: text, ...(flags['--default'] === true ? { by: BY_TIMEOUT } : {}) });
    return {};
  });
  if (outcome.existing !== undefined) {
    console.log(sanitize(outcome.existing));
    throw new UsageError(`${id} is already answered (the answer above is the existing one; if you did not write it, ask the owner and use --force)`);
  }
}

function get(flags, [id]) {
  const records = readQueue(queueFile(flags));
  questionFor(records, id);
  const text = answerFor(records, id);
  if (text === null) {
    console.log('open');
    process.exit(EXIT_OPEN);
  }
  console.log(sanitize(text));
}

function show(flags, [id]) {
  const records = readQueue(queueFile(flags));
  console.log(formatShow(questionFor(records, id), answerFor(records, id)));
}

function list(flags) {
  const records = readQueue(queueFile(flags));
  const open = new Set(openQuestions(records).map((q) => q.id));
  for (const q of records.filter((r) => r.type === 'q')) {
    if (!flags['--open'] || open.has(q.id)) console.log(formatLine(q, !open.has(q.id)));
  }
}

// What `watch` knows: the byte offset read so far, whether it is inside a dropped over-long line, the ids seen, the ids
// that have an answer line (in any order, so an answer written before its question is noticed) and whether this is the
// first pass.
const newWatchState = () => ({ offset: 0, discarding: false, asked: new Set(), answered: new Set(), initial: true });

// Folds one line into the state; returns the question record when it is a question not seen before.
function handleLine(state, line) {
  const rec = parseLine(line);
  if (!rec) return null;
  if (rec.type === 'a') {
    state.answered.add(rec.id);
    return null;
  }
  if (state.asked.has(rec.id)) return null;
  state.asked.add(rec.id);
  return { rec, early: state.answered.has(rec.id) };
}

// Reads every new complete line once and prints every new question line, flagged " (already answered)" when an answer line
// exists. The first pass skips questions answered in the normal order (question, then answer), so re-arming the watch is quiet.
function pump(real, state) {
  const fresh = [];
  for (let eof = false; !eof; ) {
    const chunk = readNew(real, state.offset, state.discarding);
    if (chunk.reset) Object.assign(state, newWatchState());
    if (chunk.skipped) process.stderr.write('ask: skipped an over-long line\n');
    Object.assign(state, { offset: chunk.offset, discarding: chunk.discarding });
    for (const line of chunk.lines) fresh.push(handleLine(state, line));
    eof = chunk.eof;
  }
  for (const item of fresh.filter(Boolean)) {
    const answered = state.answered.has(item.rec.id);
    if (!state.initial || !answered || item.early) process.stdout.write(`${formatWatchLine(item.rec, answered)}\n`);
  }
  state.initial = false;
}

// Polls the file, never exits. A failed read is one stderr line, then watching goes on.
async function watch(flags) {
  const real = queueFile(flags);
  const interval = Number(flags['--interval-ms'] ?? DEFAULT_INTERVAL_MS);
  if (!Number.isFinite(interval) || interval <= 0) throw new UsageError('--interval-ms must be a positive number');
  const state = newWatchState();
  for (;;) {
    try {
      pump(real, state);
    } catch (err) {
      process.stderr.write(`ask: watch read failed (${sanitize(err.message)}); still watching\n`);
    }
    await delay(interval);
  }
}

const COMMANDS = { init, post, answer, get, show, list, watch };

async function main() {
  const [name, ...rest] = process.argv.slice(2);
  try {
    if (!Object.hasOwn(COMMANDS, name)) throw new UsageError(`unknown command "${name ?? ''}"; use init|post|answer|get|show|list|watch`);
    const { flags, positional } = parseArgs(rest);
    await COMMANDS[name](flags, positional);
  } catch (err) {
    if (err instanceof UsageError) fail(err.message);
    throw err;
  }
}

await main();
