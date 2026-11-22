// Contract tests for home/tools/done-check/lib/base-run.mjs (design section 3.3 and 6, road newchk step 2, lane dc-tests-git). Written from
// the spec, apart from the code: they are red until lane dc-base lands the module.
// Covers: baseTree(top, base, {deadlineMs}) -> Promise<{dir, cleanup} | {unavailable}> (the base commit's files in a temp folder, made with a
// temp index; the real index, worktree list and HEAD never change; the temp folder is gone after cleanup, after a failure and after an
// error; two runs at once do not collide; a repo that names a filter program, a missing commit and a non-git folder give `unavailable`;
// node_modules is shadowed with links to the same targets, except links into the worktree's own packages, which point at the base copy),
// and the base cache cachedBase(repoId, base, label) -> Set | null, saveBase(repoId, base, label, ids) -> boolean (stored under
// ~/.claude/state/done-check/base/; an unknown key, a damaged file and a planted link read as null; a reader never sees a half file).
// Decisions this test fixes where the design is silent: the cache keeps an empty id set as an empty Set (null means "not cached"); a base
//   tree holds no `.git`; `unavailable` is a non-empty string; a failed base never calls a filter program.
// Not covered here: Windows junction shadows (U6, probed on the PC in the proof step), a dead process's leftover temp folder being removed
//   by the next run, and a link planted at the temp folder's own name (its name is the engine's choice).
// Invariants: every project is a fixture project in a temp folder; the test process's own HOME and temp folder are pinned to temp folders
//   (the cache and the temp tree land there), so nothing under the real ~/.claude is read or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { makeDoneCheckRepo } from './done-check-fixture.mjs';
import { git } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const PINNED_HOME = makeTempDir('done-check-base-home-');
process.env.HOME = PINNED_HOME;
process.env.USERPROFILE = PINNED_HOME;

const BASE_MODULE = new URL('../home/tools/done-check/lib/base-run.mjs', import.meta.url).href;
const loadBase = () => import(BASE_MODULE);
const DEADLINE_MS = 30_000;
const UNKNOWN_COMMIT = '0'.repeat(40);
const STATE_FOLDER = join(PINNED_HOME, '.claude', 'state', 'done-check');
const CACHE_FOLDER = join(STATE_FOLDER, 'base');
const NEEDS_POSIX_LINKS = { skip: process.platform === 'win32' ? 'a link to a file needs a privilege on Windows' : false };

const withRepo = (t, options) => {
  const repo = makeDoneCheckRepo(options);
  t.after(() => repo.cleanup());
  return repo;
};

/** Every regular file and link under `root` (relative, `/` separated, sorted); [] when the folder is missing. */
function filesUnder(root, prefix = '') {
  if (!existsSync(root)) return [];
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...filesUnder(join(root, entry.name), `${prefix}${entry.name}/`));
    else found.push(`${prefix}${entry.name}`);
  }
  return found.sort();
}

/** The cache folder is the test's own: each test that writes it starts and ends with it removed (a planted link is removed, not followed). */
function cleanState(t) {
  rmSync(join(PINNED_HOME, '.claude'), { recursive: true, force: true });
  t.after(() => rmSync(join(PINNED_HOME, '.claude'), { recursive: true, force: true }));
}

/** Makes os.tmpdir() an empty folder of our own for the rest of the test, so a leftover of the engine can be seen. */
function useScratchTmp(t) {
  const scratch = makeTempDir('done-check-base-scratch-'); // made before the switch, in the real temp folder
  const names = ['TMPDIR', 'TEMP', 'TMP'];
  const saved = names.map((name) => [name, process.env[name]]);
  for (const name of names) process.env[name] = scratch;
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  return scratch;
}

/** What the engine may have left behind: every file under the scratch temp folder and under the pinned HOME. */
const leftovers = (scratch) => [...filesUnder(scratch).map((file) => `tmp:${file}`), ...filesUnder(PINNED_HOME).map((file) => `home:${file}`)];

async function settle(makePromise) {
  try {
    return { value: await makePromise() };
  } catch (error) {
    return { error };
  }
}

/** A repo whose head has moved on from its base: a changed file, a deleted file, a new file, and uncommitted work on top. */
function repoWithMovedHead(t) {
  const repo = withRepo(t, { files: { 'src/a.ts': 'export const a = "base";\n', 'src/gone.ts': 'export const gone = 1;\n' } });
  repo.write('src/a.ts', 'export const a = "head";\n');
  repo.remove('src/gone.ts');
  repo.write('src/new.ts', 'export const added = 1;\n');
  repo.commit('head moves on');
  repo.write('untracked-notes.txt', 'untracked\n');
  return repo;
}

/** The parts of the repo's git state a base run must leave alone. */
function gitState(repo) {
  git(repo.dir, 'status', '--porcelain=v1'); // refresh the index first, so a refresh by the engine cannot look like a change
  return {
    index: git(repo.dir, 'ls-files', '-s'),
    worktrees: git(repo.dir, 'worktree', 'list', '--porcelain'),
    head: git(repo.dir, 'rev-parse', 'HEAD'),
    status: git(repo.dir, 'status', '--porcelain=v1'),
  };
}

test('the base tree holds the files of the base commit, not of the head', async (t) => {
  const repo = repoWithMovedHead(t);
  const { baseTree } = await loadBase();
  const tree = await baseTree(repo.dir, repo.baseSha, { deadlineMs: DEADLINE_MS });
  t.after(() => tree.cleanup?.());
  assert.equal(typeof tree.dir, 'string');
  assert.equal(readFileSync(join(tree.dir, 'src/a.ts'), 'utf8'), 'export const a = "base";\n');
  assert.equal(readFileSync(join(tree.dir, 'src/gone.ts'), 'utf8'), 'export const gone = 1;\n');
  assert.equal(readFileSync(join(tree.dir, 'base.txt'), 'utf8'), 'base\n');
  assert.equal(existsSync(join(tree.dir, 'src/new.ts')), false);
  assert.equal(existsSync(join(tree.dir, 'untracked-notes.txt')), false);
  assert.equal(existsSync(join(tree.dir, '.git')), false);
});

test('the base tree is a folder of its own, outside the project', async (t) => {
  const repo = repoWithMovedHead(t);
  const { baseTree } = await loadBase();
  const tree = await baseTree(repo.dir, repo.baseSha, { deadlineMs: DEADLINE_MS });
  t.after(() => tree.cleanup?.());
  const real = realpathSync(tree.dir);
  assert.ok(!(real + sep).startsWith(repo.dir + sep), 'the base tree is inside the project');
  assert.ok(!(repo.dir + sep).startsWith(real + sep), 'the project is inside the base tree');
});

test('the real index, the worktree list and HEAD are the same after a base run', async (t) => {
  const repo = repoWithMovedHead(t);
  repo.write('staged.ts', 'export const staged = 1;\n');
  git(repo.dir, 'add', 'staged.ts'); // staged but not committed: the index differs from HEAD
  repo.write('src/a.ts', 'export const a = "edited after the commit";\n');
  const before = gitState(repo);
  assert.ok(before.status.includes('staged.ts'), 'the staged file is not in the status');
  const { baseTree } = await loadBase();
  const tree = await baseTree(repo.dir, repo.baseSha, { deadlineMs: DEADLINE_MS });
  assert.deepEqual(gitState(repo), before);
  tree.cleanup?.();
  assert.deepEqual(gitState(repo), before);
  assert.equal(readFileSync(join(repo.dir, 'src/a.ts'), 'utf8'), 'export const a = "edited after the commit";\n');
});

test('cleanup removes the base tree, and a second cleanup is harmless', async (t) => {
  const repo = repoWithMovedHead(t);
  const { baseTree } = await loadBase();
  const tree = await baseTree(repo.dir, repo.baseSha, { deadlineMs: DEADLINE_MS });
  assert.equal(existsSync(tree.dir), true);
  tree.cleanup();
  assert.equal(existsSync(tree.dir), false);
  assert.doesNotThrow(() => tree.cleanup());
});

test('after a successful base run and its cleanup no temp folder or temp index is left', async (t) => {
  const repo = repoWithMovedHead(t);
  const scratch = useScratchTmp(t);
  const before = leftovers(scratch);
  const { baseTree } = await loadBase();
  const tree = await baseTree(repo.dir, repo.baseSha, { deadlineMs: DEADLINE_MS });
  tree.cleanup();
  assert.equal(existsSync(tree.dir), false);
  assert.deepEqual(leftovers(scratch), before);
});

test('after a failed base run (a commit that does not exist) nothing is left, even without a cleanup call', async (t) => {
  const repo = repoWithMovedHead(t);
  const scratch = useScratchTmp(t);
  const before = leftovers(scratch);
  const { baseTree } = await loadBase();
  const result = await baseTree(repo.dir, UNKNOWN_COMMIT, { deadlineMs: DEADLINE_MS });
  assert.equal(typeof result.unavailable, 'string');
  assert.notEqual(result.unavailable, '');
  assert.equal(result.dir, undefined);
  assert.deepEqual(leftovers(scratch), before);
});

test('after an error (a folder that is not there, a file instead of a folder) nothing is left', async (t) => {
  const repo = repoWithMovedHead(t);
  const scratch = useScratchTmp(t);
  const before = leftovers(scratch);
  const { baseTree } = await loadBase();
  for (const top of [join(repo.dir, 'no-such-folder'), join(repo.dir, 'base.txt')]) {
    const outcome = await settle(() => baseTree(top, repo.baseSha, { deadlineMs: DEADLINE_MS }));
    if (outcome.value) {
      assert.equal(typeof outcome.value.unavailable, 'string', `${top}: a resolved result must say unavailable`);
      outcome.value.cleanup?.();
    }
    assert.deepEqual(leftovers(scratch), before, `${top}: something was left behind`);
  }
});

test('a very short deadline leaves nothing behind, whichever way the run ends', async (t) => {
  const repo = repoWithMovedHead(t);
  const scratch = useScratchTmp(t);
  const before = leftovers(scratch);
  const { baseTree } = await loadBase();
  const outcome = await settle(() => baseTree(repo.dir, repo.baseSha, { deadlineMs: 1 }));
  if (outcome.value) {
    assert.ok(typeof outcome.value.unavailable === 'string' || typeof outcome.value.dir === 'string');
    outcome.value.cleanup?.();
  }
  assert.deepEqual(leftovers(scratch), before);
});

test('a folder that is not a git repository gives unavailable', async (t) => {
  const repo = withRepo(t, { plain: true, files: { 'src/a.ts': 'export {};\n' } });
  const { baseTree } = await loadBase();
  const outcome = await settle(() => baseTree(repo.dir, UNKNOWN_COMMIT, { deadlineMs: DEADLINE_MS }));
  if (outcome.value) assert.equal(typeof outcome.value.unavailable, 'string');
  else assert.ok(outcome.error instanceof Error);
});

test('a repo that names a filter program gives unavailable and the program never runs', async (t) => {
  const repo = withRepo(t, { files: { '.gitattributes': '*.ts filter=evil\n', 'src/a.ts': 'export const a = 1;\n' } });
  const marker = join(dirname(repo.dir), 'filter-ran').replaceAll('\\', '/');
  git(repo.dir, 'config', 'filter.evil.smudge', `echo ran > "${marker}"`);
  // control: plain git does run the program on checkout-index, so a missing marker later means the engine did not run it
  git(repo.dir, 'checkout-index', '-a', '-f', `--prefix=${join(dirname(repo.dir), 'control')}/`);
  assert.equal(existsSync(marker), true, 'the control run did not call the filter, so this test proves nothing');
  rmSync(marker);
  const { baseTree } = await loadBase();
  const result = await baseTree(repo.dir, repo.baseSha, { deadlineMs: DEADLINE_MS });
  result.cleanup?.();
  assert.equal(typeof result.unavailable, 'string');
  assert.notEqual(result.unavailable, '');
  assert.equal(existsSync(marker), false, 'the filter program ran');
});

test('two base runs at once on one base both finish with trees of their own', async (t) => {
  const repo = repoWithMovedHead(t);
  const scratch = useScratchTmp(t);
  const before = leftovers(scratch);
  const { baseTree } = await loadBase();
  const [first, second] = await Promise.all([
    baseTree(repo.dir, repo.baseSha, { deadlineMs: DEADLINE_MS }),
    baseTree(repo.dir, repo.baseSha, { deadlineMs: DEADLINE_MS }),
  ]);
  assert.notEqual(first.dir, second.dir);
  for (const tree of [first, second]) assert.equal(readFileSync(join(tree.dir, 'src/a.ts'), 'utf8'), 'export const a = "base";\n');
  first.cleanup();
  assert.equal(existsSync(first.dir), false);
  assert.equal(readFileSync(join(second.dir, 'src/a.ts'), 'utf8'), 'export const a = "base";\n', 'cleaning one run broke the other');
  second.cleanup();
  assert.deepEqual(leftovers(scratch), before);
});

/** A project with workspace packages: node_modules links into the repo's own packages, and a third-party package. */
function workspaceRepo(t) {
  const repo = withRepo(t, {
    files: {
      'packages/lib/package.json': '{ "name": "lib", "main": "index.js" }\n',
      'packages/lib/index.js': "module.exports = 'base-copy';\n",
      'packages/app/package.json': '{ "name": "app" }\n',
    },
  });
  const link = (target, at) => {
    mkdirSync(dirname(at), { recursive: true });
    symlinkSync(target, at, 'junction'); // the type is only used on Windows, where it must be a junction to an absolute folder
  };
  link(join(repo.dir, 'packages', 'lib'), join(repo.dir, 'node_modules', 'lib'));
  link(join(repo.dir, 'packages', 'lib'), join(repo.dir, 'packages', 'app', 'node_modules', 'lib'));
  if (process.platform !== 'win32') link('../packages/lib', join(repo.dir, 'node_modules', 'lib-relative'));
  mkdirSync(join(repo.dir, 'node_modules', 'other'), { recursive: true });
  writeFileSync(join(repo.dir, 'node_modules', 'other', 'index.js'), "module.exports = 'third-party';\n");
  repo.write('packages/lib/index.js', "module.exports = 'head-copy';\n");
  repo.commit('the head changes the workspace package');
  return repo;
}

test('a node_modules link into the repo\'s own package resolves to the base copy in the shadow', async (t) => {
  const repo = workspaceRepo(t);
  const { baseTree } = await loadBase();
  const tree = await baseTree(repo.dir, repo.baseSha, { deadlineMs: DEADLINE_MS });
  t.after(() => tree.cleanup?.());
  const shadowRoot = realpathSync(tree.dir);
  const linked = ['node_modules/lib/index.js', 'packages/app/node_modules/lib/index.js'];
  if (process.platform !== 'win32') linked.push('node_modules/lib-relative/index.js');
  for (const file of linked) {
    const shown = join(tree.dir, file);
    assert.equal(readFileSync(shown, 'utf8'), "module.exports = 'base-copy';\n", `${file} shows the head copy`);
    const real = realpathSync(shown);
    assert.ok(real.startsWith(shadowRoot + sep), `${file} leaves the base tree: ${real}`);
  }
  const resolved = spawnSync(process.execPath, ['-p', "require('lib')"], { cwd: join(tree.dir, 'packages', 'app'), encoding: 'utf8' });
  assert.equal(resolved.stdout.trim(), 'base-copy', resolved.stderr);
});

test('a third-party package in node_modules is shared with the worktree, and the worktree is not changed', async (t) => {
  const repo = workspaceRepo(t);
  const { baseTree } = await loadBase();
  const tree = await baseTree(repo.dir, repo.baseSha, { deadlineMs: DEADLINE_MS });
  t.after(() => tree.cleanup?.());
  const shown = join(tree.dir, 'node_modules', 'other', 'index.js');
  assert.equal(readFileSync(shown, 'utf8'), "module.exports = 'third-party';\n");
  assert.equal(realpathSync(shown), realpathSync(join(repo.dir, 'node_modules', 'other', 'index.js')));
  assert.equal(readFileSync(join(repo.dir, 'packages', 'lib', 'index.js'), 'utf8'), "module.exports = 'head-copy';\n");
  assert.equal(realpathSync(join(repo.dir, 'node_modules', 'lib')), join(repo.dir, 'packages', 'lib'));
  assert.equal(lstatSync(join(repo.dir, 'node_modules', 'lib')).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(repo.dir, 'node_modules', 'lib')).replace(/[\\/]+$/, ''), join(repo.dir, 'packages', 'lib'));
});

const CACHE_KEY = ['repo-id-1', 'a'.repeat(40), 'vitest'];
const FAILURE_IDS = ['src/a.test.ts|renders the page', 'src/a.ts|TS2322|Type \'string\' is not assignable to type "number".', 'uni|ünï ß 日本語', 'line\nbreak|x', ''];

test('a saved set of old failures reads back as the same set', async (t) => {
  cleanState(t);
  const { cachedBase, saveBase } = await loadBase();
  assert.equal(await saveBase(...CACHE_KEY, new Set(FAILURE_IDS)), true);
  assert.deepEqual(await cachedBase(...CACHE_KEY), new Set(FAILURE_IDS));
});

test('the cache follows the env passed in, not the process HOME (P8)', async (t) => {
  cleanState(t);
  const otherHome = makeTempDir('done-check-base-other-home-');
  const otherEnv = { HOME: otherHome, USERPROFILE: otherHome };
  const { cachedBase, saveBase } = await loadBase();
  assert.equal(await saveBase(...CACHE_KEY, new Set(['kept']), otherEnv), true);
  assert.deepEqual(filesUnder(join(PINNED_HOME, '.claude')), [], 'the process HOME was written');
  assert.equal(filesUnder(join(otherHome, '.claude', 'state', 'done-check', 'base')).length, 1);
  assert.deepEqual(await cachedBase(...CACHE_KEY, otherEnv), new Set(['kept']));
  assert.equal(await cachedBase(...CACHE_KEY), null, 'the process HOME was read');
});

test('an unknown key reads as null, never as an empty set', async (t) => {
  cleanState(t);
  const { cachedBase } = await loadBase();
  assert.equal(await cachedBase(...CACHE_KEY), null);
});

test('a base with no old failures is cached as an empty set, not as null', async (t) => {
  cleanState(t);
  const { cachedBase, saveBase } = await loadBase();
  assert.equal(await saveBase(...CACHE_KEY, new Set()), true);
  const read = await cachedBase(...CACHE_KEY);
  assert.ok(read instanceof Set);
  assert.equal(read.size, 0);
});

test('each repo, base commit and check label has its own cache entry', async (t) => {
  cleanState(t);
  const { cachedBase, saveBase } = await loadBase();
  await saveBase('repo-a', 'b'.repeat(40), 'vitest', new Set(['one']));
  await saveBase('repo-b', 'b'.repeat(40), 'vitest', new Set(['two']));
  await saveBase('repo-a', 'c'.repeat(40), 'vitest', new Set(['three']));
  await saveBase('repo-a', 'b'.repeat(40), 'tsc -p tsconfig.json', new Set(['four']));
  assert.deepEqual(await cachedBase('repo-a', 'b'.repeat(40), 'vitest'), new Set(['one']));
  assert.deepEqual(await cachedBase('repo-b', 'b'.repeat(40), 'vitest'), new Set(['two']));
  assert.deepEqual(await cachedBase('repo-a', 'c'.repeat(40), 'vitest'), new Set(['three']));
  assert.deepEqual(await cachedBase('repo-a', 'b'.repeat(40), 'tsc -p tsconfig.json'), new Set(['four']));
  assert.equal(await cachedBase('repo-c', 'b'.repeat(40), 'vitest'), null);
});

test('saving again for the same key replaces the old set', async (t) => {
  cleanState(t);
  const { cachedBase, saveBase } = await loadBase();
  await saveBase(...CACHE_KEY, new Set(['old']));
  await saveBase(...CACHE_KEY, new Set(['new']));
  assert.deepEqual(await cachedBase(...CACHE_KEY), new Set(['new']));
});

test('the cache lives under the state folder of HOME and a new process reads it', async (t) => {
  cleanState(t);
  const { saveBase } = await loadBase();
  await saveBase(...CACHE_KEY, new Set(['kept']));
  assert.ok(filesUnder(CACHE_FOLDER).length >= 1, `nothing was written under ${CACHE_FOLDER}`);
  const code = `import { cachedBase } from ${JSON.stringify(BASE_MODULE)};
    const got = await cachedBase(...JSON.parse(process.argv[1]));
    console.log(JSON.stringify(got === null ? null : [...got]));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(CACHE_KEY)], { encoding: 'utf8', env: { ...process.env, HOME: PINNED_HOME, USERPROFILE: PINNED_HOME } });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), ['kept']);
});

test('a damaged cache file reads as null, whatever way it is damaged', async (t) => {
  cleanState(t);
  const { cachedBase, saveBase } = await loadBase();
  await saveBase(...CACHE_KEY, new Set(FAILURE_IDS));
  const [name] = filesUnder(CACHE_FOLDER);
  const file = join(CACHE_FOLDER, name);
  const whole = readFileSync(file);
  for (const damage of [Buffer.from('this is not a cache {['), whole.subarray(0, Math.floor(whole.length / 2)), Buffer.alloc(0), Buffer.from([0xff, 0xfe, 0x00])]) {
    writeFileSync(file, damage);
    assert.equal(await cachedBase(...CACHE_KEY), null, `a file of ${damage.length} damaged bytes was read as a cache`);
  }
});

test('a link planted at the cache folder is never written through', async (t) => {
  cleanState(t);
  const victim = makeTempDir('done-check-base-victim-');
  mkdirSync(STATE_FOLDER, { recursive: true });
  symlinkSync(victim, CACHE_FOLDER, 'junction');
  const { cachedBase, saveBase } = await loadBase();
  await saveBase(...CACHE_KEY, new Set(['must not land in the victim']));
  assert.deepEqual(filesUnder(victim), []);
  assert.equal(await cachedBase(...CACHE_KEY), null);
});

test('a link planted at the done-check state folder is never written through', async (t) => {
  cleanState(t);
  const victim = makeTempDir('done-check-base-victim-');
  mkdirSync(dirname(STATE_FOLDER), { recursive: true });
  symlinkSync(victim, STATE_FOLDER, 'junction');
  const { cachedBase, saveBase } = await loadBase();
  await saveBase(...CACHE_KEY, new Set(['must not land in the victim']));
  assert.deepEqual(filesUnder(victim), []);
  assert.equal(await cachedBase(...CACHE_KEY), null);
});

test('a cache file replaced by a link to a valid copy is not read', NEEDS_POSIX_LINKS, async (t) => {
  cleanState(t);
  const { cachedBase, saveBase } = await loadBase();
  await saveBase(...CACHE_KEY, new Set(['real']));
  const [name] = filesUnder(CACHE_FOLDER);
  const file = join(CACHE_FOLDER, name);
  const victim = join(makeTempDir('done-check-base-victim-'), 'copy');
  writeFileSync(victim, readFileSync(file));
  rmSync(file);
  symlinkSync(victim, file);
  assert.equal(await cachedBase(...CACHE_KEY), null);
});

const WRITER = `import { saveBase } from ${JSON.stringify(BASE_MODULE)};
  const [key, ids, times] = JSON.parse(process.argv[1]);
  for (let turn = 0; turn < times; turn += 1) {
    if ((await saveBase(...key, new Set(ids))) !== true) { console.error('saveBase did not return true'); process.exit(3); }
  }`;

const runChild = (code, payload) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(payload)], {
    env: { ...process.env, HOME: PINNED_HOME, USERPROFILE: PINNED_HOME }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (status) => resolve({ status, stderr }));
});

test('two writers and a reader on one cache key: the reader sees nothing, or one whole set, never a mix', async (t) => {
  cleanState(t);
  const { cachedBase } = await loadBase();
  const idsOf = (letter) => Array.from({ length: 1500 }, (_, index) => `src/${letter}${index}.test.ts|a test with a fairly long full name number ${index}`);
  const first = idsOf('a');
  const second = idsOf('b');
  const wholeSets = [first, second].map((ids) => [...ids].sort().join('\n'));
  let finished = false;
  const writers = Promise.all([runChild(WRITER, [CACHE_KEY, first, 40]), runChild(WRITER, [CACHE_KEY, second, 40])]).then((results) => {
    finished = true;
    return results;
  });
  let reads = 0;
  while (!finished) {
    const seen = await cachedBase(...CACHE_KEY);
    reads += 1;
    if (seen !== null) assert.ok(wholeSets.includes([...seen].sort().join('\n')), `a reader saw a set that neither writer saved (${seen.size} ids)`);
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
  }
  for (const { status, stderr } of await writers) assert.equal(status, 0, stderr);
  assert.ok(reads > 0);
  assert.ok(wholeSets.includes([...(await cachedBase(...CACHE_KEY))].sort().join('\n')));
});
