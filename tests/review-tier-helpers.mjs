// Shared fixtures for the review-tier CLI tests: a throw-away lane branch, the CLI run in it, and a prior findings file.
// Exports: CLI, lane(), priorFile(text), laneNamesOf(report), sha256Of(path), printedFixRound(text, values).
// Invariants: every repo and file lives in its own temp folder (makeTempDir); the CLI's log goes next to the repo, never to ~/.claude.
//   `tier` and `json` complete a fix-round call (`--delta`) the way a lead's record would: each `--prior` gets the hash of the file as it
//   is, a call that names no `--base` gets the sha of the repo's trunk branch (main, else master), and a call that names no
//   `--lane-classes` gets `docs`, the one name that raises no set (so such a test shows what the tool reads from the lane by itself);
//   `raw` runs the arguments exactly as given (the tests of the refusals use it).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, git, makeRepo } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

export const CLI = fileURLToPath(new URL('../home/tools/review-tier/review-tier.mjs', import.meta.url));
const RUN_TIMEOUT_MS = 120_000; // a run that hangs (a FIFO read, a git prompt) fails its test instead of stopping the suite

/**
 * A repo on a new branch `lane` plus a log file in its own temp folder.
 * @returns {{dir: string, log: string, raw: Function, tier: Function, json: Function, write: Function}} `tier(...args)` runs the CLI there
 *   (a fix round completed as the header says), `raw(...args)` runs it as given, `json(...args)` parses its `--json` output, `write(path, text)` commits one file and returns the new full sha.
 */
export function lane() {
  const dir = makeRepo();
  const log = join(dir, '..', 'review-tier.jsonl');
  const raw = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, env: { ...CLEAN_ENV, REVIEW_TIER_LOG: log } });
  const tier = (...args) => raw(...asFixRound(dir, args));
  const json = (...args) => JSON.parse(tier(...args, '--json').stdout);
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
    git(dir, 'add', '--', path);
    git(dir, 'commit', '-q', '-m', `edit ${path}`);
    return git(dir, 'rev-parse', 'HEAD');
  };
  git(dir, 'checkout', '-q', '-b', 'lane');
  return { dir, log, raw, tier, json, write };
}

/** The sha of the repo's trunk branch (main, else master), or null when it has neither. */
function trunkSha(dir) {
  for (const name of ['main', 'master']) {
    const found = spawnSync('git', ['show-ref', '--verify', '--hash', `refs/heads/${name}`], { cwd: dir, encoding: 'utf8', env: CLEAN_ENV });
    if (found.status === 0) return found.stdout.trim();
  }
  return null;
}

/**
 * A fix-round call as a lead makes it from its record: every `--prior <file>` with no `--prior-sha256` after it gets the hash of the
 * file as it is now (a file that cannot be read gets a hash of zeros, the tool reports the read error first); a call with no `--base`
 * gets the trunk's sha, and one with no `--lane-classes` gets `docs` (see the header).
 */
function asFixRound(dir, args) {
  if (!args.includes('--delta')) return args;
  const completed = args.flatMap((arg, index) => (args[index - 1] === '--prior' && args[index + 1] !== '--prior-sha256' ? [arg, '--prior-sha256', sha256Of(arg)] : [arg]));
  const base = completed.includes('--base') ? completed[completed.indexOf('--base') + 1] : trunkSha(dir);
  if (base === null) return completed;
  const based = completed.includes('--base') ? completed : [...completed, '--base', base];
  return based.includes('--lane-classes') ? based : [...based, '--lane-classes', 'docs'];
}

/** The sha256 of a file as a lead records it (lower-case hex); 64 zeros for a path that cannot be read. */
export function sha256Of(path) {
  try {
    return createHash('sha256').update(readFileSync(resolve(path))).digest('hex');
  } catch {
    return '0'.repeat(64);
  }
}

/** What a lead passes as `--lane-classes` after a round: the names that round's report holds (`laneClasses`), comma-separated. */
export const laneNamesOf = (report) => report.laneClasses.join(',');

/**
 * The arguments of the `fix round:` line a run printed (its last line), with each `<placeholder>` replaced: what a lead who copies the
 * line runs for the next round. A placeholder with no value fails the test.
 * @param {string} text the text output of the round before
 * @param {Object<string, string>} values placeholder name (without the angle brackets) -> value
 * @returns {string[]} the arguments after the script path
 */
export function printedFixRound(text, values) {
  const line = text.trimEnd().split('\n').at(-1);
  const words = line.split(' ');
  if (words[0] !== 'fix' || words[1] !== 'round:' || !words[3].endsWith('review-tier.mjs')) throw new Error(`no fix round line: ${line}`);
  return words.slice(4).map((word) => {
    const name = /^<(.+)>$/.exec(word)?.[1];
    if (name !== undefined && values[name] === undefined) throw new Error(`the fix round line asks for <${name}>, the test gives none`);
    return name === undefined ? word : values[name];
  });
}

/** The review report of the previous round, in its own temp folder (a plain path: no symlink, no space). */
export function priorFile(text = '| F1 | should-fix | src/run.mjs:2 | spawn without a shell option | pass shell: false |\n') {
  const path = join(realpathSync(makeTempDir('review-tier-prior-')), 'findings-round1.md');
  writeFileSync(path, text);
  return path;
}
