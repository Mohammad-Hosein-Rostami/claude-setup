// Tests for the risk command (home/tools/risk): the classifier restored from the removed done-check (whole-word security names, the
// setup's own gates, comment-only edits, the `large` size rule, the rule file and its fallback) and the CLI around it (none, unknown,
// usage, --json, the fixed class order, a tip against a moved base).
// Cases kept from the removed tests/done-check-risk.test.mjs and done-check-record.test.mjs; the gate paths follow the new rule file
// (land, git-tidy and risk replace land-lane, road and done-check; the lead files are gone; CI, husky, .claude settings and hooks,
// CLAUDE.md and AGENTS.md are added). The replay of the 2026-11-22 ledger rows is not kept: its rows name the removed tools.
// Invariants: path cases use a scope without git (nothing is read, every class is kept); repo cases use throw-away repos in the
// temp folder; HOME is a temp folder, so nothing reads or writes the real ~/.claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, git } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const PINNED_HOME = makeTempDir('risk-tool-home-');
process.env.HOME = PINNED_HOME;
process.env.USERPROFILE = PINNED_HOME;

const { DEFAULT_RISK_RULES, loadRiskRules, parseRiskRules, riskClasses } = await import('../home/tools/risk/lib/risk.mjs');
const CLI = fileURLToPath(new URL('../home/tools/risk/risk.mjs', import.meta.url));
const RULES_FILE = new URL('../home/tools/risk/risk-rules.json', import.meta.url);
const SHIPPED = JSON.parse(readFileSync(RULES_FILE, 'utf8'));

/** The sorted class names of `files`, from a scope with no git (so no file is read and no class is switched off). */
async function classesOf(files, rules = SHIPPED, extra = []) {
  const found = await riskClasses({ top: null, git: false, base: null, files }, rules, extra);
  return [...new Set(found.map((entry) => entry.class))].sort();
}

/** Writes each `path: text` under `dir`, making folders. */
function writeFiles(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/** A throw-away repo on `main` whose first commit holds `files`; returns `{ dir, base }` (base = that commit's full id). */
function makeRiskRepo(files = { 'README.md': 'x\n' }) {
  const dir = join(realpathSync(makeTempDir('risk-tool-')), 'repo');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  writeFiles(dir, files);
  return { dir, base: commitAll(dir, 'base') };
}

function commitAll(dir, message) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-verify', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

const runRisk = (args, cwd = PINNED_HOME) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...CLEAN_ENV, HOME: PINNED_HOME } });

const SECURITY_PATHS = [
  'src/auth/login.ts', 'lib/session.ts', 'token.json', 'C:\\app\\auth\\x.ts', 'src/auth-service.ts', 'src/authMiddleware.ts',
  'app/api/oauth/callback.ts', 'lib/passwords.ts', 'src/csrf-token.ts', 'config/secrets.yaml', 'src/sessions/store.ts',
  'home/tools/account/lib/keychain-store.mjs', 'home/tools/account/lib/store.mjs', 'home/tools/account/lib/registry.mjs',
  'src/useSession.ts', 'src/sessionStore.ts', 'src/session-store.ts', 'src/refresh_token.ts', 'src/refreshToken.ts', 'src/secretManager.ts',
  'src/usePermissions.ts', 'src/RouteGuard.tsx', 'src/fileUpload.ts', 'src/auth.service.ts',
  'src/JWTService.ts', 'src/CSRFProtection.ts', 'src/CORSConfig.ts', 'src/OAUTHClient.ts', 'src/OAuth2Client.ts',
  'src/test/authServer.ts', 'src/tests/session.ts', 'src/__tests__/session.ts', 'pages/login.mdx', '.claude/agents/auth-reviewer.md',
  'home/tools/disk-free/lib/live-sessions.mjs', 'home/hooks/pre-bash-guard.mjs',
  'src/crypto.ts', 'hooks/guard.mjs', 'src/sandbox.ts', 'src/sanitize.ts', 'api/upload.ts', 'api/webhook.ts', 'src/jwt.ts', 'src/cookie.ts',
];
for (const path of SECURITY_PATHS) {
  test(`${path} is security`, async () => {
    assert.ok((await classesOf([path])).includes('security'), `classes of ${path}: ${(await classesOf([path])).join(', ') || 'none'}`);
  });
}

// A security word only inside another word, a test by its own name, or plain docs.
for (const path of ['src/author.ts', 'src/tokenizer.ts', 'src/blocked.ts', 'src/guardian.ts', 'src/authorship.ts', 'tests/auth.test.mjs',
  'src/login.spec.tsx', 'docs/session-notes.md', 'home/hooks/README.md']) {
  test(`${path} is not security`, async () => {
    assert.ok(!(await classesOf([path])).includes('security'));
  });
}

const OTHER_RISKY_PATHS = {
  data: ['prisma/migrations/001_init/migration.sql', 'db/schema.ts', 'reports/query.sql', 'prisma/seed.ts'],
  money: ['src/payment.ts', 'src/invoice.ts', 'services/bb-billing/index.ts', 'src/refund.ts', 'src/stripe.ts', 'src/wallet.ts'],
  concurrency: ['src/lock.ts', 'src/mutex.ts', 'src/semaphore.ts', 'src/job-queue.ts', 'src/worker.ts', 'src/sessionLock.ts'],
  gate: ['home/hooks/pre-bash-guard.mjs', 'home/hooks/lib/gated-folder.mjs', 'home\\hooks\\agent-budget.mjs', 'home/tools/land/land.mjs',
    'home/tools/git-tidy/git-tidy.mjs', 'home/tools/risk/risk.mjs', 'home/tools/risk/risk-rules.json', 'home/agents/tess.md',
    '.claude/agents/auth-reviewer.md', 'home/skills/qa-plan/SKILL.md', 'home/CLAUDE.md', 'home/rules/core.md', 'settings/base.json',
    '.github/workflows/ci.yml', 'web/.github/workflows/test.yaml', '.husky/pre-commit', '.claude/settings.json', '.claude/settings.local.json',
    '.claude/hooks/check.sh', 'CLAUDE.md', 'AGENTS.md', 'packages/app/CLAUDE.md'],
};
for (const [riskClass, paths] of Object.entries(OTHER_RISKY_PATHS)) {
  for (const path of paths) {
    test(`${path} is in the ${riskClass} class`, async () => {
      assert.ok((await classesOf([path])).includes(riskClass), `classes of ${path}: ${(await classesOf([path])).join(', ') || 'none'}`);
    });
  }
}

for (const path of ['home/lead.md', 'home/tools/done-check/lib/scope.mjs', 'home/tools/road/road.mjs', 'docs/claude-notes.md']) {
  test(`${path} is no longer gate`, async () => {
    assert.ok(!(await classesOf([path])).includes('gate'));
  });
}

for (const path of ['src/checkout/cart.ts', 'home/tools/done-check/lib/ledger.mjs', 'home/hooks/lib/stale-checkout.mjs', 'src/git checkout.ts']) {
  test(`${path} is not money`, async () => {
    assert.ok(!(await classesOf([path])).includes('money'));
  });
}

const QUIET_CHANGES = {
  'tests only': ['tests/timed-ask.test.mjs', 'tests/main-module-guard.test.mjs'],
  'plain docs': ['home/project-notes/demo-web-ui.md', 'home/hooks/lib/README.md', 'docs/token-optimization.md', 'notes/session.txt'],
  'tests named for security words': ['tests/auth.test.mjs', 'src/auth/login.test.ts', 'test/token.spec.js', 'src/__tests__/session.test.tsx'],
  'ordinary source files': ['src/components/Button.tsx', 'src/utils/format.ts', 'src/pages/home.tsx'],
  'no file at all': [],
};
for (const [name, files] of Object.entries(QUIET_CHANGES)) {
  test(`a change of ${name} has no risk class`, async () => {
    assert.deepEqual(await classesOf(files), []);
  });
}

test('one file can be in two classes, and a class a caller adds by name is always there', async () => {
  assert.deepEqual(await classesOf(['src/payment/webhook.ts']), ['money', 'security']);
  assert.deepEqual(await classesOf(['src/utils/format.ts'], SHIPPED, ['security', 'audit']), ['audit', 'security']);
});

test('a change to the rule texts only is gate', async () => {
  assert.deepEqual(await classesOf(['home/agents/dev.md', 'home/project-notes/demo-web-ui.md', 'home/rules/principles.md', 'tests/x.test.mjs']), ['gate']);
});

test('the built-in defaults equal the shipped rule file', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(DEFAULT_RISK_RULES)), SHIPPED);
  assert.deepEqual(parseRiskRules(readFileSync(RULES_FILE, 'utf8')), SHIPPED);
  assert.deepEqual(SHIPPED.large, { lines: 400, files: 15 });
});

const VERSION_1 = {
  version: 1,
  classes: { security: { paths: ['auth', 'login', 'session', 'token', 'secret', 'credential', 'passw', 'crypto', 'permission', 'guard'] }, gate: { paths: ['^home/hooks/'] } },
  large: { lines: 400, files: 15 },
};

test('a version 1 rule file still reads and keeps its substring meaning, with nothing left out', async () => {
  const file = join(makeTempDir('risk-tool-v1-'), 'risk-rules.json');
  writeFileSync(file, JSON.stringify(VERSION_1));
  const { rules, warning } = loadRiskRules(file);
  assert.equal(warning, null);
  assert.deepEqual(rules, VERSION_1);
  assert.deepEqual(await classesOf(['home/tools/disk-free/lib/live-sessions.mjs'], rules), ['security']);
  assert.deepEqual(await classesOf(['tests/auth.test.mjs'], rules), ['security']);
  assert.deepEqual(await classesOf(['home/hooks/README.md'], rules), ['gate']);
});

const BAD_RULES = {
  'a version 3 file': { ...SHIPPED, version: 3 },
  'an unknown class key': { ...SHIPPED, classes: { security: { word: ['auth'] } } },
  'a class with no list': { ...SHIPPED, classes: { security: {} } },
  'a bad leftOut pattern': { ...SHIPPED, leftOut: ['('] },
  'a bad keep pattern': { ...SHIPPED, keep: ['('] },
  'a bad word pattern': { ...SHIPPED, classes: { security: { words: ['('] } } },
  'a version 1 class without paths': { ...VERSION_1, classes: { security: { words: ['auth'] } } },
};
for (const [name, rules] of Object.entries(BAD_RULES)) {
  test(`${name} is refused, and loading it falls back to the built-in rules`, () => {
    assert.throws(() => parseRiskRules(JSON.stringify(rules)), /^Error: risk rules: |SyntaxError/);
    const file = join(makeTempDir('risk-tool-bad-'), 'risk-rules.json');
    writeFileSync(file, JSON.stringify(rules));
    const loaded = loadRiskRules(file);
    assert.equal(loaded.rules, DEFAULT_RISK_RULES);
    assert.match(loaded.warning, /^risk rules not used, built-in defaults apply: /);
  });
}

// A file in the money class (by its path) whose lines change in different ways: only comments and blank lines leave the class.
const BILLING_FILE = 'services/bb-billing/src/state.ts';
const BILLING_SOURCE = ['// Billing state.', '/**', ' * Charges one invoice.', ' */', 'export function charge(amount: number) {', '  return amount * 2;', '}', ''].join('\n');

/** The classes of a billing edit, read from the worktree (uncommitted) and from a commit (the tip), which must agree. */
async function billingClassesAfter(change) {
  const repo = makeRiskRepo({ [BILLING_FILE]: BILLING_SOURCE });
  writeFiles(repo.dir, { [BILLING_FILE]: change(BILLING_SOURCE) });
  const scope = { top: repo.dir, git: true, base: repo.base, files: [BILLING_FILE] };
  const inWorktree = (await riskClasses(scope, SHIPPED)).map((entry) => entry.class);
  const tip = commitAll(repo.dir, 'edit');
  writeFiles(repo.dir, { [BILLING_FILE]: BILLING_SOURCE.replace('amount * 2', 'amount * 9') }); // the worktree differs from the tip
  const atTip = (await riskClasses({ ...scope, tip }, SHIPPED)).map((entry) => entry.class);
  assert.deepEqual(atTip, inWorktree, 'the tip and the worktree read the same edit alike');
  return inWorktree;
}
const COMMENT_ONLY_EDITS = {
  'a reworded line comment': (text) => text.replace('// Billing state.', '// Billing state, reworded.'),
  'a reworded doc comment line': (text) => text.replace(' * Charges one invoice.', ' * Charges one invoice, once.'),
  'a new comment line': (text) => text.replace('export function', '// Doubles the amount.\nexport function'),
  'a prose line without a star inside a block comment': (text) => text.replace(' */', ' prose without a star\n */'),
  'blank lines': (text) => text.replace('}\n', '}\n\n\n'),
};
for (const [name, change] of Object.entries(COMMENT_ONLY_EDITS)) {
  test(`billing code with ${name} only is not money`, async () => {
    assert.deepEqual(await billingClassesAfter(change), []);
  });
}
const CODE_EDITS = {
  'a changed return': (text) => text.replace('amount * 2', 'amount * 3'),
  'a trailing comment added to a code line': (text) => text.replace('return amount * 2;', 'return amount * 2; // double'),
  'a code line next to a comment edit': (text) => text.replace('// Billing state.', '// Billing state.\nexport const FEE = 1;'),
  'a line removed': (text) => text.replace('  return amount * 2;\n', ''),
};
for (const [name, change] of Object.entries(CODE_EDITS)) {
  test(`billing code with ${name} is still money`, async () => {
    assert.deepEqual(await billingClassesAfter(change), ['money']);
  });
}

test('a billing file the change cannot be read for (no base) keeps its class', async () => {
  assert.deepEqual(await classesOf([BILLING_FILE]), ['money']);
});

const codeLines = (count) => `${Array.from({ length: count }, (_, index) => `export const v${index} = ${index};`).join('\n')}\n`;

/** The classes of `files` written into a fresh repo after its base commit (uncommitted, so read from the worktree). */
async function classesAfterWriting(files) {
  const repo = makeRiskRepo({ 'src/big.ts': 'export const first = 1;\n' });
  writeFiles(repo.dir, files);
  return (await riskClasses({ top: repo.dir, git: true, base: repo.base, files: Object.keys(files) }, SHIPPED)).map((entry) => entry.class);
}

test('more than 400 changed lines of code are large, 400 are not; of tests or docs they never are', async () => {
  assert.deepEqual(await classesAfterWriting({ 'src/big.ts': `export const first = 1;\n${codeLines(400)}` }), []);
  assert.deepEqual(await classesAfterWriting({ 'src/big.ts': `export const first = 1;\n${codeLines(401)}` }), ['large']);
  assert.deepEqual(await classesAfterWriting({ 'src/test/helper.ts': codeLines(401) }), ['large']);
  assert.deepEqual(await classesAfterWriting({ 'tests/big.test.mjs': codeLines(500) }), []);
  assert.deepEqual(await classesAfterWriting({ 'docs/big.md': codeLines(500) }), []);
  assert.deepEqual(await classesAfterWriting({ 'home/rules/core.md': codeLines(401) }), ['gate', 'large']);
});

test('more than 15 code files are large, 15 are not; 16 test or docs files never are', async () => {
  const many = (count, make) => Array.from({ length: count }, (_, index) => make(index));
  assert.deepEqual(await classesOf(many(15, (index) => `src/part${index}.ts`)), []);
  assert.deepEqual(await classesOf(many(16, (index) => `src/part${index}.ts`)), ['large']);
  assert.deepEqual(await classesOf(many(16, (index) => `tests/part${index}.test.mjs`)), []);
  assert.deepEqual(await classesOf(many(16, (index) => `docs/part${index}.md`)), []);
});

test('CLI: an ordinary change prints risk: none with its size and exits 0', () => {
  const repo = makeRiskRepo();
  writeFiles(repo.dir, { 'src/format.ts': 'export const a = 1;\nexport const b = 2;\n' });
  const tip = commitAll(repo.dir, 'format');
  const result = runRisk(['--base', repo.base, '--tip', tip, '--repo', repo.dir]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'risk: none (2 lines, 1 files)\n');
});

test('CLI: classes come in the fixed order, uncommitted and untracked files count without --tip, and --json lists each file', () => {
  const repo = makeRiskRepo();
  writeFiles(repo.dir, { 'home/hooks/x.mjs': 'export {};\n', 'src/lock.ts': 'export {};\n', 'src/auth.ts': 'export {};\n' });
  const result = runRisk(['--base', 'main'], repo.dir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'risk: security, concurrency, gate (3 lines, 3 files)\n');
  const json = JSON.parse(runRisk(['--base', 'main', '--json'], repo.dir).stdout);
  assert.deepEqual(json, { classes: [{ class: 'security', file: 'src/auth.ts' }, { class: 'concurrency', file: 'src/lock.ts' }, { class: 'gate', file: 'home/hooks/x.mjs' }], lines: 3, files: 3 });
});

test('CLI: a tip is compared with its merge base, so new commits on the base branch are not the change', () => {
  const repo = makeRiskRepo();
  git(repo.dir, 'switch', '-q', '-c', 'lane');
  writeFiles(repo.dir, { 'src/format.ts': 'export const a = 1;\n' });
  commitAll(repo.dir, 'lane work');
  git(repo.dir, 'switch', '-q', 'main');
  writeFiles(repo.dir, { 'src/payment.ts': 'export const fee = 1;\n' });
  commitAll(repo.dir, 'main moved on');
  const result = runRisk(['--base', 'main', '--tip', 'lane', '--repo', repo.dir]);
  assert.equal(result.stdout, 'risk: none (1 lines, 1 files)\n');
});

test('CLI: a bad revision or a folder that is not a repository is unknown and exits 1', () => {
  const repo = makeRiskRepo();
  const badRevision = runRisk(['--base', 'nope', '--repo', repo.dir]);
  assert.equal(badRevision.status, 1);
  assert.match(badRevision.stdout, /^risk: unknown \(no commit named "nope"\)\n$/);
  const optionLike = runRisk(['--base', repo.base, '--tip=--output=x', '--repo', repo.dir]);
  assert.equal(optionLike.status, 1);
  assert.match(optionLike.stdout, /^risk: unknown \(not a revision: /);
  const notRepo = runRisk(['--base', 'HEAD', '--repo', makeTempDir('risk-tool-plain-')]);
  assert.equal(notRepo.status, 1);
  assert.match(notRepo.stdout, /^risk: unknown \(git rev-parse failed: /);
});

test('CLI: no --base, an unknown option or a stray word is a usage error, exit 2, nothing on stdout', () => {
  for (const args of [[], ['--tip', 'HEAD'], ['--base', 'HEAD', '--bogus'], ['--base', 'HEAD', 'extra'], ['--base']]) {
    const result = runRisk(args);
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^usage: node ~\/\.claude\/tools\/risk\/risk\.mjs --base <rev>/);
  }
});
