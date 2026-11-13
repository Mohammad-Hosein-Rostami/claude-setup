// Purpose: read a byte range of a Claude Code transcript (JSONL) as messages for summarising, with absolute line numbers.
// Exports: readSlice.
// Invariants: only complete lines are read (a range that starts mid-line skips to the next line, a range that ends
// mid-line stops before it, so a half-written last line is picked up next time); text is normalised and redacted
// before it can reach any model; harness text, shell captures and meta lines are dropped exactly as the indexer does;
// the returned `endOffset` is the first byte not consumed.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { hasBashCapture, isHarnessText, normalize, redact } from './extract.mjs';

const READ_BLOCK = 1 << 20;

const blockTexts = (content) => {
  if (typeof content === 'string') return [content];
  return Array.isArray(content) ? content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text) : [];
};

function countNewlines(fd, end) {
  const buffer = Buffer.allocUnsafe(READ_BLOCK);
  let count = 0;
  for (let pos = 0; pos < end;) {
    const n = readSync(fd, buffer, 0, Math.min(READ_BLOCK, end - pos), pos);
    if (n <= 0) break;
    for (let i = 0; i < n; i += 1) if (buffer[i] === 0x0a) count += 1;
    pos += n;
  }
  return count;
}

function messageOf(entry, line, seen) {
  if (entry.type === 'user') {
    const text = blockTexts(entry.message?.content).join('\n\n');
    if (!text.trim()) return [];
    if (entry.isCompactSummary === true) return [{ line, ts: entry.timestamp ?? null, role: 'S', text: redact(normalize(text)) }];
    if (isHarnessText(text) || hasBashCapture(text) || entry.isMeta === true) return [];
    return [{ line, ts: entry.timestamp ?? null, role: 'U', text: redact(normalize(text)) }];
  }
  if (entry.type !== 'assistant') return [];
  const id = entry.message?.id ?? `line${line}`;
  const out = [];
  blockTexts(entry.message?.content).forEach((text, index) => {
    const key = `${id}:${index}:${text.length}:${text.slice(0, 50)}`;
    if (!text.trim() || seen.has(key)) return;
    seen.add(key);
    out.push({ line, ts: entry.timestamp ?? null, role: 'A', text: redact(normalize(text)) });
  });
  return out;
}

/**
 * Messages of `path` from byte `fromOffset` to `toOffset` (default: the end).
 * @returns {{messages: {line: number, ts: string | null, role: 'U'|'A'|'S', text: string}[], startLine: number,
 *   endLine: number, endOffset: number}} `startLine`/`endLine` are 1-based transcript lines of the consumed range.
 */
export function readSlice(path, fromOffset = 0, toOffset = Infinity) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const end = Math.min(toOffset, size);
    let start = fromOffset;
    if (start > 0) { // align to a line start: the byte before must be a newline
      const one = Buffer.alloc(1);
      readSync(fd, one, 0, 1, start - 1);
      if (one[0] !== 0x0a) {
        const probe = Buffer.allocUnsafe(Math.min(READ_BLOCK, Math.max(0, end - start)));
        const n = readSync(fd, probe, 0, probe.length, start);
        const at = probe.subarray(0, n).indexOf(0x0a);
        start = at === -1 ? end : start + at + 1;
      }
    }
    const buffer = Buffer.allocUnsafe(Math.max(0, end - start));
    const got = buffer.length ? readSync(fd, buffer, 0, buffer.length, start) : 0;
    const text = buffer.subarray(0, got);
    const lastNewline = text.lastIndexOf(0x0a);
    const used = text.subarray(0, lastNewline + 1);
    const startLine = countNewlines(fd, start) + 1;
    const seen = new Set();
    const messages = [];
    used.toString('utf8').split('\n').slice(0, -1).forEach((raw, i) => {
      let entry;
      try { entry = JSON.parse(raw); } catch { return; }
      if (entry && typeof entry === 'object') messages.push(...messageOf(entry, startLine + i, seen));
    });
    return { messages, startLine, endLine: startLine + used.toString('utf8').split('\n').length - 2, endOffset: start + used.length };
  } finally {
    closeSync(fd);
  }
}
