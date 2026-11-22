// Shared fixture for the done-check tests: a throw-away project (git or plain folder) in a temp folder, with fake tsc, eslint, vitest and
// jest installed as node scripts in its node_modules, and a private HOME, so the real done-check code runs on nothing of the owner's.
// Exports: HOSTILE_FOLDER_NAME, REPLAY_FILE, FAKE_TOOLS, makeDoneCheckRepo(options) -> repo, nodeTestSource(options).
// How a fake tool answers: it looks for `fake-tools.json` from its working folder upwards and replays the entry named after the tool:
//   { "<tool>": { stdout?, stderr?, exit?, outputFile?, sleepMs?, spawnChild? } }
//   stdout/stderr are printed as given; exit is the exit code (default 0); outputFile is written to the path after `--outputFile` or
//   `--output-file` (an empty string writes an empty file, absent writes none); sleepMs delays the exit (a deadline test);
//   spawnChild also starts a child that sleeps as long (a kill-the-whole-tree test). The file is a tracked file of the project, so
//   the base tree and the head tree can answer differently. Every call is appended to a log outside the project (repo.calls()).
// "node" has no fake: the node:test runner is the real one, and nodeTestSource() writes real test files that pass, fail or sleep.
// Invariants: every folder is under the OS temp folder and removed by repo.cleanup() (also when building throws, and at process exit);
//   HOME and USERPROFILE point into the fixture, so ~/.claude/state is never read or written; no GIT_*, session id, DONE_CHECK_*
//   or NODE_TEST_CONTEXT reaches a child; the project folder name holds a space and quotes; nothing here starts a shell.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CLEAN_ENV, git as runGit } from './git-tidy-helpers.mjs';
import { makeTempDir, removeTempDir } from './temp-dir-helpers.mjs';

/** A project folder name with a space and quotes (a double quote is not a legal Windows name, so there it is left out). */
export const HOSTILE_FOLDER_NAME = process.platform === 'win32' ? "my repo's x" : `my repo's "x"`;

/** The file (tracked in the project) that tells the fake tools what to print. */
export const REPLAY_FILE = 'fake-tools.json';

/** Each fake tool: the folder in node_modules, the version its package.json claims, its entry file (as the real package names it). */
export const FAKE_TOOLS = Object.freeze({
  tsc: { folder: 'typescript', version: '5.8.3', entry: 'bin/tsc', esm: false },
  eslint: { folder: 'eslint', version: '9.39.5', entry: 'bin/eslint.js', esm: false },
  vitest: { folder: 'vitest', version: '4.1.9', entry: 'vitest.mjs', esm: true },
  jest: { folder: 'jest', version: '30.0.0', entry: 'bin/jest.js', esm: false },
});

const RUN_TIMEOUT_MS = 180_000; // longer than the 150 s hook timeout, so a test sees the hook's own end first
const CJS_IMPORTS = "const fs = require('node:fs'); const path = require('node:path'); const cp = require('node:child_process');";
const ESM_IMPORTS = "import * as fs from 'node:fs'; import * as path from 'node:path'; import * as cp from 'node:child_process';";
// The part every fake tool shares. %TOOL%, %LOG% and %REPLAY% are filled with JSON strings when the file is written.
const FAKE_TOOL_BODY = `
const TOOL = %TOOL%;
const LOG = %LOG%;
const REPLAY_FILE = %REPLAY%;
const args = process.argv.slice(2);
const log = (entry) => fs.appendFileSync(LOG, JSON.stringify(entry) + '\\n');
log({ tool: TOOL, argv: args, cwd: process.cwd() });
function findReplay() {
  let dir = process.cwd();
  for (;;) {
    const file = path.join(dir, REPLAY_FILE);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'))[TOOL] ?? {};
    const parent = path.dirname(dir);
    if (parent === dir) return {};
    dir = parent;
  }
}
const replay = findReplay();
const flag = args.findIndex((arg) => arg === '--outputFile' || arg === '--output-file');
if (replay.outputFile !== undefined && flag >= 0) fs.writeFileSync(args[flag + 1], replay.outputFile);
if (replay.stdout) process.stdout.write(replay.stdout);
if (replay.stderr) process.stderr.write(replay.stderr);
process.exitCode = replay.exit ?? 0;
if (replay.sleepMs) {
  if (replay.spawnChild) {
    const child = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, ' + replay.sleepMs + ')'], { stdio: 'ignore' });
    log({ tool: TOOL, childPid: child.pid });
  }
  setTimeout(() => {}, replay.sleepMs);
}
`;

const fakeToolSource = (tool, logFile) => {
  const body = FAKE_TOOL_BODY.replace('%TOOL%', JSON.stringify(tool)).replace('%LOG%', JSON.stringify(logFile)).replace('%REPLAY%', JSON.stringify(REPLAY_FILE));
  return `${FAKE_TOOLS[tool].esm ? ESM_IMPORTS : CJS_IMPORTS}${body}`;
};

const writeFileMakingFolders = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

/**
 * The text of a real node:test file. Run by the real `node --test`, it prints real TAP.
 * @param {{ imports?: string[], cases?: { name: string, ok?: boolean, sleepMs?: number }[] }} options import specifiers (relative to the
 *   test file) so a picker that follows imports finds the changed file; each case passes (default), fails, or waits `sleepMs` first
 * @returns {string} the file text
 */
export function nodeTestSource({ imports = [], cases = [{ name: 'works' }] } = {}) {
  const importLines = imports.map((specifier) => `import ${JSON.stringify(specifier)};`);
  const caseLines = cases.map(({ name, ok = true, sleepMs = 0 }) => `test(${JSON.stringify(name)}, async () => {
  await new Promise((resolveWait) => setTimeout(resolveWait, ${sleepMs}));
  assert.equal(${ok}, true);
});`);
  return ["import test from 'node:test';", "import assert from 'node:assert/strict';", ...importLines, ...caseLines, ''].join('\n');
}

/**
 * Builds a project in a fresh temp folder and returns handles to drive it. Call `repo.cleanup()` in a `finally` or `t.after`.
 * @param {object} [options]
 * @param {boolean} [options.plain] true: a plain folder, not a git repo (no base, `baseSha` is null)
 * @param {Record<string, string>} [options.files] files written before the first commit, by repo-relative path
 * @param {object|null} [options.packageJson] written as the root package.json; null writes none
 * @param {string[]} [options.tools] fake tools to install at the root: any of tsc, eslint, vitest, jest
 * @param {Record<string, object>} [options.replay] what the fake tools answer in the first commit (see the header)
 * @returns {{ dir: string, home: string, env: object, baseSha: string|null, logFile: string,
 *   write: (file: string, text: string) => void, remove: (file: string) => void, commit: (message?: string) => string,
 *   head: () => string, installTools: (names: string[], at?: string) => void, setTool: (tool: string, behavior: object, at?: string) => void,
 *   calls: (tool?: string) => object[], clearCalls: () => void,
 *   run: (script: string, args: string[], extra?: { cwd?: string, input?: string, env?: object }) => import('node:child_process').SpawnSyncReturns<string>,
 *   cleanup: () => void }}
 */
export function makeDoneCheckRepo({ plain = false, files = {}, packageJson = null, tools = [], replay = {} } = {}) {
  const root = realpathSync(makeTempDir('done-check-'));
  try {
    return buildRepo(root, { plain, files, packageJson, tools, replay });
  } catch (error) {
    removeTempDir(root); // a build that throws must not leave its folder behind
    throw error;
  }
}

function buildRepo(root, { plain, files, packageJson, tools, replay }) {
  const dir = join(root, HOSTILE_FOLDER_NAME);
  const home = join(root, 'home');
  const logFile = join(root, 'tool-calls.jsonl');
  mkdirSync(dir);
  mkdirSync(home);
  writeFileSync(logFile, '');
  const { NODE_TEST_CONTEXT, ...cleanEnv } = CLEAN_ENV; // a `node --test` child must not think it belongs to this test run
  const env = Object.fromEntries(Object.entries({ ...cleanEnv, HOME: home, USERPROFILE: home }).filter(([name]) => !name.startsWith('DONE_CHECK_')));

  const repo = {
    dir, home, env, logFile, baseSha: null,
    /** Writes `file` (repo-relative, folders made) with `text`. */
    write: (file, text) => writeFileMakingFolders(resolve(dir, file), text),
    /** Deletes `file` (repo-relative); a missing file is fine. */
    remove: (file) => rmSync(resolve(dir, file), { force: true }),
    /** Stages everything and commits it; returns the new full hash. Git projects only. */
    commit: (message = 'change') => {
      runGit(dir, 'add', '-A');
      runGit(dir, 'commit', '-q', '-m', message);
      return runGit(dir, 'rev-parse', 'HEAD');
    },
    head: () => runGit(dir, 'rev-parse', 'HEAD'),
    /** Installs the fake `names` into `<at>/node_modules` (`at`: a folder, relative to the project or absolute; default the root). */
    installTools: (names, at = '.') => {
      for (const name of names) {
        const spec = FAKE_TOOLS[name];
        if (!spec) throw new Error(`done-check-fixture: no fake tool "${name}" (have ${Object.keys(FAKE_TOOLS).join(', ')})`);
        const folder = resolve(dir, at, 'node_modules', spec.folder);
        writeFileMakingFolders(join(folder, 'package.json'), `${JSON.stringify({ name: spec.folder, version: spec.version, bin: { [name]: `./${spec.entry}` } })}\n`);
        writeFileMakingFolders(join(folder, spec.entry), fakeToolSource(name, logFile));
      }
    },
    /** Sets what fake `tool` answers in `<at>/fake-tools.json` (merged with the other tools' entries); commit it to change the base or head tree. */
    setTool: (tool, behavior, at = '.') => {
      const file = resolve(dir, at, REPLAY_FILE);
      const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
      writeFileMakingFolders(file, `${JSON.stringify({ ...current, [tool]: behavior }, null, 2)}\n`);
    },
    /** What the fake tools were called with, oldest first: { tool, argv, cwd } (and { tool, childPid } for a spawned child). */
    calls: (tool) => readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => !tool || entry.tool === tool),
    clearCalls: () => writeFileSync(logFile, ''),
    /** Runs a node script with the fixture's env (no shell) and returns the spawnSync result. */
    run: (script, args, { cwd = dir, input, env: extraEnv = {} } = {}) => spawnSync(process.execPath, [script, ...args], { cwd, input, encoding: 'utf8', env: { ...env, ...extraEnv }, timeout: RUN_TIMEOUT_MS }),
    cleanup: () => removeTempDir(root),
  };

  if (!plain) {
    runGit(root, 'init', '-q', '-b', 'main', dir);
    runGit(dir, 'config', 'user.name', 't');
    runGit(dir, 'config', 'user.email', 't@t');
    runGit(dir, 'config', 'commit.gpgsign', 'false');
    repo.write('.gitignore', 'node_modules/\n');
  }
  if (packageJson) repo.write('package.json', `${JSON.stringify(packageJson, null, 2)}\n`);
  for (const [file, text] of Object.entries(files)) repo.write(file, text);
  for (const [tool, behavior] of Object.entries(replay)) repo.setTool(tool, behavior);
  repo.installTools(tools);
  if (!plain) {
    repo.write('base.txt', 'base\n');
    repo.commit('base');
    repo.baseSha = repo.head();
  }
  return repo;
}
