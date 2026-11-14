// Follows one file the way `tail -n 0 -F` does, in Node only (no tail, stat or bash, so it runs on Windows, macOS and Linux).
// Exports: createTail(path, { fromStart }) -> { poll() -> { lines, mtimeMs }, finish() -> string[] }.
// Behaviour: the first poll of an existing file starts at its end (fromStart: false) or its first byte (true); a file that
// appears later is read from byte 0; a file that shrinks is re-read from byte 0; an incomplete last line is kept until its
// newline arrives (finish() returns it, for a one-shot read of a file with no final newline); multi-byte characters split
// across two reads are decoded whole. Never throws on a missing or unreadable file: the poll returns no lines and no mtime.
import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

const CHUNK_BYTES = 1 << 20;

/** One followed file; use createTail. */
class Tail {
  constructor(path, fromStart) {
    this.path = path;
    this.fromStart = fromStart;
    this.reset();
  }

  reset() {
    this.decoder = new StringDecoder('utf8');
    this.pending = '';
  }

  async readNew(handle, size) {
    const lines = [];
    const buffer = Buffer.alloc(CHUNK_BYTES);
    while (this.offset < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK_BYTES, size - this.offset), this.offset);
      if (bytesRead === 0) break;
      this.offset += bytesRead;
      const parts = (this.pending + this.decoder.write(buffer.subarray(0, bytesRead))).split('\n');
      this.pending = parts.pop();
      lines.push(...parts.map((part) => part.replace(/\r$/, '')));
    }
    return lines;
  }

  async poll() {
    let info;
    try { info = await stat(this.path); } catch {
      this.offset ??= 0; // not there yet: whatever it later holds is new
      return { lines: [], mtimeMs: undefined };
    }
    this.offset ??= this.fromStart ? 0 : info.size; // undefined until the file has been seen once
    if (info.size < this.offset) { this.offset = 0; this.reset(); }
    let handle;
    try {
      handle = await open(this.path, 'r');
      return { lines: await this.readNew(handle, info.size), mtimeMs: info.mtimeMs };
    } catch {
      return { lines: [], mtimeMs: info.mtimeMs };
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
 * @param {{ fromStart: boolean }} options where an already existing file starts
 * @returns {{ poll: () => Promise<{ lines: string[], mtimeMs: number | undefined }>, finish: () => string[] }}
 */
export const createTail = (path, { fromStart }) => new Tail(path, fromStart);
