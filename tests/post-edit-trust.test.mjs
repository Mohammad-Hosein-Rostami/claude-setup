// Tests for the format trust of home/hooks/post-edit.mjs (audit H8, lib/format-trust.mjs), run as Claude Code runs the hook: a cloned
// repo's `format` script runs through the package manager only when CLAUDE_POST_EDIT_TRUST_FORMAT=1 is trusted; untrusted, only a
// plain formatter call runs as the tool's binary, and anything else is not run and warned about once per session. Posix only: the stub
// package managers and the stub prettier are scripts with a shebang. Every repo, HOME and temp folder is a cs-test temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, git } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/post-edit.mjs', import.meta.url));
const posix = { skip: process.platform === 'win32' && 'stub tools are shebang scripts' };
const TRUST_ENV = 'CLAUDE_POST_EDIT_TRUST_FORMAT';
const EDITED = 'src/a.ts';
const EVIL_SCRIPT = 'node evil.js';
const RELATIVE_PROJECT_DIRS = ['.', 'proj']; // never a session folder: not absolute ('.' is the repo, the hook's cwd)
const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn']; // any of them may be picked from a lockfile above the temp folder; each is a stub
// Our variables a test sets itself; the runner's own values must not leak into a hook run.
const OUR_VARIABLES = [TRUST_ENV, 'CLAUDE_POST_EDIT_SKIP', 'CLAUDE_PROJECT_DIR'];
const BASE_ENV = Object.fromEntries(Object.entries(CLEAN_ENV).filter(([name]) => !OUR_VARIABLES.includes(name)));

/** A shebang script at `path` that runs `body` with `node:fs` and `node:child_process` loaded. */
function stubScript(path, body) {
  writeFileSync(path, `#!${process.execPath}\nconst fs = require('node:fs');\nconst cp = require('node:child_process');\n${body}\n`);
  chmodSync(path, 0o755);
}

/**
 * A project folder with package.json `format` = `script`, src/a.ts, evil.js (writes evil-ran), a stub node_modules/.bin/prettier
 * (appends its args to prettier-ran) and a PATH folder of stub package managers: each appends { pm, args } to pm-ran, then does what
 * `<pm> run <name> -- <args>` does (runs the script with the args in a shell), so a script that goes through it really runs.
 * `files`: more files (path -> text); `gitMode`: null, 'init' or 'commit' (every file committed).
 */
function formatRepo(script, files = {}, gitMode = null) {
  const dir = realpathSync(makeTempDir('post-edit-trust-')); // the real path: macOS /var is a link, and the hook compares real paths
  const marks = { evil: join(dir, 'evil-ran'), prettier: join(dir, 'prettier-ran'), pm: join(dir, 'pm-ran') };
  const all = { 'package.json': JSON.stringify({ scripts: { format: script } }), [EDITED]: 'export const a = 1;\n', 'evil.js': `require('node:fs').writeFileSync(${JSON.stringify(marks.evil)}, 'ran');\n`, ...files };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  if (gitMode !== null) git(dir, 'init', '-q');
  if (gitMode === 'commit') {
    git(dir, 'add', '-A');
    git(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'team');
  }
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  stubScript(join(dir, 'node_modules', '.bin', 'prettier'), `fs.appendFileSync(${JSON.stringify(marks.prettier)}, JSON.stringify(process.argv.slice(2)) + '\\n');`);
  const pathBin = makeTempDir('post-edit-trust-path-');
  symlinkSync(process.execPath, join(pathBin, 'node')); // the script's `node` is this node, whatever the runner's PATH holds
  for (const pm of PACKAGE_MANAGERS) {
    stubScript(join(pathBin, pm), `const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(marks.pm)}, JSON.stringify({ pm: ${JSON.stringify(pm)}, args }) + '\\n');
const script = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts[args[1]];
cp.execSync([script, ...args.slice(3)].join(' '), { stdio: 'inherit' });`);
  }
  return { dir, marks, pathBin };
}

/**
 * Runs the hook once on the edited file of `repo` with session `session`; `env`: more hook environment; `cwd`: the session's cwd;
 * `file`: the edited file, relative to the repo.
 */
function edit(repo, session, env = {}, cwd = repo.dir, file = EDITED) {
  const tmp = makeTempDir('post-edit-trust-tmp-');
  const hookEnv = { ...BASE_ENV, HOME: tmp, USERPROFILE: tmp, TMPDIR: tmp, TEMP: tmp, TMP: tmp, CLAUDE_GUARD_LOG: join(tmp, 'guard.jsonl'), PATH: `${repo.pathBin}${delimiter}${process.env.PATH}`, ...env };
  const input = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: join(repo.dir, file) }, cwd, session_id: session });
  return spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', env: hookEnv, cwd });
}

/** The lines a stub wrote to `mark`, parsed; [] when it never ran. */
const ranWith = (mark) => (existsSync(mark) ? readFileSync(mark, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);

test('untrusted: `node evil.js` as format never runs, not even the package manager; one warning names the package and the trust switch', posix, () => {
  const repo = formatRepo(EVIL_SCRIPT);
  const tmp = makeTempDir('post-edit-trust-session-'); // one temp folder for all three runs: the once-per-session marker lives there
  const shared = { HOME: tmp, USERPROFILE: tmp, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
  const first = edit(repo, 'trust-session-a', shared);
  const again = edit(repo, 'trust-session-a', shared);
  const otherSession = edit(repo, 'trust-session-b', { ...shared, CLAUDE_PROJECT_DIR: repo.dir });
  assert.deepEqual([first.status, again.status, otherSession.status], [0, 0, 0], first.stderr + again.stderr + otherSession.stderr);
  assert.equal(existsSync(repo.marks.evil), false, 'evil.js ran');
  assert.deepEqual(ranWith(repo.marks.pm), [], 'the package manager ran');
  const warning = JSON.parse(first.stdout).systemMessage;
  assert.ok(warning.includes(`${repo.dir}/package.json was not run`), warning);
  assert.ok(warning.includes(`${TRUST_ENV}=1`), warning);
  assert.equal(again.stdout, '', 'the same session is warned once');
  assert.ok(JSON.parse(otherSession.stdout).systemMessage.includes(TRUST_ENV), 'another session is warned again');
});

test('a broad `prettier --write .` runs the stub prettier binary on the edited file only, never the package manager, silently', posix, () => {
  const repo = formatRepo('prettier --write .');
  const run = edit(repo, 'trust-broad');
  assert.deepEqual([run.status, run.stdout, run.stderr], [0, '', '']);
  assert.deepEqual(ranWith(repo.marks.prettier), [['--write', EDITED]]);
  assert.deepEqual(ranWith(repo.marks.pm), []);
});

test('untrusted `prettier --write` runs the stub prettier binary directly with `--write <file>`; npm never runs and nothing is warned', posix, () => {
  const repo = formatRepo('prettier --write');
  const run = edit(repo, 'trust-direct');
  assert.deepEqual([run.status, run.stdout, run.stderr], [0, '', '']);
  assert.deepEqual(ranWith(repo.marks.prettier), [['--write', EDITED]]);
  assert.deepEqual(ranWith(repo.marks.pm), [], 'the package manager ran');
});

test('trusted (CLAUDE_POST_EDIT_TRUST_FORMAT=1 in the shell, cwd the repo root): the script runs through the package manager with `run format -- <file>`', posix, () => {
  const repo = formatRepo(EVIL_SCRIPT, {}, 'init');
  const run = edit(repo, 'trust-shell', { [TRUST_ENV]: '1' });
  assert.deepEqual([run.status, run.stdout], [0, ''], run.stderr);
  assert.deepEqual(ranWith(repo.marks.pm).map(({ args }) => args), [['run', 'format', '--', EDITED]]);
  assert.equal(readFileSync(repo.marks.evil, 'utf8'), 'ran');
});

test('trusted from an untracked .claude/settings.local.json (and so the hook env): the script runs through the package manager', posix, () => {
  const local = { '.claude/settings.local.json': JSON.stringify({ env: { [TRUST_ENV]: '1' } }) };
  const repo = formatRepo(EVIL_SCRIPT, local, 'init');
  const run = edit(repo, 'trust-local', { [TRUST_ENV]: '1' });
  assert.deepEqual([run.status, run.stdout], [0, ''], run.stderr);
  assert.deepEqual(ranWith(repo.marks.pm).map(({ args }) => args), [['run', 'format', '--', EDITED]]);
  assert.equal(existsSync(repo.marks.evil), true);
});

test('a committed team .claude/settings.json that sets the trust switch is ignored, also with the shell value: not run, the warning names the team file', posix, () => {
  const team = { '.claude/settings.json': JSON.stringify({ env: { [TRUST_ENV]: '1' } }) };
  const repo = formatRepo(EVIL_SCRIPT, team, 'commit');
  const run = edit(repo, 'trust-team', { [TRUST_ENV]: '1', CLAUDE_PROJECT_DIR: repo.dir });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(repo.marks.evil), false, 'evil.js ran');
  assert.deepEqual(ranWith(repo.marks.pm), [], 'the package manager ran');
  const warning = JSON.parse(run.stdout).systemMessage;
  assert.match(warning, new RegExp(`team switch ${TRUST_ENV} ignored: the team file .*\\.claude/settings\\.json sets it`));
  assert.ok(warning.includes(`${repo.dir}/package.json was not run`), warning);
});

// A repo file at the package root whose name is an option of the formatter: passed bare, prettier would load it as a plugin.
const OPTION_NAMED_FILE = '--plugin=x.ts';
const OPTION_NAMED_AS_PATH = `./${OPTION_NAMED_FILE}`;

test('a file named like an option reaches the stub prettier as `./<name>`, broad or untrusted, never as the bare option', posix, () => {
  for (const script of ['prettier --write .', 'prettier --write']) {
    const repo = formatRepo(script, { [OPTION_NAMED_FILE]: 'export const x = 1;\n' });
    const run = edit(repo, 'trust-option-file', {}, repo.dir, OPTION_NAMED_FILE);
    assert.deepEqual([run.status, run.stdout, run.stderr], [0, '', ''], script);
    assert.deepEqual(ranWith(repo.marks.prettier), [['--write', OPTION_NAMED_AS_PATH]], script);
    assert.deepEqual(ranWith(repo.marks.pm), [], `${script}: the package manager ran`);
  }
});

test('trusted, a file named like an option is passed after the package manager\'s `--` as `./<name>`', posix, () => {
  const repo = formatRepo(EVIL_SCRIPT, { [OPTION_NAMED_FILE]: 'export const x = 1;\n' }, 'init');
  const run = edit(repo, 'trust-option-file-trusted', { [TRUST_ENV]: '1' }, repo.dir, OPTION_NAMED_FILE);
  assert.deepEqual([run.status, run.stdout], [0, ''], run.stderr);
  assert.deepEqual(ranWith(repo.marks.pm).map(({ args }) => args), [['run', 'format', '--', OPTION_NAMED_AS_PATH]]);
  assert.equal(readFileSync(repo.marks.evil, 'utf8'), 'ran', 'the trusted script itself ran');
});

/** Asserts that the run of `repo`'s hook ran neither its format script nor a package manager, and warned that it was not run. */
function assertNotRun(repo, run, label) {
  assert.equal(run.status, 0, `${label}: ${run.stderr}`);
  assert.equal(existsSync(repo.marks.evil), false, `${label}: evil.js ran`);
  assert.deepEqual(ranWith(repo.marks.pm), [], `${label}: the package manager ran`);
  const warning = JSON.parse(run.stdout).systemMessage;
  assert.ok(warning.includes(`${repo.dir}/package.json was not run`), `${label}: ${warning}`);
}

/** Asserts that the run of `repo`'s hook ran its format script through the package manager on the edited file. */
function assertRanThroughPackageManager(repo, run) {
  assert.deepEqual([run.status, run.stdout], [0, ''], run.stderr);
  assert.deepEqual(ranWith(repo.marks.pm).map(({ args }) => args), [['run', 'format', '--', EDITED]]);
  assert.equal(readFileSync(repo.marks.evil, 'utf8'), 'ran');
}

test('trusted in the shell for CLAUDE_PROJECT_DIR, a session cwd in a clone elsewhere: the clone\'s script never runs and is warned about', posix, () => {
  const project = realpathSync(makeTempDir('post-edit-trust-project-'));
  const clone = formatRepo(EVIL_SCRIPT, {}, 'init');
  assertNotRun(clone, edit(clone, 'trust-clone', { [TRUST_ENV]: '1', CLAUDE_PROJECT_DIR: project }), 'cwd in the clone');
});

test('trusted in the shell, a package inside CLAUDE_PROJECT_DIR runs through the package manager while the session cwd is elsewhere', posix, () => {
  const repo = formatRepo(EVIL_SCRIPT, {}, 'init');
  const elsewhere = realpathSync(makeTempDir('post-edit-trust-elsewhere-'));
  assertRanThroughPackageManager(repo, edit(repo, 'trust-project-dir', { [TRUST_ENV]: '1', CLAUDE_PROJECT_DIR: repo.dir }, elsewhere));
});

test('trusted in the shell, an empty CLAUDE_PROJECT_DIR falls back to the session cwd: the repo\'s script runs through the package manager', posix, () => {
  const repo = formatRepo(EVIL_SCRIPT, {}, 'init');
  assertRanThroughPackageManager(repo, edit(repo, 'trust-empty-project-dir', { [TRUST_ENV]: '1', CLAUDE_PROJECT_DIR: '' }));
});

test('trusted in the shell, a relative CLAUDE_PROJECT_DIR trusts nothing, also with the session cwd the repo: not run, warned', posix, () => {
  for (const projectDir of RELATIVE_PROJECT_DIRS) {
    const repo = formatRepo(EVIL_SCRIPT, {}, 'init');
    assertNotRun(repo, edit(repo, 'trust-relative-project-dir', { [TRUST_ENV]: '1', CLAUDE_PROJECT_DIR: projectDir }), projectDir);
  }
});

test('trusted in the shell, CLAUDE_PROJECT_DIR as the account\'s real home trusts nothing, also with the session cwd the repo: not run, warned', posix, () => {
  const repo = formatRepo(EVIL_SCRIPT, {}, 'init'); // a temp folder: the real home is only named, never written to
  assertNotRun(repo, edit(repo, 'trust-home-project-dir', { [TRUST_ENV]: '1', CLAUDE_PROJECT_DIR: userInfo().homedir }), 'home');
});
