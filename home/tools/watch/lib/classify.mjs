// Turns one transcript JSONL line into verbose events, in the line format of the old live-watch.sh jq filter.
// Exports: createClassifier() -> { feed(text) -> Event[], seed(text, sinceMs) -> Event[], assistantEntries, turnEndedAt, resetTurn() }, endsInFinishedReply(text), Event = { kind, line, owner?, promptText? }.
// Kinds: PROMPT, COMPACT, AGENT, SKILL, TOOL, USAGE, ERR, INPUT_MODE, API_ERROR, LIMIT, LIMIT_RESET.
// A Workflow tool_use (only in transcripts from before the setup turned that tool off) is a plain TOOL event.
// API_ERROR / LIMIT: an entry with isApiErrorMessage true. Only its error class is printed (rate_limit is a LIMIT, anything else
// an API_ERROR), never the message text. LIMIT_RESET: the first real assistant reply after a LIMIT, with the minutes it lasted.
// Sidechain entries (a subagent's own turns) are not the session's: their API errors are no event and their replies do not end a limit window.
// seed(text, sinceMs) reads a line of the tail of a file the watcher starts on: an older line only teaches whether a limit window is open
// (no event), a line stamped after sinceMs (written between the watcher's start and its first look) is classified like a fed one.
// assistantEntries counts the session's own replies (not API errors, not sidechain): `--delay-sec` reads it to see the session recover.
// turnEndedAt: when the session's last turn finished (epoch ms), or undefined while a turn may be running. The newest main-chain entry that
// counts decides: a `system` turn_duration, or an assistant message whose stop_reason is end_turn or stop_sequence, finishes the turn; any
// other user or assistant entry (a prompt, a tool result, a task notification, a tool_use, an API error entry, an unknown stop_reason) means
// it is running, and so does a meta user entry that carries any origin kind (a peer message, an auto-continuation, a kind not known yet).
// Sidechain and compaction-summary entries, other meta entries, other system subtypes, attachments and unparseable lines do not count.
// Local commands (the owner types a slash command that Claude Code answers itself, no model turn): a `<local-command-stdout>` or `-stderr`
// user entry never clears the turn end; a `<command-name>` entry does (a skill starts a model turn), but when the next counting entry is
// that local output the earlier turn end is restored. A `<command-name>` with nothing after it, or followed by anything else, stays running. A
// finishing entry without a valid timestamp is not trusted (undefined). seed() tracks it too, so a watch started on an idle file knows.
// resetTurn() forgets it (the file was truncated or replaced). endsInFinishedReply(text) is the same test for the last line of a subagent transcript.
// Invariants: pure apart from the INPUT_MODE and limit-window memory (Claude Code repeats the mode every turn; only changes are events);
// a line that is not valid JSON, or is not an object, yields nothing (a partial line is the tail's job, not ours).
// A PROMPT event always carries a verbose line, but `owner` is false for meta, sidechain and compaction-summary entries.
// A user entry whose content is an array is a prompt when it has text (or image) parts and no tool_result part: the text parts
// that do not start with "<" are joined and `[+N images]` is appended (the old bash filter ignored these; deliberate improvement).

const PROMPT_CHARS = 200;
const ERROR_CHARS = 160;
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const ERROR_CLASS = /^[A-Za-z0-9_.-]{1,40}$/;
const LIMIT_ERROR_CLASS = 'rate_limit';
const MS_PER_MINUTE = 60_000;
const TURN_END_STOP_REASONS = new Set(['end_turn', 'stop_sequence']);
const LOCAL_COMMAND_OUTPUT = /^\s*<local-command-(?:stdout|stderr)>/;
const LOCAL_COMMAND_NAME = /^\s*<command-name>/;

// jq `//`: null, undefined and false fall back to the default.
const orElse = (value, fallback) => (value === null || value === undefined || value === false ? fallback : value);
// jq string interpolation prints null for a missing value.
const show = (value) => (value === null || value === undefined ? 'null' : String(value));
// jq slices strings by code point, not by UTF-16 unit.
const head = (text, count) => Array.from(text).slice(0, count).join('');
const flat = (text) => text.replaceAll('\n', ' ');

const parse = (text) => {
  try { const entry = JSON.parse(text); return entry !== null && typeof entry === 'object' ? entry : undefined; } catch { return undefined; }
};
const finishesTurn = (entry) => entry.type === 'assistant' && entry.isApiErrorMessage !== true && TURN_END_STOP_REASONS.has(entry.message?.stop_reason);

// The text of a user entry's content: the string, or the text of an array that holds one text block; otherwise undefined.
function singleText(entry) {
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  const only = Array.isArray(content) && content.length === 1 ? content[0] : undefined;
  return only?.type === 'text' && typeof only.text === 'string' ? only.text : undefined;
}

/** @param {string} text one JSONL line @returns {boolean} true for an assistant reply that ends its turn (end_turn or stop_sequence, not an API error) */
export const endsInFinishedReply = (text) => {
  const entry = parse(text);
  return entry !== undefined && finishesTurn(entry);
};

function promptEvent(entry, stamp, text) {
  const owner = !(entry.isMeta || entry.isSidechain || entry.isCompactSummary);
  return { kind: 'PROMPT', line: `${stamp} PROMPT ${text}`, owner, promptText: text };
}

// Text of a content array: plain text parts joined by a space (parts that start with "<" are harness notices), then an image note.
function arrayPromptText(blocks) {
  const texts = blocks.filter((block) => block?.type === 'text' && typeof block.text === 'string' && !block.text.startsWith('<')).map((block) => block.text);
  const images = blocks.filter((block) => block?.type === 'image').length;
  const text = flat(head(texts.join(' '), PROMPT_CHARS));
  if (images === 0) return text;
  return text === '' ? `[+${images} images]` : `${text} [+${images} images]`;
}

function toolEvent(block, stamp) {
  const input = block.input ?? {};
  if (AGENT_TOOLS.has(block.name)) {
    const agentType = orElse(input.subagent_type, 'general-purpose');
    const description = orElse(input.description, '');
    return { kind: 'AGENT', line: `${stamp} AGENT type=${agentType} model=${orElse(input.model, '-')} effort=${orElse(input.effort, '-')} bg=${orElse(input.run_in_background, false)} desc=${description}` };
  }
  if (block.name === 'Skill') return { kind: 'SKILL', line: `${stamp} SKILL ${show(input.skill)}` };
  return { kind: 'TOOL', line: `${stamp} TOOL ${block.name}` };
}

function usageEvent(message, stamp) {
  const usage = message.usage;
  const context = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  return { kind: 'USAGE', line: `${stamp} USAGE model=${show(message.model)} ctx=${context} create=${show(usage.cache_creation_input_tokens)} out=${show(usage.output_tokens)}` };
}

function assistantEvents(entry, stamp) {
  const message = entry.message ?? {};
  const blocks = Array.isArray(message.content) ? message.content : [];
  const events = blocks.filter((block) => block?.type === 'tool_use').map((block) => toolEvent(block, stamp));
  if (message.usage) events.push(usageEvent(message, stamp));
  return events;
}

function errorEvents(entry, stamp) {
  return entry.message.content
    .filter((block) => block?.type === 'tool_result' && block.is_error === true)
    .map((block) => {
      const body = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? null);
      return { kind: 'ERR', line: `${stamp} ERR ${flat(head(body, ERROR_CHARS))}` };
    });
}

// The class of an API error entry, or "unknown" when it is missing or not a short plain word (so no free text gets through).
const apiErrorClass = (entry) => (typeof entry.error === 'string' && ERROR_CLASS.test(entry.error) ? entry.error : 'unknown');

function userEvents(entry, stamp) {
  const content = entry.message?.content;
  if (typeof content === 'string') return content.startsWith('<') ? [] : [promptEvent(entry, stamp, flat(head(content, PROMPT_CHARS)))];
  if (!Array.isArray(content)) return [];
  if (content.some((block) => block?.type === 'tool_result')) return errorEvents(entry, stamp);
  const text = arrayPromptText(content);
  return text === '' ? [] : [promptEvent(entry, stamp, text)];
}

/**
 * @returns {{ feed: (text: string) => object[] }} a classifier with its own INPUT_MODE memory (one per watched session)
 */
export function createClassifier() {
  let lastMode;
  let limitStartedAt; // timestamp of the first LIMIT of the current limit window
  let assistantEntries = 0;
  let turnEndedAt;
  let turnEndBeforeCommand; // the turn end as it was when a `<command-name>` entry came, until the next counting entry
  const trackUserTurn = (entry) => {
    const text = entry.isMeta === true ? undefined : singleText(entry);
    if (text !== undefined && LOCAL_COMMAND_OUTPUT.test(text)) {
      if (turnEndBeforeCommand !== undefined) turnEndedAt = turnEndBeforeCommand;
      turnEndBeforeCommand = undefined;
      return;
    }
    turnEndBeforeCommand = text !== undefined && LOCAL_COMMAND_NAME.test(text) ? turnEndedAt : undefined;
    turnEndedAt = undefined;
  };
  const trackTurn = (entry) => {
    if (entry.isSidechain === true || entry.isCompactSummary === true) return;
    if (entry.isMeta === true && !(entry.type === 'user' && entry.origin?.kind != null)) return;
    const endedAt = Date.parse(entry.timestamp);
    const stamped = Number.isFinite(endedAt) ? endedAt : undefined;
    if (entry.type === 'user') { trackUserTurn(entry); return; }
    const isTurnDuration = entry.type === 'system' && entry.subtype === 'turn_duration';
    if (!isTurnDuration && entry.type !== 'assistant') return;
    turnEndBeforeCommand = undefined;
    turnEndedAt = isTurnDuration || finishesTurn(entry) ? stamped : undefined;
  };
  const minutesSince = (stamp) => {
    const minutes = Math.floor((Date.parse(stamp) - Date.parse(limitStartedAt)) / MS_PER_MINUTE);
    return Number.isFinite(minutes) ? ` after ${minutes} min` : '';
  };
  const apiErrorEvent = (entry, stamp) => {
    const errorClass = apiErrorClass(entry);
    if (errorClass !== LIMIT_ERROR_CLASS) return { kind: 'API_ERROR', line: `${stamp} API_ERROR ${errorClass}` };
    limitStartedAt ??= stamp;
    return { kind: 'LIMIT', line: `${stamp} LIMIT ${errorClass}` };
  };
  const limitResetEvents = (stamp) => {
    const line = `${stamp} LIMIT_RESET resumed${minutesSince(stamp)}`;
    limitStartedAt = undefined;
    return [{ kind: 'LIMIT_RESET', line }];
  };
  const classify = (entry) => {
    const stamp = orElse(entry.timestamp, '');
    if (entry.isApiErrorMessage === true) return entry.isSidechain === true ? [] : [apiErrorEvent(entry, stamp)];
    if (entry.type === 'assistant' && entry.isSidechain !== true) {
      assistantEntries += 1;
      if (limitStartedAt !== undefined) return [...limitResetEvents(stamp), ...assistantEvents(entry, stamp)];
    }
    if (entry.type === 'user') return userEvents(entry, stamp);
    if (entry.type === 'assistant') return assistantEvents(entry, stamp);
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      const meta = entry.compactMetadata ?? {};
      return [{ kind: 'COMPACT', line: `${stamp} COMPACT ${show(meta.trigger)} ${show(meta.preTokens)}->${show(meta.postTokens)}` }];
    }
    if (entry.type === 'mode') {
      if (entry.mode === lastMode) return [];
      lastMode = entry.mode;
      return [{ kind: 'INPUT_MODE', line: `${stamp} INPUT_MODE ${show(entry.mode)}` }];
    }
    return [];
  };
  return {
    get assistantEntries() { return assistantEntries; },
    get turnEndedAt() { return turnEndedAt; },
    resetTurn() { turnEndedAt = undefined; turnEndBeforeCommand = undefined; },
    feed(text) {
      const entry = parse(text);
      if (entry === undefined) return [];
      trackTurn(entry);
      return classify(entry);
    },
    seed(text, sinceMs) {
      const entry = parse(text);
      if (entry === undefined) return [];
      trackTurn(entry);
      if (Date.parse(entry.timestamp) > sinceMs) return classify(entry);
      if (entry.isSidechain === true) return [];
      if (entry.isApiErrorMessage !== true && entry.type === 'assistant') limitStartedAt = undefined;
      else if (entry.isApiErrorMessage === true && apiErrorClass(entry) === LIMIT_ERROR_CLASS) limitStartedAt ??= orElse(entry.timestamp, '');
      return [];
    },
  };
}
