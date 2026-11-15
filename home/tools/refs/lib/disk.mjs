// Purpose: answer "does this path exist" the way a case-sensitive file system (Linux CI) would, and list folders, with
//   a cache. macOS and Windows hide case-only mistakes; here every segment below the scanned root must match a real
//   directory entry exactly.
// Exports: Disk.
// Invariants: reads folder listings and file contents only through this class; never writes. A path outside the scanned
//   root is checked with a plain stat (its case cannot be judged from here).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const nfc = (name) => name.normalize('NFC'); // macOS stores names decomposed; compare composed

/** Cached, case-exact view of the files under one scanned root. */
export class Disk {
  constructor(root) {
    this.root = resolve(root);
    this.names = new Map(); // folder -> Set of entry names
    this.listings = new Map(); // folder -> [{name, isDir}]
  }

  /** Entries of a folder with a flag for folders (a symlink to a folder counts); empty when it cannot be read. */
  entries(folder) {
    if (!this.listings.has(folder)) {
      let list = [];
      try {
        list = readdirSync(folder, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          isDir: entry.isDirectory() || (entry.isSymbolicLink() && statSync(join(folder, entry.name), { throwIfNoEntry: false })?.isDirectory() === true),
        }));
      } catch {
        // unreadable or vanished folder: nothing in it exists as far as a reference is concerned
      }
      this.listings.set(folder, list);
    }
    return this.listings.get(folder);
  }

  hasEntry(folder, name) {
    if (!this.names.has(folder)) this.names.set(folder, new Set(this.entries(folder).map((entry) => nfc(entry.name))));
    return this.names.get(folder).has(nfc(name));
  }

  /** True when the path exists; below the root every segment must match a directory entry exactly (case-sensitive). */
  exists(path) {
    const target = resolve(path);
    try {
      if (statSync(target, { throwIfNoEntry: false }) === undefined) return false;
    } catch {
      return false; // ENOTDIR (a file used as a folder), invalid characters, permissions
    }
    const inside = relative(this.root, target);
    if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return true;
    let folder = this.root;
    for (const segment of inside.split(sep)) {
      if (!this.hasEntry(folder, segment)) return false;
      folder = join(folder, segment);
    }
    return true;
  }

  /** The text of a file below the root. Throws when it is missing, unreadable or larger than MAX_FILE_BYTES. */
  readText(path) {
    if (statSync(path).size > MAX_FILE_BYTES) throw new Error(`file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MiB`);
    return readFileSync(path, 'utf8');
  }
}
