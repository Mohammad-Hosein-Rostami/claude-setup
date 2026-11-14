// Turns one transcript JSONL line into verbose events, in the line format of the old live-watch.sh jq filter.
// Exports: createClassifier() -> { feed(text) -> Event[] }, Event = { kind, line, owner?, promptText? }.
// Kinds: PROMPT, COMPACT, AGENT, WORKFLOW, SKILL, TOOL, USAGE, ERR, INPUT_MODE.
// Invariants: pure apart from the INPUT_MODE memory (Claude Code repeats the mode every turn; only changes are events);
// a line that is not valid JSON, or is not an object, yields nothing (a partial line is the tail's job, not ours).
// A PROMPT event always carries a verbose line, but `owner` is false for meta, sidechain and compaction-summary entries.
// A user entry whose content is an array is a prompt when it has text (or image) parts and no tool_result part: the text parts
// that do not start with "<" are joined and `[+N images]` is appended (the old bash filter ignored these; deliberate improvement).

const PROMPT_CHARS = 200;
const ERROR_CHARS = 160;
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const AGENT_CALL = /agent\(/g;

// jq `//`: null, undefined and false fall back to the default.
const orElse = (value, fallback) => (value === null || value === undefined || value === false ? fallback : value);
// jq string interpolation prints null for a missing value.
const show = (value) => (value === null || value === undefined ? 'null' : String(value));
// jq slices strings by code point, not by UTF-16 unit.
const head = (text, count) => Array.from(text).slice(0, count).join('');
const flat = (text) => text.replaceAll('\n', ' ');

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
  if (block.name === 'Workflow') {
    const script = typeof input.script === 'string' ? input.script : '';
    const agents = (script.match(AGENT_CALL) ?? []).length;
    return { kind: 'WORKFLOW', line: `${stamp} WORKFLOW agents=${agents} script_chars=${Array.from(script).length} path=${orElse(input.scriptPath, '-')}` };
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
  const classify = (entry) => {
    const stamp = orElse(entry.timestamp, '');
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
    feed(text) {
      let entry;
      try { entry = JSON.parse(text); } catch { return []; }
      return entry !== null && typeof entry === 'object' ? classify(entry) : [];
    },
  };
}
