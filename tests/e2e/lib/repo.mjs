// The scratch repository of a scenario: a tiny node:test library with a local bare `origin`, and lane worktrees beside it.
// Exports: SLUG_SOURCE, SLUG_TEST, LANE_A_HEADER, LANE_B_TAIL, commitArgs(message, extra), mustGit(ctx, args, options),
// makeLibrary(ctx, options), addWorktree(ctx, name, branch), commitAll(ctx, cwd, message).
// Why: every scenario that lets Claude work, land or push needs a real repo whose only remote is a bare repo in the run root
// (owner rule: no outward action; E6 pushes only there). The bare repo is made with `git clone --bare`, so setup pushes nothing.
// `src/slug.mjs` has a header line and a last line far apart, so E7's two lanes change different hunks of one file.
// Invariants: every path is under the scenario folder; commits carry a fixed identity and no signing, so they work under the temp
// HOME and under `--real-home` alike; `testScript: false` leaves package.json without a test script (land then needs --test, E7).
// Every setup step goes through mustGit: a git step that fails throws, so the scenario ends with a FAIL line naming it instead
// of running on a repo that is not there (a missing origin read as "unchanged").
import { join } from 'node:path';
import { GIT_IDENTITY } from './home.mjs';

export const SLUG_SOURCE = `// slug-lib: turns text into a URL slug.
export const SEPARATOR = '-';

const NOT_SLUG = /[^a-z0-9]+/g;
const EDGES = /^-+|-+$/g;

function lower(text) {
  return String(text).toLowerCase().trim();
}

export function slugify(text) {
  return lower(text).replace(NOT_SLUG, SEPARATOR).replace(EDGES, '');
}
`;

export const SLUG_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slug.mjs';

test('slugify lowers the text and joins its words with a dash', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});
`;

/** E7 lane a: a new first line (the header hunk). */
export const LANE_A_HEADER = '// slug-lib: turns any text into a URL slug (lane a).';
/** E7 lane b: a new last line (the tail hunk). */
export const LANE_B_TAIL = "export const VERSION = '0.1.1';";

/** @returns {string[]} git args of a commit with the fixed identity, no signing and no hooks of the owner's git config */
export const commitArgs = (message, extra = []) => [
  '-c', `user.name=${GIT_IDENTITY.name}`, '-c', `user.email=${GIT_IDENTITY.email}`, '-c', 'commit.gpgsign=false',
  'commit', '--quiet', ...extra, '-m', message,
];

/**
 * One git setup step. @returns {{code: number, stdout: string, stderr: string}} its output
 * @throws {Error} naming the step when git did not exit 0 (a dry run always gives 0)
 */
export function mustGit(ctx, args, options = {}) {
  const out = ctx.git(args, options);
  if (out.code !== 0) throw new Error(`e2e: setup step failed: git ${args.join(' ')} (exit ${out.code ?? 'none'}): ${String(out.stderr ?? '').trim().slice(0, 160)}`);
  return out;
}

/** Commits every change of a worktree. */
export function commitAll(ctx, cwd, message) {
  mustGit(ctx, ['add', '-A'], { cwd });
  return mustGit(ctx, commitArgs(message), { cwd });
}

/**
 * @param {object} ctx the scenario context (context.mjs)
 * @param {{testScript?: boolean, readme?: string, files?: Record<string, {text: string, mode?: number}>}} options
 *   extra README lines and extra files (relative path -> text) in the first commit
 * @returns {{repo: string, origin: string}}
 */
export function makeLibrary(ctx, { testScript = true, readme = '', files = {} } = {}) {
  const { repo, origin } = ctx;
  const pkg = { name: 'slug-lib', version: '0.1.0', private: true, type: 'module', ...(testScript ? { scripts: { test: 'node --test test/' } } : {}) };
  ctx.mkdir(repo);
  mustGit(ctx, ['init', '--quiet', '-b', 'main', repo], { cwd: ctx.dir });
  ctx.write(join(repo, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  ctx.write(join(repo, 'src', 'slug.mjs'), SLUG_SOURCE);
  ctx.write(join(repo, 'test', 'slug.test.mjs'), SLUG_TEST);
  ctx.write(join(repo, 'README.md'), `# slug-lib\n\nTurns text into URL slugs.\n${readme ? `\n${readme}\n` : ''}`);
  for (const [path, { text, mode }] of Object.entries(files)) ctx.write(join(repo, path), text, { mode });
  commitAll(ctx, repo, 'chore: the slug library');
  mustGit(ctx, ['clone', '--quiet', '--bare', repo, origin], { cwd: ctx.dir });
  mustGit(ctx, ['remote', 'add', 'origin', origin], { cwd: repo });
  mustGit(ctx, ['fetch', '--quiet', 'origin'], { cwd: repo });
  mustGit(ctx, ['branch', '--quiet', '--set-upstream-to=origin/main', 'main'], { cwd: repo });
  return { repo, origin };
}

/** @returns {string} a new worktree `<scenario>/<name>` on a new branch from main */
export function addWorktree(ctx, name, branch) {
  const path = join(ctx.dir, name);
  mustGit(ctx, ['worktree', 'add', '--quiet', '-b', branch, path, 'main'], { cwd: ctx.repo });
  return path;
}
