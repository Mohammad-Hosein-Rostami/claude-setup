// Follows one file the way `tail -n 0 -F` does, in Node only (no tail, stat or bash, so it runs on Windows, macOS and Linux).
// Exports: createTail(path, { fromStart, missingIsError, lookbackBytes }) -> { poll() -> { lines, history, mtimeMs, error }, finish() -> string[] }.
// Behaviour: the first poll of an existing file starts at its end (fromStart: false) or its first byte (true); a file that
// appears later is read from byte 0; a file that shrinks, or is replaced by another file (new inode or birth time, even a
// larger one), is re-read from byte 0; an incomplete last line is kept until its newline arrives (finish() returns it, for a
// one-shot read of a file with no final newline); multi-byte characters split across two reads are decoded whole.
// lookbackBytes (default 0): the first poll of an existing file that starts at its end also returns `history`, the complete lines
// among the last lookbackBytes before that end (a cut first line is dropped), so a watcher can learn the state it started in.
// Errors: a poll never throws. When the file cannot be read, `error` holds the reason (e.g. "EACCES") and mtimeMs is undefined
// (a file we cannot read is not proof of activity). A missing file is an error only if it was seen before or missingIsError.
// One read buffer per tail is allocated on first use and reused.
import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

const CHUNK_BYTES = 1 << 20;

/** One followed file; use createTail. */
class Tail {
  constructor(path, fromStart, missingIsError, lookbackBytes) {
    this.path = path;
    this.fromStart = fromStart;
    this.missingIsError = missingIsError;
    this.lookbackBytes = lookbackBytes;
    this.seen = false;
    this.reset();
  }

  reset() {
    this.decoder = new StringDecoder('utf8');
    this.pending = '';
  }

  async readNew(handle, size) {
    const lines = [];
    this.buffer ??= Buffer.alloc(CHUNK_BYTES);
    while (this.offset < size) {
      const { bytesRead } = await handle.read(this.buffer, 0, Math.min(CHUNK_BYTES, size - this.offset), this.offset);
      if (bytesRead === 0) break;
      this.offset += bytesRead;
      const parts = (this.pending + this.decoder.write(this.buffer.subarray(0, bytesRead))).split('\n');
      this.pending = parts.pop();
      lines.push(...parts.map((part) => part.replace(/\r$/, '')));
    }
    return lines;
  }

  // Where to read from, given what the file looks like now.
  anchor(info) {
    const identity = `${info.ino}:${info.birthtimeMs}`;
    const replaced = this.identity !== undefined && identity !== this.identity;
    this.identity = identity;
    if (this.offset === undefined) { // undefined until the file has been seen once
      this.offset = this.fromStart ? 0 : info.size;
      this.historyEnd = this.fromStart ? 0 : info.size;
    }
    else if (replaced || info.size < this.offset) { this.offset = 0; this.reset(); }
  }

  // The complete lines among the last lookbackBytes before `end`; only once, at the first look at a file that starts at its end.
  async readHistory(handle) {
    const end = this.historyEnd ?? 0;
    this.historyEnd = 0;
    const start = Math.max(0, end - this.lookbackBytes);
    if (end === 0 || this.lookbackBytes === 0) return [];
    const bytes = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
    const parts = bytes.toString('utf8', 0, bytesRead).split('\n');
    parts.pop(); // after the last newline: not a complete line
    if (start > 0) parts.shift(); // the window began inside a line
    return parts.map((part) => part.replace(/\r$/, ''));
  }

  async poll() {
    let info;
    try { info = await stat(this.path); } catch (error) {
      this.offset ??= 0; // not there yet: whatever it later holds is new
      const missing = error.code === 'ENOENT';
      return { lines: [], history: [], mtimeMs: undefined, error: missing && !this.seen && !this.missingIsError ? undefined : error.code ?? 'ERROR' };
    }
    this.anchor(info);
    let handle;
    try {
      handle = await open(this.path, 'r');
      const history = await this.readHistory(handle);
      const lines = await this.readNew(handle, info.size);
      this.seen = true;
      return { lines, history, mtimeMs: info.mtimeMs, error: undefined };
    } catch (error) {
      return { lines: [], history: [], mtimeMs: undefined, error: error.code ?? 'ERROR' };
    } finally {
      await handle?.close();
    }
  }

  finish() {
    const rest = this.pending + this.decoder.end();
    this.pending = '';
    return rest === '' ? [] : [rest];
  }
}

/**
 * @param {string} path file to follow
 * @param {{ fromStart: boolean, missingIsError?: boolean, lookbackBytes?: number }} options where an already existing file starts;
 *   whether a file that does not exist (and was never seen) is reported as an error; how much of the old end to hand back as history
 * @returns {{ poll: () => Promise<{ lines: string[], history: string[], mtimeMs: number | undefined, error: string | undefined }>, finish: () => string[] }}
 */
export const createTail = (path, { fromStart, missingIsError = false, lookbackBytes = 0 }) => new Tail(path, fromStart, missingIsError, lookbackBytes);
