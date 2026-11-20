// Shared fixtures for the review-tier CLI tests: a throw-away lane branch, the CLI run in it, and a prior findings file.
// Exports: CLI, lane(), priorFile(text), roundFile(report), printedFixRound(text, values).
// Invariants: every repo and file lives in its own temp folder (makeTempDir); the CLI's log goes next to the repo, never to ~/.claude.
//   `tier` and `json` complete a fix-round call (`--delta`) that names no `--lane-classes` with an EMPTY earlier round, so such a test
//   shows what the tool reads from the lane by itself; `raw` runs the arguments exactly as given (the tests of the refusals use it).
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, git, makeRepo } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

export const CLI = fileURLToPath(new URL('../home/tools/review-tier/review-tier.mjs', import.meta.url));

/**
 * A repo on a new branch `lane` plus a log file in its own temp folder.
 * @returns {{dir: string, log: string, raw: Function, tier: Function, json: Function, write: Function}} `tier(...args)` runs the CLI there
 *   (a fix round completed as the header says), `raw(...args)` runs it as given, `json(...args)` parses its `--json` output, `write(path, text)` commits one file and returns the new full sha.
 */
export function lane() {
  const dir = makeRepo();
  const log = join(dir, '..', 'review-tier.jsonl');
  const raw = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: { ...CLEAN_ENV, REVIEW_TIER_LOG: log } });
  const tier = (...args) => raw(...asFixRound(args));
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

/** A fix-round call as a lead makes it: one that names no earlier round gets an empty one (it holds no class, so it adds nothing). */
function asFixRound(args) {
  if (!args.includes('--delta') || args.includes('--lane-classes')) return args;
  return [...args, '--lane-classes', roundFile({ fileClasses: {}, classes: [] })];
}

/** A round's `--json` report as a file in its own temp folder, for `--lane-classes`. */
export function roundFile(report) {
  const path = join(realpathSync(makeTempDir('review-tier-round-')), 'round.json');
  writeFileSync(path, JSON.stringify(report));
  return path;
}

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
