// Tests of the two small parts under review-tier's verified import (lane r7-delta, fix round 5): the pack writer (lib/pack-writer.mjs:
// git must read back exactly the bytes that went in, for every size) and the tool's own temp folder (lib/temp-repository.mjs: it holds
// only what this run put there (K7, N27), and the folders of killed runs are cleared after a day and only then (A2), only when their
// whole tree is what a run can leave, and by name, never recursively (fix 6, K5, K6, security N34)).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLEAN_ENV, git } from './git-tidy-helpers.mjs';
import { CLI, lane } from './review-tier-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { entryHeader, openPack } from '../home/tools/review-tier/lib/pack-writer.mjs';
import { TEMP_PREFIX, checkPackFiles, checkTempFolder, notePackFiles, removeByName, snapshotOf, staleFolderShape } from '../home/tools/review-tier/lib/temp-repository.mjs';

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const POSIX = process.platform !== 'win32'; // a symlink needs a privilege on Windows, and os.tmpdir() reads TEMP there
const oidOf = (type, content) => createHash('sha1').update(`${type} ${content.length}\0`).update(content).digest('hex');
/** A bare repository as the tool makes its own: no template, nothing but HEAD, config, objects/ and refs/. */
function bareRepository() {
  const folder = join(realpathSync(makeTempDir('review-tier-bare-')), 'repo');
  git(join(folder, '..'), 'init', '--quiet', '--bare', '--template=', folder);
  return folder;
}

/** The type code and the size a pack entry header holds, read the way git's unpack reads it (with BigInt, so no 32-bit step can hide). */
function decodeHeader(bytes) {
  let size = BigInt(bytes[0] & 0x0f);
  let shift = 4n;
  for (const byte of bytes.subarray(1)) {
    size += BigInt(byte & 0x7f) << shift;
    shift += 7n;
  }
  const lastOnly = [...bytes].every((byte, index) => (byte >= 0x80) === (index < bytes.length - 1));
  return { code: (bytes[0] >> 4) & 0x07, size, lastOnly };
}

test('the pack entry header holds the type and the exact size for every size, also at and above 2^31 and 2^32 where a 32-bit shift would wrap', () => {
  assert.deepEqual([...entryHeader('blob', 0)], [0x30]);
  assert.deepEqual([...entryHeader('blob', 15)], [0x3f]);
  assert.deepEqual([...entryHeader('tree', 16)], [0xa0, 0x01]);
  assert.deepEqual([...entryHeader('commit', 300)], [0x9c, 0x12]);
  const sizes = [0, 1, 15, 16, 17, 2047, 2048, 2 ** 31 - 1, 2 ** 31, 2 ** 31 + 1, 2 ** 32 - 1, 2 ** 32, 2 ** 32 + 5, 2 ** 40 + 123];
  for (const [type, code] of [['commit', 1], ['tree', 2], ['blob', 3]]) {
    for (const size of sizes) assert.deepEqual(decodeHeader(entryHeader(type, size)), { code, size: BigInt(size), lastOnly: true }, `${type} ${size}`);
  }
  for (const type of ['tag', 'ofs-delta', 'constructor', '']) assert.throws(() => entryHeader(type, 1), /cannot pack an object of type/);
});

test('git reads back from the import pack exactly the bytes that went in: an empty blob, a blob of every byte value, a tree and a commit', () => {
  const folder = bareRepository();
  const everyByte = Buffer.from(Array.from({ length: 70_000 }, (_, index) => index % 256));
  const blobs = [Buffer.alloc(0), everyByte, Buffer.from('plain\n')];
  const tree = Buffer.concat([Buffer.from('100644 a.bin\0'), Buffer.from(oidOf('blob', everyByte), 'hex')]);
  const commit = Buffer.from(`tree ${oidOf('tree', tree)}\nauthor t <t@t> 1 +0000\ncommitter t <t@t> 1 +0000\n\nfirst\n`);
  const objects = [...blobs.map((content) => ['blob', content]), ['tree', tree], ['commit', commit]];
  const file = join(folder, 'import.pack');
  const pack = openPack(file, objects.length);
  for (const [type, content] of objects) pack.add(type, content);
  pack.finish();
  pack.close();
  pack.close();
  const imported = spawnSync('git', ['index-pack', '--stdin', '--strict'], { cwd: folder, input: readFileSync(file), env: { ...CLEAN_ENV, GIT_DIR: folder } });
  assert.equal(imported.status, 0, imported.stderr.toString());
  for (const [type, content] of objects) {
    const read = spawnSync('git', ['cat-file', type, oidOf(type, content)], { cwd: folder, env: { ...CLEAN_ENV, GIT_DIR: folder } });
    assert.equal(read.status, 0, read.stderr.toString());
    assert.ok(read.stdout.equals(content), `${type} of ${content.length} bytes`);
  }
});

test('a pack with another number of objects than announced is an error, and the writer never writes over a file that is there', () => {
  const folder = makeTempDir('review-tier-pack-');
  const short = openPack(join(folder, 'short.pack'), 2);
  short.add('blob', Buffer.from('one'));
  assert.throws(() => short.finish(), /the import pack holds 1 objects, 2 were announced/);
  short.close();
  assert.throws(() => openPack(join(folder, 'short.pack'), 1), /EEXIST/);
});

test('spec check K7, security N27: the temp folder check passes on what init and a noted import wrote, and names anything else: an alternates file, a graft file, a ref, a loose object, a link, a pack nobody noted, a changed config', () => {
  const planted = [
    ['objects/info/alternates', (path) => writeFileSync(path, '/elsewhere/objects\n')],
    ['info', (path) => mkdirSync(path)],
    ['shallow', (path) => writeFileSync(path, 'x\n')],
    ['packed-refs', (path) => writeFileSync(path, '# pack-refs\n')],
    ['refs/heads/main', (path) => writeFileSync(path, `${'1'.repeat(40)}\n`)],
    ['refs/replace', (path) => mkdirSync(path)],
    ['objects/ab', (path) => mkdirSync(path)],
    ['objects/pack/pack-other.pack', (path) => writeFileSync(path, 'x')],
    ['objects/pack/pack-noted.keep', (path) => writeFileSync(path, 'x')],
    ['hooks', (path) => mkdirSync(path)],
    ['import.pack', (path) => writeFileSync(path, 'x')],
    ...(POSIX ? [['objects/info', (path) => { rmSync(path, { recursive: true }); symlinkSync(realpathSync(makeTempDir('review-tier-link-')), path); }]] : []),
  ];
  for (const [entry, plant] of planted) {
    const folder = bareRepository();
    const snapshot = snapshotOf(folder);
    for (const kind of ['pack', 'idx', 'rev']) writeFileSync(join(folder, 'objects', 'pack', `pack-noted.${kind}`), 'x');
    assert.doesNotThrow(() => checkTempFolder(folder, snapshot, ['pack-noted']), 'the control');
    assert.throws(() => checkTempFolder(folder, snapshot, []), /temp repository holds objects\/pack\/pack-noted\.(idx|pack|rev), which this run did not put there/);
    plant(join(folder, entry));
    assert.throws(() => checkTempFolder(folder, snapshot, ['pack-noted']), (error) => error.message.includes(`temp repository holds ${entry}, which this run did not put there`) && /cannot be trusted/.test(error.message), entry);
  }
  for (const [file, text] of [['config', '[core]\n\trepositoryformatversion = 0\n[extensions]\n\tpartialClone = x\n'], ['HEAD', `${'1'.repeat(40)}\n`]]) {
    const folder = bareRepository();
    const snapshot = snapshotOf(folder);
    writeFileSync(join(folder, file), text);
    assert.throws(() => checkTempFolder(folder, snapshot, []), new RegExp(`${file} of the tool's own temp repository changed during the run`));
  }
  const gutted = bareRepository();
  const snapshot = snapshotOf(gutted);
  rmSync(join(gutted, 'refs'), { recursive: true });
  assert.throws(() => checkTempFolder(gutted, snapshot, []), /lost a part of itself/);
  // review N6-2: a folder below the top that is gone is the same refusal (exit 2), not a raw ENOENT (exit 1)
  for (const inner of ['objects/info', 'objects/pack', 'refs/heads', 'refs/tags']) {
    const folder = bareRepository();
    const taken = snapshotOf(folder);
    rmSync(join(folder, inner), { recursive: true });
    assert.throws(() => checkTempFolder(folder, taken, []), (error) => /lost a part of itself/.test(error.message) && /cannot be trusted/.test(error.message), inner);
  }
});

test('spec check A2: a run clears the temp folders of killed runs that are older than a day and have no live owner, nothing else, and leaves none of its own', { skip: !POSIX && 'the temp folder is set with TMPDIR' }, () => {
  const { dir, log, write } = lane();
  write('src/run.mjs', 'export const run = () => 1;\n');
  const temp = realpathSync(makeTempDir('review-tier-tmpdir-'));
  const old = new Date(Date.now() - TWO_DAYS_MS);
  const folderOf = (name, { aged = true, pid = undefined } = {}) => {
    mkdirSync(join(temp, name));
    writeFileSync(join(temp, name, 'HEAD'), 'ref: refs/heads/main\n');
    if (pid !== undefined) writeFileSync(join(temp, `${name}.pid`), `${pid}\n`);
    if (aged) utimesSync(join(temp, name), old, old);
  };
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  folderOf(`${TEMP_PREFIX}aaaaaa`);
  folderOf(`${TEMP_PREFIX}bbbbbb`, { pid: deadPid });
  folderOf(`${TEMP_PREFIX}cccccc`, { pid: 'not a pid' });
  folderOf(`${TEMP_PREFIX}dddddd`, { pid: process.pid });
  folderOf(`${TEMP_PREFIX}eeeeee`, { aged: false });
  folderOf(`${TEMP_PREFIX}toolong`);
  folderOf('other-tool-aaaaaa');
  symlinkSync(join(temp, 'other-tool-aaaaaa'), join(temp, `${TEMP_PREFIX}ffffff`));
  writeFileSync(join(temp, `${TEMP_PREFIX}gggggg`), 'a file, not a folder\n');
  utimesSync(join(temp, `${TEMP_PREFIX}gggggg`), old, old);
  const kept = [`${TEMP_PREFIX}dddddd`, `${TEMP_PREFIX}dddddd.pid`, `${TEMP_PREFIX}eeeeee`, `${TEMP_PREFIX}ffffff`, `${TEMP_PREFIX}gggggg`, `${TEMP_PREFIX}toolong`, 'other-tool-aaaaaa'].sort();
  const result = spawnSync(process.execPath, [CLI, 'main...HEAD', '--json'], { cwd: dir, encoding: 'utf8', env: { ...CLEAN_ENV, REVIEW_TIER_LOG: log, TMPDIR: temp } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '', 'clearing old folders is silent when it works');
  assert.equal(JSON.parse(result.stdout).files, 1);
  assert.deepEqual(readdirSync(temp).sort(), kept, 'the run removed its own folder and pid file too');
});

/** Fills `folder` (made if missing) as `git init --bare --template=` does, plus `extra` files (relative path -> text). */
function filledFolder(folder, extra = {}) {
  for (const inner of ['objects/info', 'objects/pack', 'refs/heads', 'refs/tags']) mkdirSync(join(folder, inner), { recursive: true });
  for (const [file, text] of Object.entries({ HEAD: 'ref: refs/heads/main\n', config: '[core]\n\tbare = true\n', ...extra })) writeFileSync(join(folder, file), text);
  return folder;
}

test('spec check K5, K6 (fix 6), security N34: an old folder is cleared only when its whole tree is what a run can leave, and every other one is named once and left alone', { skip: !POSIX && 'the temp folder is set with TMPDIR' }, () => {
  const { dir, log, write } = lane();
  write('src/run.mjs', 'export const run = () => 1;\n');
  const temp = realpathSync(makeTempDir('review-tier-tmpdir-'));
  const victim = join(realpathSync(makeTempDir('review-tier-victim-')), 'keep.txt');
  writeFileSync(victim, 'keep\n');
  const pack = `pack-${'a'.repeat(40)}`;
  const folders = {
    goKill: (path) => filledFolder(path, { 'import.pack': 'PACK', 'objects/pack/tmp_pack_ab12CD': 'x' }),
    goNone: (path) => mkdirSync(path),
    goFull: (path) => filledFolder(path, { [`objects/pack/${pack}.pack`]: 'x', [`objects/pack/${pack}.idx`]: 'x', [`objects/pack/${pack}.rev`]: 'x' }),
    goPid1: (path) => { filledFolder(path); mkdirSync(`${path}.pid`); },
    stTop1: (path) => filledFolder(path, { 'notes.txt': 'x' }),
    stInfo: (path) => filledFolder(path, { 'objects/info/x': 'x' }),
    stPack: (path) => filledFolder(path, { 'objects/pack/notes.txt': 'x' }),
    stRefs: (path) => filledFolder(path, { 'refs/heads/main': `${'1'.repeat(40)}\n` }),
    stLnk1: (path) => { filledFolder(path); symlinkSync(victim, join(path, 'objects', 'pack', `${pack}.pack`)); },
    stLnk2: (path) => { mkdirSync(path); symlinkSync(join(victim, '..'), join(path, 'objects')); },
  };
  const old = new Date(Date.now() - TWO_DAYS_MS);
  for (const [name, make] of Object.entries(folders)) {
    make(join(temp, `${TEMP_PREFIX}${name}`));
    utimesSync(join(temp, `${TEMP_PREFIX}${name}`), old, old);
  }
  const result = spawnSync(process.execPath, [CLI, 'main...HEAD', '--json'], { cwd: dir, encoding: 'utf8', env: { ...CLEAN_ENV, REVIEW_TIER_LOG: log, TMPDIR: temp } });
  assert.equal(result.status, 0, result.stderr);
  const stays = Object.keys(folders).filter((name) => name.startsWith('st')).map((name) => `${TEMP_PREFIX}${name}`);
  assert.deepEqual(readdirSync(temp).sort(), [`${TEMP_PREFIX}goPid1.pid`, ...stays].sort(), 'what a run can leave is gone, everything else stays');
  for (const name of stays) {
    const said = result.stderr.split('\n').filter((line) => line.includes(`left alone: not a review-tier temp repository: ${join(temp, name)} `));
    assert.equal(said.length, 1, `${name} is named once: ${result.stderr}`);
  }
  assert.match(result.stderr, new RegExp(`left alone: ${join(temp, `${TEMP_PREFIX}goPid1.pid`)} is not a regular file \\(the old temp folder beside it was removed\\)`));
  assert.equal(readFileSync(victim, 'utf8'), 'keep\n', 'no link was followed');
});

test('spec check K6 (fix 6): the removal goes by the names the check listed, never recursively: a file put into a checked folder before the removal stays, with its folder', () => {
  const folder = filledFolder(join(realpathSync(makeTempDir('review-tier-stale-')), `${TEMP_PREFIX}abc123`), { 'import.pack': 'PACK' });
  const shape = staleFolderShape(folder);
  assert.equal(shape.stray, null);
  assert.deepEqual([shape.files.sort(), shape.folders], [['HEAD', 'config', 'import.pack'], ['objects/info', 'objects/pack', 'objects', 'refs/heads', 'refs/tags', 'refs']]);
  writeFileSync(join(folder, 'objects', 'pack', 'swapped-in.txt'), 'x');
  assert.throws(() => removeByName(folder, shape), /ENOTEMPTY|EEXIST/);
  assert.deepEqual(readdirSync(join(folder, 'objects', 'pack')), ['swapped-in.txt']);
  assert.ok(['HEAD', 'config', 'import.pack'].every((file) => !readdirSync(folder).includes(file)), 'the listed files went');
  assert.ok(readdirSync(folder).includes('objects'), 'the folders that hold the new file stayed: the first folder that is not empty stops the removal');
});

test('spec check K3 (fix 6): the last check hashes the whole .pack, past the first chunk: a pack of 3 MiB as written passes, one byte changed after 2 MiB stops the run', () => {
  const folder = bareRepository();
  const bytes = Buffer.from(Array.from({ length: 3 << 20 }, (_, index) => (index * 7) % 251));
  const trailer = 'b'.repeat(40);
  for (const kind of ['pack', 'idx', 'rev']) writeFileSync(join(folder, 'objects', 'pack', `pack-${trailer}.${kind}`), kind === 'pack' ? bytes : 'x');
  const written = { trailer, sha256: createHash('sha256').update(bytes).digest('hex') };
  assert.doesNotThrow(() => checkPackFiles(folder, new Map([[`pack-${trailer}`, notePackFiles(folder, `pack-${trailer}`, written)]]), { last: true }));
  bytes[(5 << 20) / 2] ^= 1;
  writeFileSync(join(folder, 'objects', 'pack', `pack-${trailer}.pack`), bytes);
  const noted = new Map([[`pack-${trailer}`, notePackFiles(folder, `pack-${trailer}`, written)]]);
  assert.doesNotThrow(() => checkPackFiles(folder, noted), 'the file facts are the ones noted');
  assert.throws(() => checkPackFiles(folder, noted, { last: true }), /changed during the run: .*pack-b+\.pack no longer holds the bytes this run wrote/);
  assert.throws(() => notePackFiles(folder, `pack-${'c'.repeat(40)}`, written), /git index-pack named the pack pack-c+, not the pack-b+ this run wrote/);
});
