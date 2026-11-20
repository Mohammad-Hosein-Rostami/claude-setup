// Purpose: write git objects into one pack file, undeltified, for review-tier's import into its own repository.
// Exports: MAX_OBJECT_BYTES, entryHeader(type, size), openPack(file, count) -> { add(type, content), finish() -> { trailer, sha256 }, close() }.
// Why a pack: one file and one `git index-pack` per import phase. Loose objects are one file each (47 s for 70,000 objects in the spec
//   check's measurement), and `git hash-object` is a process per object. `git index-pack` names every object from its content with git's
//   own collision-detecting SHA-1, so a name never comes from here.
// Invariants: format is pack version 2 (gitformat-pack): `PACK`, version, object count, then per object a type-and-size header and the
//   zlib stream of its content, then the SHA-1 of everything before it. Sizes are written with arithmetic, never 32-bit shifts (they wrap
//   at 2^31). `count` objects must be added before finish(); the file is the caller's to close and to remove. Beside the SHA-1 trailer
//   (which `git index-pack --stdin` prints as the pack's name) the writer keeps a SHA-256 of every byte it wrote, trailer included:
//   index-pack stores exactly those bytes, so the tool can later tell its own pack from another one under the same name (lib/temp-repository.mjs).
import { createHash } from 'node:crypto';
import { closeSync, openSync, writeSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

/** The largest object the import takes (1 GiB): each one is held in memory once to be hashed and compressed. A larger one stops the run. */
export const MAX_OBJECT_BYTES = 2 ** 30;
const PACK_SIGNATURE = 'PACK';
const PACK_VERSION = 2;
const PACK_HEADER_BYTES = 12;
const TYPE_CODES = { commit: 1, tree: 2, blob: 3 };
const FIRST_SIZE_BASE = 16; // the first header byte holds the low 4 bits of the size, after the type
const NEXT_SIZE_BASE = 128; // each later byte holds 7 more bits
const MORE_BYTES = 0x80; // set on every header byte but the last
const TYPE_SHIFT = 4;
const FAST_COMPRESSION = 1; // the pack lives for one run: speed over size

/**
 * The header of one undeltified pack entry.
 * @param {'commit' | 'tree' | 'blob'} type
 * @param {number} size the content's length in bytes, a non-negative integer
 * @returns {Buffer}
 * @throws {Error} for another type
 */
export function entryHeader(type, size) {
  if (!Object.hasOwn(TYPE_CODES, type)) throw new Error(`cannot pack an object of type ${JSON.stringify(type)}`);
  const bytes = [(TYPE_CODES[type] << TYPE_SHIFT) + (size % FIRST_SIZE_BASE)];
  for (let rest = Math.floor(size / FIRST_SIZE_BASE); rest > 0; rest = Math.floor(rest / NEXT_SIZE_BASE)) {
    bytes[bytes.length - 1] += MORE_BYTES;
    bytes.push(rest % NEXT_SIZE_BASE);
  }
  return Buffer.from(bytes);
}

/**
 * Starts a pack file of `count` objects.
 * @param {string} file the path to create (it must not exist)
 * @param {number} count how many objects will be added
 * @returns {{add: (type: string, content: Buffer) => void, finish: () => {trailer: string, sha256: string}, close: () => void}}
 *   `finish()` writes the trailer and returns it (hex) with the SHA-256 (hex) of the whole file; `close()` closes the file, also after a
 *   failure (calling it twice is fine)
 * @throws {Error} from finish() when another number of objects was added, and from the file system
 */
export function openPack(file, count) {
  const descriptor = openSync(file, 'wx', 0o600);
  const digest = createHash('sha1');
  const whole = createHash('sha256');
  let added = 0;
  let open = true;
  const write = (bytes) => {
    digest.update(bytes);
    whole.update(bytes);
    writeSync(descriptor, bytes);
  };
  const header = Buffer.alloc(PACK_HEADER_BYTES);
  header.write(PACK_SIGNATURE, 'latin1');
  header.writeUInt32BE(PACK_VERSION, PACK_SIGNATURE.length);
  header.writeUInt32BE(count, PACK_HEADER_BYTES - 4);
  write(header);
  return {
    add(type, content) {
      write(entryHeader(type, content.length));
      write(deflateSync(content, { level: FAST_COMPRESSION }));
      added += 1;
    },
    finish() {
      if (added !== count) throw new Error(`the import pack holds ${added} objects, ${count} were announced`);
      const trailer = digest.digest();
      writeSync(descriptor, trailer);
      return { trailer: trailer.toString('hex'), sha256: whole.update(trailer).digest('hex') };
    },
    close() {
      if (open) closeSync(descriptor);
      open = false;
    },
  };
}
