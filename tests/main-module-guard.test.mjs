// Tests for the "run as a script" check at the bottom of the CLI and hook files: it must still be true when the file is reached through a
// symlink. The owner's ~/.claude is a symlink to this repo's home/, so a check without realpathSync made git-tidy and other
// CLI files silently do nothing (exit 0, no output).
// Exports: none (node:test file). Every run uses a temp dir for the symlink and for any state; nothing touches the real ~/.claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
// process.argv[1] handed to pathToFileURL or compared with ==, ===, != or !==, with no realpathSync around it. Fine: a bare
// `process.argv[1] &&` truthiness test, and a presence test against undefined or null (`process.argv[1] !== undefined`), since neither
// compares the path. The (?<![!=]) and (?!=) keep a partial operator match (`!=` out of `!==`) from slipping past the undefined/null check.
const UNRESOLVED_ARGV = /pathToFileURL\(\s*process\.argv\[1\]|(?<!\b(?:undefined|null)\s*)(?<![!=])[!=]==?\s*process\.argv\[1\]|process\.argv\[1\]\s*[!=]==?(?!=)(?!\s*(?:undefined|null)\b)/;
// The module's own location: as a URL, or as a native path (import.meta.filename, a C:\ drive path on Windows).
const OWN_LOCATION = /import\.meta\.(?:url|filename|dirname)\b/;

/** True when a file that reads its own location also uses process.argv[1] without realpathSync, in either operand order. */
function hasUnresolvedMainCheck(source) {
  return OWN_LOCATION.test(source) && UNRESOLVED_ARGV.test(source);
}

/** Every .mjs/.js file under `folder` (relative to the repo), skipping node_modules. */
function scriptFiles(folder) {
  return readdirSync(join(REPO, folder), { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : scriptFiles(path);
    return /\.(mjs|js)$/.test(entry.name) ? [path] : [];
  });
}

/** A temp dir holding `<name> -> <repo>/<target>`; returns the symlink path. */
function linkTo(target, name) {
  const dir = realpathSync(makeTempDir('main-guard-'));
  const link = join(dir, name);
  symlinkSync(join(REPO, target), link);
  return link;
}

test('no script under home/ or scripts/ compares import.meta.url with an unresolved process.argv[1]', () => {
  const offenders = [...scriptFiles('home'), ...scriptFiles('scripts')].filter((file) => hasUnresolvedMainCheck(readFileSync(join(REPO, file), 'utf8')));
  assert.deepEqual(offenders, [], 'wrap process.argv[1] in realpathSync, as scripts/share-check.mjs does');
});

test('the scan flags every spelling of the unresolved check and passes the resolved one', () => {
  const flagged = [
    'if (import.meta.url === pathToFileURL(process.argv[1]).href) main();',
    'if (pathToFileURL(process.argv[1]).href === import.meta.url) main();',
    'if (fileURLToPath(import.meta.url) === process.argv[1]) main();',
    'if (import.meta.filename === process.argv[1]) main();',
    'if (process.argv[1] == fileURLToPath(import.meta.url)) main();',
    // a presence test first never hides the unresolved compare after it
    'if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();',
    'if (undefined !== process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();',
    'if (process.argv[1] != null && process.argv[1] === import.meta.filename) main();',
  ];
  for (const source of flagged) assert.equal(hasUnresolvedMainCheck(source), true, source);
  const resolved = [
    'if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();',
    'if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) main();',
    'const isMain = process.argv[1] !== undefined && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));',
    'const isMain = null != process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));',
  ];
  for (const source of resolved) assert.equal(hasUnresolvedMainCheck(source), false, source);
});

test('share-check.mjs with its realpathSync taken off the argv[1] side is reported; the real file is not', () => {
  const source = readFileSync(join(REPO, 'scripts', 'share-check.mjs'), 'utf8');
  const resolvedArgv = '=== realpathSync(process.argv[1])';
  assert.ok(source.includes(resolvedArgv), 'the fixture still holds the resolved compare');
  assert.equal(hasUnresolvedMainCheck(source), false);
  assert.equal(hasUnresolvedMainCheck(source.replace(resolvedArgv, '=== process.argv[1]')), true);
});

test('git-tidy reached through a symlink to home/ still runs: an unknown command exits 2', () => {
  const link = linkTo('home', 'claude');
  const result = spawnSync(process.execPath, [join(link, 'tools', 'git-tidy', 'git-tidy.mjs'), 'bogus'], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /git-tidy: usage/);
});
