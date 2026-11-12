// PreToolUse(Write|Edit|MultiEdit) guard for the `test-writer` agent: it may create or edit test files only.
// Allows a path whose basename is `*.test.*`, `*.spec.*`, `*_test.*`, `*_spec.*`, `test_*.*`, PascalCase
// `*Test.*`/`*Tests.*`/`*Spec.*`/`*IT.*`, `conftest.py`, `setupTests.*` or `vitest|jest.setup.*`, or that sits under a
// directory named test(s), spec(s), __tests__, __mocks__, e2e, fixtures, __fixtures__ or testdata (any case). The path is resolved against cwd first, so a `..`
// escape is judged by where it lands. Directory rules apply only inside cwd; outside cwd only a test-style basename
// passes. Any path with a `node_modules` segment is denied. Fails closed: input it cannot read is denied. Deny = exit 2 + reason on stderr.
import { isAbsolute, relative, resolve, basename, dirname, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const TEST_BASENAME = [
  /^.+\.(test|spec)\..+$/,
  /^.+_(test|spec)\..+$/,
  /^test_.+\..+$/,
  /^[A-Z]\w*(Test|Tests|Spec|IT)\.\w+$/, // JUnit, xUnit/NUnit, ScalaTest, failsafe
  /^conftest\.py$/,
  /^setupTests\.[cm]?[jt]sx?$/,
  /^(vitest|jest)\.setup\.[cm]?[jt]sx?$/,
];
// Compared lowercased, so `Tests/` and `__Mocks__/` match too.
const TEST_DIRS = new Set(['test', 'tests', 'spec', 'specs', '__tests__', '__mocks__', 'e2e', 'fixtures', '__fixtures__', 'testdata']);

/**
 * Whether a write target is a test file or lives in a test directory.
 * @param {unknown} filePath - `tool_input.file_path` from the hook JSON.
 * @param {string} cwd - directory relative paths resolve against.
 * @returns {boolean} true only for a non-empty string path that matches a test pattern after resolution
 *   (basename anywhere; test directory only inside cwd) and has no `node_modules` segment.
 */
export function isTestPath(filePath, cwd) {
  if (typeof filePath !== 'string' || filePath === '') return false;
  const target = resolve(cwd, filePath);
  if (target.split(sep).some((segment) => segment.toLowerCase() === 'node_modules')) return false;
  if (TEST_BASENAME.some((pattern) => pattern.test(basename(target)))) return true;
  // Directory segments count only inside cwd, so a `tests` folder in the parent path of the project (or an escape
  // out of the project) does not make the target writable.
  const rel = relative(cwd, target);
  const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  if (!inside) return false;
  return dirname(rel).split(sep).some((segment) => TEST_DIRS.has(segment.toLowerCase()));
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    input = undefined; // unreadable hook input: falls through to the deny below
  }
  const cwd = typeof input?.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd();
  if (isTestPath(input?.tool_input?.file_path, cwd)) return;
  process.stderr.write('Blocked by test-files-only: this agent may write test files only (*.test.*, *.spec.*, *_test.*, FooTest.*, tests/, spec/, __tests__/, __mocks__/, e2e/, fixtures/)\n');
  process.exitCode = 2;
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
