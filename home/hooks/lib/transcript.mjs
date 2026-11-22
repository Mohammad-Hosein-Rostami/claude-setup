// Read-only helpers over the session transcript (JSONL at `transcript_path` in hook input).
// Exports: contextTokens(path), findStatusPath(path), lastReplyRouting(path, { sidechain }), STATUS_FILE_PATTERN.
// Invariants: never throws (a missing or odd file gives undefined, or {} for lastReplyRouting, and one stderr line only for unexpected errors);
// subagent (sidechain) lines never count, except where a reader is asked for them (a subagent's own transcript holds only sidechain
// lines); reads only the tail for the context size and the last reply's model, and skips files over the size cap.
import { open, readFile, stat } from 'node:fs/promises';

const TAIL_BYTES = 512 * 1024; // one assistant line with usage is far smaller; the tail always holds the latest
const MAX_SCAN_BYTES = 200 * 1024 * 1024; // above this the full scan would not fit the 5 s hook timeout
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit'];
export const STATUS_FILE_PATTERN = /(^|[\\/])STATUS[\w.-]*\.md$/i;
const PLAIN_MODEL_ID = /^[\w.:[\]-]+$/; // `<synthetic>` (a reply Claude Code made up, no model ran) does not match

function report(what, error) {
  if (error.code !== 'ENOENT') process.stderr.write(`transcript: cannot ${what}: ${error.message}\n`);
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined; // a cut first line of a tail read, or a partial last line
  }
}

/**
 * Size of the context the last main-thread assistant message was sent with (input + cache read + cache creation).
 * @param {string | undefined} transcriptPath - `transcript_path` from the hook input.
 * @returns {Promise<number | undefined>} tokens, or undefined when the transcript has no assistant usage yet.
 */
export async function contextTokens(transcriptPath) {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return undefined;
  let handle;
  try {
    handle = await open(transcriptPath, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!lines[index].includes('"usage"')) continue;
      const entry = parseLine(lines[index]);
      const usage = entry?.type === 'assistant' && !entry.isSidechain ? entry.message?.usage : undefined;
      if (usage) return (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    }
  } catch (error) {
    report('read context size', error);
  } finally {
    await handle?.close();
  }
  return undefined;
}

/**
 * The status file the session last wrote or edited (a path whose name matches STATUS*.md), newest write wins.
 * @param {string | undefined} transcriptPath - `transcript_path` from the hook input.
 * @returns {Promise<string | undefined>} the path as it was written, or undefined when none was recorded.
 */
export async function findStatusPath(transcriptPath) {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return undefined;
  try {
    if ((await stat(transcriptPath)).size > MAX_SCAN_BYTES) return undefined;
    let found;
    for (const line of (await readFile(transcriptPath, 'utf8')).split('\n')) {
      if (!line.includes('STATUS') && !line.includes('status')) continue; // cheap filter before JSON.parse
      const entry = parseLine(line);
      if (entry?.type !== 'assistant' || entry.isSidechain || !Array.isArray(entry.message?.content)) continue;
      for (const block of entry.message.content) {
        const path = block?.type === 'tool_use' && WRITE_TOOLS.includes(block.name) ? block.input?.file_path : undefined;
        if (typeof path === 'string' && STATUS_FILE_PATTERN.test(path)) found = path;
      }
    }
    return found;
  } catch (error) {
    report('scan for the status file', error);
    return undefined;
  }
}

/**
 * The model and effort Claude Code recorded on the newest assistant reply of a transcript (its `message.model` and `effort` fields).
 * A reply whose model is not a plain id (Claude Code's `<synthetic>` replies) is passed over for the one before it.
 * @param {string | undefined} transcriptPath - `transcript_path` (the lead) or `agent_transcript_path` (a subagent) from the hook input.
 * @param {{ sidechain: boolean }} options - sidechain: read only subagent lines (true, a subagent's transcript) or only main-thread lines.
 * @returns {Promise<{ model?: string, effort?: string }>} the raw values as recorded, `{}` when the tail holds no such reply or the file
 *   cannot be read; the caller checks their shape before storing them.
 */
export async function lastReplyRouting(transcriptPath, { sidechain }) {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return {};
  let handle;
  try {
    handle = await open(transcriptPath, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!lines[index].includes('"model"')) continue;
      const entry = parseLine(lines[index]);
      const model = entry?.type === 'assistant' && Boolean(entry.isSidechain) === sidechain ? entry.message?.model : undefined;
      if (typeof model === 'string' && PLAIN_MODEL_ID.test(model)) return { model, ...(typeof entry.effort === 'string' ? { effort: entry.effort } : {}) };
    }
  } catch (error) {
    report('read the last reply model', error);
  } finally {
    await handle?.close();
  }
  return {};
}
