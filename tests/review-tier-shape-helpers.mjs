// Purpose: honest lane histories of every shape review-tier's import has to carry (lane r7-delta, fix round 5, spec check K9): merges
//   with two and three parents, two merge bases, a start that is the root commit, an empty commit, only deletions, a file that becomes a
//   link or a folder, a submodule pointer that comes, moves and goes, attributes in a sub-folder, a range whose end is not HEAD, range
//   sides written with ~ and ^, a path that is not UTF-8, and the composite lane of probe p24 with its rebuilt fix round.
// Exports: HONEST_SHAPES: [{ name, build() -> { dir, log, calls: [{ label, args }] } }].
// Used by: tests/review-tier-honest-shapes.test.mjs (each call's exit code and counts), and by a differential run of two versions of the
//   tool over the same repositories (the calls are plain argument lists, so any CLI can be run with them in `dir`).
// Invariants: every repository is made by lane() in the OS temp folder; nothing here is forged, every object is what git itself wrote.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CLEAN_ENV, git } from './git-tidy-helpers.mjs';
import { commitEntries } from './review-tier-forgery-helpers.mjs';
import { lane, priorFile, sha256Of } from './review-tier-helpers.mjs';

const body = (text) => `export function run(x) {\n  ${text}\n}\n`;
const STORE = 'class Store:\n    def __init__(self):\n        self.items = []\n\n    def save(self, item):\n        if item is None:\n            raise ValueError("no item")\n        self.items.append(item)\n        return True\n';
const USE_STORE = 'from app import Store\n\n\ndef run():\n    return Store().save(1)\n';
const GATE = "export function decide(cmd) {\n  return 'allow';\n}\n";
const USE_GATE = "import { decide } from './gate.mjs';\nexport function run(c) {\n  return decide(c);\n}\n";
const EXEC = 'import { execSync } from "node:child_process";\nexport const list = (d) => execSync(`ls ${d}`);\n';
const [FIRST_POINTER, SECOND_POINTER] = ['1'.repeat(40), '2'.repeat(40)];
const NO_OBJECT = '0'.repeat(40);
const [EARLIER_DATE, LATER_DATE] = ['2026-01-01T00:00:00Z', '2026-01-01T00:00:10Z'];

/** The arguments of a fix round as a lead passes them from its record. */
function fixRound(reviewed, base, classes = 'logic', more = []) {
  const prior = priorFile();
  return { label: `fix round${more.length > 0 ? ` ${more[0]}` : ''}`, args: ['--delta', reviewed, '--base', base, '--prior', prior, '--prior-sha256', sha256Of(prior), '--lane-classes', classes, ...more, '--json'] };
}
const first = (range, ...more) => ({ label: `first review ${range.replace(/[0-9a-f]{40}/g, '<sha>')}${more.join(' ')}`, args: [range, ...more, '--json'] });

/** A lane() repository plus `put` (write and stage, no commit), `commitAll`, `head` and `onMain(make)` (commits made on main). */
function shapeRepo() {
  const made = lane();
  const { dir } = made;
  const put = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
    git(dir, 'add', '--', path);
  };
  const head = () => git(dir, 'rev-parse', 'HEAD');
  const commitAll = (message) => {
    git(dir, 'commit', '-q', '-m', message);
    return head();
  };
  const onMain = (make) => {
    git(dir, 'checkout', '-q', 'main');
    make();
    const tip = head();
    git(dir, 'checkout', '-q', '-B', 'lane');
    return tip;
  };
  return { ...made, put, head, commitAll, onMain };
}
const built = ({ dir, log }, calls) => ({ dir, log, calls });

function octopusMerge() {
  const repo = shapeRepo();
  const { dir, write } = repo;
  const start = git(dir, 'rev-parse', 'main');
  write('src/a.mjs', body('return x;'));
  for (const side of ['one', 'two']) {
    git(dir, 'checkout', '-q', '-b', side, 'main');
    write(`src/${side}.mjs`, body(`return '${side}';`));
  }
  git(dir, 'checkout', '-q', 'lane');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'merge both sides', 'one', 'two');
  const reviewed = repo.head();
  write('src/a.mjs', body('return x + 1;'));
  return built(repo, [first('main...HEAD'), first('main...HEAD', '--landing'), fixRound(reviewed, start), first('HEAD~2...HEAD'), first('main...HEAD~1^2'), first('main...HEAD~1^3')]);
}

/** Commits `path` with a fixed date: git names merge bases newest first, and the tool reads from the first one it names. */
function writeDated(dir, path, text, date) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
  git(dir, 'add', '--', path);
  const committed = spawnSync('git', ['commit', '-q', '-m', `edit ${path}`], { cwd: dir, encoding: 'utf8', env: { ...CLEAN_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  if (committed.status !== 0) throw new Error(`git commit: ${committed.stderr}`);
  return git(dir, 'rev-parse', 'HEAD');
}

function crissCross() {
  const repo = shapeRepo();
  const { dir, write } = repo;
  const laneSide = writeDated(dir, 'src/lane.mjs', body('return x;'), LATER_DATE);
  git(dir, 'checkout', '-q', 'main');
  const mainSide = writeDated(dir, 'src/main.mjs', body('return -x;'), EARLIER_DATE);
  git(dir, 'merge', '-q', '--no-ff', '-m', 'merge the lane', laneSide);
  git(dir, 'checkout', '-q', 'lane');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'merge main', mainSide);
  const reviewed = write('src/lane.mjs', body('return x * 2;'));
  write('src/lane.mjs', body('return x * 3;'));
  return built(repo, [first('main...HEAD'), first('main...HEAD', '--landing'), fixRound(reviewed, mainSide), fixRound(reviewed, laneSide)]);
}

function rootStart() {
  const repo = shapeRepo();
  const root = repo.head();
  const reviewed = repo.write('src/a.mjs', body('return x;'));
  repo.write('src/a.mjs', body('return x + 1;'));
  return built(repo, [first(`${root}...HEAD`), first('main...HEAD'), fixRound(reviewed, root)]);
}

function emptyCommit() {
  const repo = shapeRepo();
  const start = repo.head();
  repo.write('src/a.mjs', body('return x;'));
  git(repo.dir, 'commit', '-q', '--allow-empty', '-m', 'chore: nothing');
  const reviewed = repo.write('src/b.mjs', body('return 2;'));
  repo.write('src/a.mjs', body('return x + 1;'));
  const fixed = repo.head();
  git(repo.dir, 'commit', '-q', '--allow-empty', '-m', 'chore: nothing again');
  return built(repo, [first('main...HEAD'), fixRound(reviewed, start), { ...fixRound(fixed, start), label: 'fix round of an empty commit' }]);
}

function onlyDeletions() {
  const repo = shapeRepo();
  const start = repo.onMain(() => ['src/a.mjs', 'src/b.mjs', 'docs/guide.md'].forEach((path) => repo.write(path, path.endsWith('.md') ? '# guide\n' : body('return x;'))));
  git(repo.dir, 'rm', '-q', '--', 'src/a.mjs', 'docs/guide.md');
  const reviewed = repo.commitAll('chore: drop two files');
  git(repo.dir, 'rm', '-q', '--', 'src/b.mjs');
  repo.commitAll('chore: drop the last one');
  return built(repo, [first('main...HEAD'), fixRound(reviewed, start)]);
}

function fileBecomesLinkAndFolder() {
  const repo = shapeRepo();
  const { dir } = repo;
  const start = repo.onMain(() => ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'].forEach((path) => repo.write(path, body('return x;'))));
  git(dir, 'rm', '-q', '--', 'src/a.mjs', 'src/b.mjs');
  symlinkSync('c.mjs', join(dir, 'src', 'a.mjs'));
  git(dir, 'add', '--', 'src/a.mjs');
  repo.put('src/b.mjs/inner.mjs', body('return x;'));
  const reviewed = repo.commitAll('refactor: a link and a folder');
  git(dir, 'rm', '-q', '-r', '--', 'src/b.mjs', 'src/a.mjs');
  repo.put('src/b.mjs', body('return x - 1;'));
  repo.put('src/a.mjs', body('return x + 1;'));
  repo.commitAll('fix: files again');
  return built(repo, [first('main...HEAD'), fixRound(reviewed, start)]);
}

function submodulePointer() {
  const repo = shapeRepo();
  const { dir } = repo;
  const start = repo.head();
  repo.write('src/a.mjs', body('return x;'));
  const added = commitEntries(dir, [{ mode: '160000', oid: FIRST_POINTER, path: 'vendor/lib' }], 'chore: add a submodule');
  const moved = commitEntries(dir, [{ mode: '160000', oid: SECOND_POINTER, path: 'vendor/lib' }], 'chore: bump the submodule');
  commitEntries(dir, [{ oid: NO_OBJECT, path: 'vendor/lib' }], 'chore: drop the submodule');
  return built(repo, [first('main...HEAD'), first(`main...${moved}`), fixRound(added, start), fixRound(moved, start)]);
}

function subFolderAttributes() {
  const repo = shapeRepo();
  const { write } = repo;
  const start = repo.onMain(() => [['src/.gitattributes', '*.py diff=python\n'], ['src/use.py', USE_STORE], ['src/app.py', STORE]].forEach(([path, text]) => write(path, text)));
  const reviewed = write('src/app.py', STORE.replace('"no item"', '"none"'));
  write('src/app.py', STORE.replace('"no item"', '"nothing"'));
  return built(repo, [first('main...HEAD'), fixRound(reviewed, start)]);
}

function endIsNotHead() {
  const repo = shapeRepo();
  const { dir, write } = repo;
  const one = write('src/a.mjs', body('return x;'));
  write('src/b.mjs', EXEC);
  git(dir, 'checkout', '-q', '-b', 'elsewhere', 'main');
  write('docs/else.md', '# else\n');
  return built(repo, [first('main...lane'), first(`main...${one}`), first('main...lane~1'), first('lane~2...lane'), first('main...HEAD')]);
}

function notUtf8Name() {
  const repo = shapeRepo();
  const start = repo.head();
  const reviewed = repo.write('src/a.mjs', body('return x;'));
  commitEntries(repo.dir, [{ text: body('return 1;'), path: Buffer.concat([Buffer.from('src/g'), Buffer.from([0xff]), Buffer.from('te.mjs')]) }], 'feat: a name git cannot print');
  return built(repo, [first('main...HEAD'), fixRound(reviewed, start)]);
}

/** The lane of probe p24: a Python method under a diff driver, a rename with an edit, a name with a space, a mode change, a binary
 *  file, a submodule bump and a merge of main; then a linear fix, and the same lane rebuilt on a main that moved. */
function composite() {
  const repo = shapeRepo();
  const { dir, write, put } = repo;
  repo.onMain(() => {
    [['.gitattributes', '*.py diff=python\n'], ['src/app.py', STORE], ['src/use.py', USE_STORE], ['src/gate.mjs', GATE], ['src/run.mjs', USE_GATE], ['docs/guide.md', '# guide\nstep one\nstep two\n'], ['bin/data.bin', Buffer.from([0, 1, 2, 98, 105, 110])], ['bin/tool.sh', '#!/bin/sh\necho hi\n']].forEach(([path, text]) => put(path, text));
    repo.commitAll('init');
    commitEntries(dir, [{ mode: '160000', oid: FIRST_POINTER, path: 'vendor/lib' }], 'chore: a submodule');
  });
  const picks = [write('src/app.py', STORE.replace('        if item is None:\n            raise ValueError("no item")\n', ''))];
  git(dir, 'mv', 'docs/guide.md', 'docs/manual.md');
  put('docs/manual.md', '# manual\nstep one\nstep two\nstep three\n');
  put('src/new file.mjs', EXEC);
  put('bin/data.bin', Buffer.from([0, 1, 2, 3, 98, 105, 110]));
  chmodSync(join(dir, 'bin', 'tool.sh'), 0o755);
  git(dir, 'add', '--', 'bin/tool.sh');
  picks.push(repo.commitAll('feat: the rest'), commitEntries(dir, [{ mode: '160000', oid: SECOND_POINTER, path: 'vendor/lib' }], 'chore: bump the submodule'));
  git(dir, 'checkout', '-q', 'main');
  const moved = write('other.txt', 'x\ny\n');
  git(dir, 'checkout', '-q', 'lane');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge main', 'main');
  const reviewed = repo.head();
  put('src/gate.mjs', GATE.replace("'allow'", "'allowed'"));
  put('src/app.py', STORE.replace('"no item"', '"none"').replace('            raise ValueError("none")\n', '            return False\n'));
  const fix = repo.commitAll('fix: guard text, None check');
  return { ...built(repo, [first('main...HEAD', '--landing'), fixRound(reviewed, moved, 'security,logic,docs')]), rebuild: { picks: [...picks, fix], reviewed, start: moved } };
}

/** The composite lane after another lane landed: the lane is rebuilt on the new main tip and the fix round names both starts. */
function compositeRebuilt() {
  const made = composite();
  const { dir, rebuild } = made;
  git(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'other.txt'), 'x\ny\nz\n');
  git(dir, 'commit', '-q', '-a', '-m', 'chore: another lane landed');
  const tip = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '-B', 'lane', tip);
  git(dir, 'cherry-pick', ...rebuild.picks);
  return { dir, log: made.log, calls: [first('main...HEAD', '--landing'), fixRound(rebuild.reviewed, rebuild.start, 'security,logic,docs', ['--rebased-onto', tip]), { ...fixRound(rebuild.reviewed, tip, 'security,logic,docs'), label: 'fix round with the new tip as --base' }] };
}

export const HONEST_SHAPES = [
  { name: 'an octopus merge in the lane; range sides with ~ and ^', build: octopusMerge },
  { name: 'a criss-cross lane with two merge bases', build: crissCross },
  { name: 'the start is the root commit', build: rootStart },
  { name: 'an empty commit in the lane and as the fix', build: emptyCommit },
  { name: 'a lane with only deletions', build: onlyDeletions },
  { name: 'a file becomes a symlink, another a folder, and back', build: fileBecomesLinkAndFolder, posixOnly: true },
  { name: 'a submodule pointer added, bumped and removed', build: submodulePointer },
  { name: 'attributes in a sub-folder of the start', build: subFolderAttributes },
  { name: 'a range whose end is not HEAD', build: endIsNotHead },
  { name: 'a path that is not UTF-8', build: notUtf8Name },
  { name: 'the composite lane (merge of main, rename with edit, mode, binary, space, submodule)', build: composite },
  { name: 'the composite lane rebuilt on a moved main', build: compositeRebuilt },
];
