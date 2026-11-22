// Tests for review-tier round 5 (lane R1): the `gate` class, the read/write/delete/credential line rules and the principles field.
// Fabricated diffs go to buildReport (no git); the acceptance test at the end runs the CLI on the two real fix commits of the replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport } from '../home/tools/review-tier/lib/report.mjs';
import { PRINCIPLES_BY_TRIGGER } from '../home/tools/review-tier/tiers.mjs';
import { CLEAN_ENV, commit, git, makeRepo } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const changed = (path, added = [], removed = []) => ({
  path,
  added: added.map((text, index) => ({ line: index + 1, text })),
  removed: removed.map((text, index) => ({ line: index + 1, text })),
});

function report(files, options = {}) {
  return buildReport({
    files, readNewFile: () => null, landing: false, addClasses: [], laneClasses: null, range: 'main...HEAD', deltaOf: null, requiredReading: [], ...options,
  });
}

const codeLine = (text) => report([changed('home/tools/x/x.mjs', [text])]);

// One path per alternative of GATE_PATH (spec section 7), upper case kept where a real file has it.
const GATE_PATHS = [
  'settings/base.json', 'proj/.claude/settings.local.json', 'home/CLAUDE.md', 'home/lead-rules.md', 'home/agents/reviewer.md',
  'home/rules/core.md', 'home/workflows/review.js', 'home/skills/workflows/SKILL.md', 'home/skills/verify-done/SKILL.md',
  'home/tools/review-tier/tiers.mjs', 'home/tools/test-pass/test-pass.mjs', 'home/tools/git-tidy/lib/git.mjs',
  'scripts/affected-tests.mjs', 'scripts/doctor.sh', '.githooks/pre-push', 'app/.githooks/pre-commit', 'proj/.claude/workflows/x.js',
  '.husky/pre-commit', '.github/workflows/ci.yml', '.gitlab-ci.yml', '.circleci/config.yml', 'azure-pipelines.yml', 'Jenkinsfile',
  'package.json', 'apps/web/package.json', 'tsconfig.json', 'apps/web/tsconfig.build.json', 'eslint.config.js', '.eslintrc.cjs',
  'vitest.config.ts', 'vitest.workspace.ts', 'jest.config.js', 'playwright.config.ts',
];

for (const path of GATE_PATHS) {
  test(`gate class: ${path}`, () => {
    const result = report([changed(path, ['x'])]);
    assert.ok(result.classes.includes('gate'), `${path}: ${result.classes}`);
    assert.ok(result.tier >= 1);
    assert.ok(!result.reviews.some((review) => review.model === 'opus'), 'gate is tier 1, not risky: no Opus lens mid-lane');
  });
}

test('gate class applies to a docs file too, and lifts it from tier 0 to tier 1', () => {
  const result = report([changed('home/tools/review-tier/README.md', ['# title'])]);
  assert.ok(result.classes.includes('gate'));
  assert.equal(result.tier, 1);
});

// spec-accounts (lane r9-accounts): the account tool and the shell snippets hold login tokens, so a later edit there is
// never waived (gate) and always gets the security set (an Opus lens), whatever its lines say.
test('the account tool and the shell snippets are gate and security: never waived, always an Opus lens', () => {
  for (const path of ['home/tools/account/account.mjs', 'home/tools/account/lib/store.mjs', 'home/shell/claude-as.sh', 'home/shell/claude-as.ps1']) {
    const result = report([changed(path, ['x'])]);
    assert.ok(result.classes.includes('gate'), `${path}: ${result.classes}`);
    assert.ok(result.classes.includes('security'), `${path}: ${result.classes}`);
    assert.equal(result.tier, 2, path);
    assert.ok(result.reviews.some((review) => review.model === 'opus'), `${path}: an Opus lens`);
  }
  // Security review 1, S8: the hook child's login and the tests that guard the token are the same class.
  for (const path of ['home/tools/recall/lib/claude-call.mjs', 'tests/account-keychain.test.mjs', 'tests/account-helpers.mjs', 'tests/claude-call.test.mjs']) {
    const result = report([changed(path, ['const withoutToken = (text) => text;'])]);
    assert.ok(result.classes.includes('security') && result.classes.includes('gate'), `${path}: ${result.classes}`);
    assert.ok(result.reviews.some((review) => review.model === 'opus'), `${path}: an Opus lens`);
  }
  const readme = report([changed('home/tools/account/README.md', ['# title'])]);
  assert.ok(readme.classes.includes('gate'), 'its README is gate too, so a docs-only edit is not waived');
  assert.ok(readme.tier >= 1);
});

test('gate class: other skills, docs and plain source are not gate', () => {
  for (const path of ['home/skills/other/SKILL.md', 'home/skills/wf/SKILL.md', 'docs/x.md', 'src/a.ts', 'home/tools/estimate/estimate.mjs', 'settings/sub/x.json']) {
    assert.ok(!report([changed(path, ['x'])]).classes.includes('gate'), path);
  }
});

test('gate hit is named in `hits` with line 0', () => {
  assert.deepEqual(report([changed('package.json', ['x'])]).hits.filter((hit) => hit.class === 'gate'), [{ class: 'gate', path: 'package.json', line: 0 }]);
});

// Line rules (L3): one positive and one negative each.
test('read rule: a read call with a non-trusted first argument is untrusted-input; a literal or trusted root is not', () => {
  for (const line of [
    'readFileSync(file, "utf8")', 'await readFile(p)', 'createReadStream(p)', 'readSync(fd, buffer, 0, 8, 0)', 'readdirSync(folder, { withFileTypes: true })',
    'opendirSync(dir)', 'readlinkSync(link)', 'fs.promises.readdir(dir)',
  ]) assert.ok(codeLine(line).classes.includes('untrusted-input'), line);
  for (const line of ['readFileSync("a.txt", "utf8")', 'readFileSync(__filename)', 'readdirSync(homedir())', 'readFileSync(import.meta.url)', 'const readFileSyncName = 1;']) {
    assert.ok(!codeLine(line).classes.includes('untrusted-input'), line);
  }
});

test('read rule: only the first argument is judged (a trusted path with a variable encoding is not a hit)', () => {
  assert.ok(!codeLine('readFileSync(__filename, encoding)').classes.includes('untrusted-input'));
  assert.ok(codeLine('readFileSync(file, "utf8")').classes.includes('untrusted-input'));
});

test('read rule: a call whose arguments go on to the next line counts as a hit', () => {
  assert.ok(codeLine('readFileSync(').classes.includes('untrusted-input'));
});

test('write rule: a write call with a non-literal first argument is data; a literal target is not', () => {
  for (const line of [
    'writeFileSync(path, text)', 'await appendFile(log, line)', 'createWriteStream(out)', 'copyFileSync(a, b)', 'cpSync(a, b, { recursive: true })',
    'renameSync(a, b)', 'symlinkSync(target, link)', 'mkdirSync(join(dir, "x"))', 'await cp(src, dest)', 'writeFileSync(__dirname, text)', 'mkdirSync(homedir())',
  ]) assert.ok(codeLine(line).classes.includes('data'), line);
  for (const line of ['writeFileSync("out.txt", text)', "appendFileSync('a.log', line)", 'mkdirSync("tmp", { recursive: true })', 'cpSync("a", b)']) {
    assert.ok(!codeLine(line).classes.includes('data'), line);
  }
});

test('write rule: --state-dir (the store override of principle P8) is data; an unrelated word is not', () => {
  assert.ok(codeLine("const dir = values['state-dir'];").classes.includes('data'));
  assert.ok(codeLine('const options = { stateDir: store };').classes.includes('data'));
  assert.ok(!codeLine('const statement = 1;').classes.includes('data'));
});

test('delete rule: rm, unlink, rmdir and destructive git or shell commands are data; their safe forms are not', () => {
  for (const line of [
    'rmSync(dir, { recursive: true })', 'await rm(p)', 'unlinkSync("a")', 'rmdirSync("d")', "run('rm -rf build')", 'rm -f x', 'git branch -D old', 'git worktree remove ../wt',
    'git reset --hard HEAD', 'git clean -fd', 'git push --force', 'git push origin main -f', 'git push --force-with-lease',
  ]) assert.ok(codeLine(line).classes.includes('data'), line);
  for (const line of ['git branch -d merged', 'git worktree list', 'git reset --soft HEAD~1', 'git clean -n', 'git push origin main', 'rm file.txt', 'const form = 1;', 'git status']) {
    assert.ok(!codeLine(line).classes.includes('data'), line);
  }
});

test('credential rule: tokens, credentials, private keys, .env and keychain are security; a bare word is not', () => {
  for (const line of [
    'const accessToken = x;', 'GITHUB_TOKEN', 'npm-token', 'refresh_tokens', 'bearer-token', 'const credentials = load();', 'private_key', 'privateKey', 'readEnv(".env")', 'keychain.get()',
    'OAuth_Token', 'api-tokens',
  ]) assert.ok(codeLine(line).classes.includes('security'), line);
  for (const line of ['const tokens = tokenize(text);', 'const environment = 1;', 'const key = 1;', 'tokenCount += 1;']) {
    assert.ok(!codeLine(line).classes.includes('security'), line);
  }
});

test('credential rule: a `.env` file is security; process.env, a spread env and import.meta.env are ordinary code', () => {
  for (const line of ["join(dir, '.env.local')", 'cat .env', 'const file = `${root}/.env`;', "readFileSync('prod.env')", 'load("config/docker.env")']) assert.ok(codeLine(line).classes.includes('security'), line);
  for (const line of ['const quiet = process.env.QUIET === "1";', 'const merged = { ...env, A: 1 };', 'const mode = import.meta.env.MODE;', 'const home = options.env.HOME;']) {
    assert.ok(!codeLine(line).classes.includes('security'), line);
  }
});

test('line rules never read a tests file, a doc or a prose file', () => {
  for (const path of ['tests/x.test.mjs', 'docs/x.md', 'README.md', 'notes.txt']) {
    const result = report([changed(path, ['rmSync(dir);', 'writeFileSync(p, t);', 'readFileSync(p);', 'const accessToken = 1;'])]);
    assert.ok(!['data', 'security', 'untrusted-input'].some((name) => result.classes.includes(name)), path);
  }
});

// A pure rename has no hunk, so the old path (the gate file that stopped being one) must be read as changed too.
test('gate class: a pure rename of a gate file away from its name is still a gate change and not waivable', () => {
  const dir = makeRepo();
  commit(dir, 'tsconfig.json', '{ "compilerOptions": { "strict": true } }\n');
  git(dir, 'checkout', '-q', '-b', 'lane');
  git(dir, 'mv', 'tsconfig.json', 'tsconfig.json.off');
  git(dir, 'commit', '-q', '-m', 'switch the type check off');
  const env = { ...CLEAN_ENV, REVIEW_TIER_LOG: join(dir, '..', 'review-tier.jsonl') };
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../home/tools/review-tier/review-tier.mjs', import.meta.url)), '--landing', '--json'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.ok(result.classes.includes('gate'));
  assert.equal(result.waivable, null);
});

// principles field
const principles = (path, lines) => report([changed(path, lines)]).principles;

test('principles: read -> P1,P5; write -> P7,P8; delete -> P2,P8; sorted by number and unique', () => {
  assert.deepEqual(principles('src/a.mjs', ['readFileSync(p)']), ['P1', 'P12', 'P5'].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
  assert.deepEqual(principles('src/a.mjs', ['writeFileSync(p, t)']), ['P7', 'P8']);
  assert.deepEqual(principles('src/a.mjs', ['rmSync(p)']), ['P2', 'P8']);
  assert.deepEqual(principles('src/a.mjs', ['writeFileSync(p, t)', 'rmSync(p)']), ['P2', 'P7', 'P8']);
});

test('principles: git in a security hit -> P2; a security hit without git adds none', () => {
  assert.ok(principles('src/a.mjs', ["spawnSync('git', args)"]).includes('P2'));
  assert.deepEqual(principles('src/a.mjs', ['spawnSync(cmd)']), []);
});

test('principles: a gate path -> P3, a hooks path -> P1,P9, untrusted-input -> P5,P12, a timer hit -> P9', () => {
  assert.deepEqual(principles('package.json', ['x']), ['P3']);
  assert.deepEqual(principles('home/hooks/stop.mjs', ['const a = 1;']), ['P1', 'P9']);
  assert.deepEqual(principles('src/a.mjs', ['const body = req.body;']), ['P5', 'P12']);
  assert.deepEqual(principles('src/a.mjs', ['setTimeout(fn, 5);']), ['P9']);
  assert.deepEqual(principles('src/a.mjs', ['setInterval(fn, 5);']), ['P9']);
});

test('principles: none for plain logic, and every id in the table has the form P<number>', () => {
  assert.deepEqual(principles('src/a.mjs', ['const total = a + b;']), []);
  for (const ids of Object.values(PRINCIPLES_BY_TRIGGER)) for (const id of ids) assert.match(id, /^P[1-9]\d*$/);
});

// Acceptance: items 71 and 73 of the defect replay were tier 1 (both fixes landed with the full set missing its Opus lens).
const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = fileURLToPath(new URL('../home/tools/review-tier/review-tier.mjs', import.meta.url));

// Full shas: a side of a range is HEAD, a local branch or a full sha, never a short name another ref could shadow.
for (const [item, commit] of [[71, '9ef7c21c331d848d7e233853b026b59ccbb86d42'], [73, 'c55d28f467ff3157d699562549ca65b5abe16fd2']]) {
  test(`acceptance: replay item ${item} (${commit.slice(0, 7)}) is tier 2 at its fix commit`, () => {
    const home = makeTempDir('review-tier-home-');
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, REVIEW_TIER_LOG: join(home, 'review-tier.jsonl') };
    const run = spawnSync(process.execPath, [CLI, `${commit}^..${commit}`, '--landing', '--json'], { cwd: REPO, encoding: 'utf8', env });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).tier, 2);
  });
}
