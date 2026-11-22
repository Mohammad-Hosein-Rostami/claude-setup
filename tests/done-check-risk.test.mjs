// Tests for the done-check's risk classes by path segment (home/tools/done-check/lib/risk.mjs and risk-rules.json, road solid lane
// dc-risk). The old rules matched security words anywhere in a path, so `session-notes`, `token-view` and `main-module-guard.test.mjs`
// were security and 113 of 141 stops said `review: needed`. Fixed here:
// - F1: real login and secret paths stay security (a folder, a file name, a word of a name, a Windows path);
// - F2: the setup's own hooks and gate tools stay `gate`; today's real risky lanes (guard lib, done-check scope, road gate, account store)
//   stay flagged;
// - F3: a version 1 rule file still reads and keeps its old meaning;
// - tests and docs never put a change in a class, nor count for `large`;
// - the replay: the file lists of the first 82 setup-repo ledger rows of 2026-11-22 (tests/fixtures/done-check/ledger-rows-2026-11-22.json,
//   rebuilt from git as its README says) flag security on at most 5 rows.
// Invariants: path cases use a scope without git (nothing is read, every class is kept); the size cases use a fixture repo in a temp
// folder; HOME is pinned to a temp folder, so nothing reads or writes the real ~/.claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeDoneCheckRepo } from './done-check-fixture.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const PINNED_HOME = makeTempDir('done-check-risk-home-');
process.env.HOME = PINNED_HOME;
process.env.USERPROFILE = PINNED_HOME;

const { DEFAULT_RISK_RULES, loadRiskRules, parseRiskRules, riskClasses } = await import('../home/tools/done-check/lib/risk.mjs');
const RULES_FILE = new URL('../home/tools/done-check/risk-rules.json', import.meta.url);
const SHIPPED = JSON.parse(readFileSync(RULES_FILE, 'utf8'));
const LEDGER_ROWS = JSON.parse(readFileSync(new URL('./fixtures/done-check/ledger-rows-2026-11-22.json', import.meta.url), 'utf8'));
const MAX_SECURITY_ROWS = 5; // the lane's acceptance line
const NO_SHA = 'f'.repeat(64);

/** The sorted class names of `files` under `rules`, from a scope with no git (so no file is read and no class is switched off). */
async function classesOf(files, rules = SHIPPED) {
  const found = await riskClasses({ top: null, git: false, base: null, files, wide: [], key: NO_SHA }, rules);
  return [...new Set(found.map((entry) => entry.class))].sort();
}

const SECURITY_PATHS = [
  'src/auth/login.ts', 'lib/session.ts', 'token.json', 'C:\\app\\auth\\x.ts', 'src/auth-service.ts', 'src/authMiddleware.ts',
  'app/api/oauth/callback.ts', 'lib/passwords.ts', 'src/csrf-token.ts', 'config/secrets.yaml', 'src/sessions/store.ts',
  'home/tools/account/lib/keychain-store.mjs', 'home/tools/account/lib/store.mjs', 'home/tools/account/lib/registry.mjs',
];
for (const path of SECURITY_PATHS) {
  test(`${path} is security`, async () => {
    assert.ok((await classesOf([path])).includes('security'), `classes of ${path}: ${(await classesOf([path])).join(', ') || 'none'}`);
  });
}

// Names in which a security word is only part of a name: an LLM token viewer, Claude session notes, the Bash guard (gate by path).
const NOT_SECURITY_PATHS = [
  'home/tools/token-view/lib/summary.mjs', 'home/hooks/session-notes.mjs', 'home/hooks/pre-bash-guard.mjs', 'home/hooks/token-audit.mjs',
  'home/hooks/agent-model-guard.mjs', 'home/tools/disk-free/lib/live-sessions.mjs', 'src/author.ts', 'src/tokenizer.ts', 'src/blocked.ts',
];
for (const path of NOT_SECURITY_PATHS) {
  test(`${path} is not security`, async () => {
    assert.ok(!(await classesOf([path])).includes('security'));
  });
}

for (const path of ['home/hooks/pre-bash-guard.mjs', 'home/hooks/lib/rm-paths.mjs', 'home/hooks/commit-gate.mjs', 'home/tools/done-check/lib/scope.mjs',
  'home/tools/road/lib/road-gate.mjs', 'home/tools/land-lane/land-lane.mjs', 'home/tools/done-check/risk-rules.json']) {
  test(`${path} is gate`, async () => {
    assert.ok((await classesOf([path])).includes('gate'));
  });
}

// File lists of lanes that landed on 2026-11-22 (git diff --name-only of each landing, docs and tests included).
const REAL_RISKY_LANES = {
  'guard lib (18030d04)': { classes: ['gate'], files: ['home/hooks/lib/README.md', 'home/hooks/lib/bare-glob.mjs', 'home/hooks/lib/guard-state-write.mjs',
    'home/hooks/lib/rm-paths.mjs', 'home/hooks/lib/shell-lexer.mjs', 'home/hooks/pre-bash-guard.mjs', 'tests/pre-bash-guard-families.test.mjs'] },
  'done-check scope (9d1e58ee)': { classes: ['gate'], files: ['docs/catalog.md', 'home/hooks/lib/own-edits.mjs', 'home/tools/done-check/README.md',
    'home/tools/done-check/lib/check-change.mjs', 'home/tools/done-check/lib/scope.mjs', 'tests/done-check-scope.test.mjs'] },
  'road gate (164288cd)': { classes: ['gate'], files: ['docs/catalog.md', 'home/agents/architect.md', 'home/tools/road/lib/road-gate.mjs',
    'home/tools/road/lib/road-state.mjs', 'home/tools/road/road.mjs', 'tests/road-early.test.mjs'] },
  'account store (cb48f26d)': { classes: ['security'], files: ['home/tools/account/lib/keychain-store.mjs', 'home/tools/account/lib/registry.mjs',
    'home/tools/account/lib/store.mjs', 'tests/account-keychain.test.mjs', 'tests/account-store.test.mjs'] },
};
for (const [lane, { classes, files }] of Object.entries(REAL_RISKY_LANES)) {
  test(`the ${lane} lane is still flagged ${classes.join(', ')}`, async () => {
    assert.deepEqual(await classesOf(files), classes);
  });
}

const QUIET_LANES = {
  'tests-only (931b537b)': ['tests/timed-ask.test.mjs', 'tests/main-module-guard.test.mjs'],
  'docs-only (b5adcc96)': ['home/agents/reviewer.md', 'home/rules/principles.md', 'home/hooks/lib/README.md', 'docs/token-optimization.md'],
  'tests named for security words': ['tests/auth.test.mjs', 'src/auth/login.test.ts', 'src/__tests__/session.ts', 'test/token.spec.js'],
  'estimate math (77a31375)': ['home/tools/estimate/lib/forecast.mjs', 'home/tools/estimate/lib/commitment.mjs', 'tests/estimate-forecast.test.mjs'],
};
for (const [lane, files] of Object.entries(QUIET_LANES)) {
  test(`a ${lane} change has no risk class`, async () => {
    assert.deepEqual(await classesOf(files), []);
  });
}

test('the built-in defaults equal the shipped rule file', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(DEFAULT_RISK_RULES)), SHIPPED);
  assert.deepEqual(parseRiskRules(readFileSync(RULES_FILE, 'utf8')), SHIPPED);
});

// The rule file as it shipped before this lane (version 1).
const VERSION_1 = {
  version: 1,
  classes: {
    security: { paths: ['auth', 'login', 'session', 'token', 'secret', 'credential', 'passw', 'crypto', 'permission', 'guard'] },
    gate: { paths: ['^home/hooks/'] },
  },
  large: { lines: 400, files: 15 },
};

test('a version 1 rule file still reads and keeps its substring meaning, with nothing left out', async () => {
  const file = join(makeTempDir('done-check-risk-v1-'), 'risk-rules.json');
  writeFileSync(file, JSON.stringify(VERSION_1));
  const { rules, warning } = loadRiskRules(file);
  assert.equal(warning, null);
  assert.deepEqual(rules, VERSION_1);
  assert.deepEqual(await classesOf(['home/tools/token-view/lib/summary.mjs'], rules), ['security']);
  assert.deepEqual(await classesOf(['tests/auth.test.mjs'], rules), ['security']);
  assert.deepEqual(await classesOf(['home/hooks/README.md'], rules), ['gate']);
});

const BAD_RULES = {
  'a version 3 file': { ...SHIPPED, version: 3 },
  'an unknown class key': { ...SHIPPED, classes: { security: { word: ['auth'] } } },
  'a class with no list': { ...SHIPPED, classes: { security: {} } },
  'a bad leftOut pattern': { ...SHIPPED, leftOut: ['('] },
  'a bad word pattern': { ...SHIPPED, classes: { security: { words: ['('] } } },
  'a version 1 class without paths': { ...VERSION_1, classes: { security: { words: ['auth'] } } },
};
for (const [name, rules] of Object.entries(BAD_RULES)) {
  test(`${name} is refused, and loading it falls back to the built-in rules`, async () => {
    assert.throws(() => parseRiskRules(JSON.stringify(rules)), /^Error: risk rules: |SyntaxError/);
    const file = join(makeTempDir('done-check-risk-bad-'), 'risk-rules.json');
    writeFileSync(file, JSON.stringify(rules));
    const loaded = loadRiskRules(file);
    assert.equal(loaded.rules, DEFAULT_RISK_RULES);
    assert.match(loaded.warning, /^risk rules not used, built-in defaults apply: /);
  });
}

/** The class names of a change written into a fresh fixture repo; `files` is what the scope lists as changed. */
async function classesAfter(t, change, files) {
  const repo = makeDoneCheckRepo({ files: { 'src/big.ts': 'export const first = 1;\n' } });
  t.after(() => repo.cleanup());
  change(repo);
  const found = await riskClasses({ top: repo.dir, git: true, base: repo.baseSha, files, wide: [], key: NO_SHA }, SHIPPED);
  return found.map((entry) => entry.class);
}
const lines = (count) => `${Array.from({ length: count }, (_, index) => `export const v${index} = ${index};`).join('\n')}\n`;

test('more than 400 changed lines of tests or docs are not large; of code they are', async (t) => {
  assert.deepEqual(await classesAfter(t, (repo) => repo.write('tests/big.test.mjs', lines(500)), ['tests/big.test.mjs']), []);
  assert.deepEqual(await classesAfter(t, (repo) => repo.write('docs/big.md', lines(500)), ['docs/big.md']), []);
  assert.deepEqual(await classesAfter(t, (repo) => repo.write('src/big.ts', lines(401)), ['src/big.ts']), ['large']);
});

test('more than 15 test or docs files are not large; 16 code files are', async () => {
  const many = (make) => Array.from({ length: 16 }, (_, index) => make(index));
  assert.deepEqual(await classesOf(many((index) => `tests/part${index}.test.mjs`)), []);
  assert.deepEqual(await classesOf(many((index) => `docs/part${index}.md`)), []);
  assert.deepEqual(await classesOf(many((index) => `src/part${index}.ts`)), ['large']);
});

test(`the 82 ledger rows of 2026-11-22 flag security on at most ${MAX_SECURITY_ROWS}, and keep gate where a gate code file changed`, async (t) => {
  assert.equal(LEDGER_ROWS.length, 82);
  const gateCode = (path) => /^home\/(hooks|tools\/(land-lane|road|done-check))\//.test(path) && !/\.md$/.test(path);
  const security = [];
  for (const row of LEDGER_ROWS) {
    const classes = await classesOf(row.files);
    if (classes.includes('security')) security.push(row.row);
    if (row.files.some(gateCode)) assert.ok(classes.includes('gate'), `row ${row.row} lost gate`);
  }
  const before = LEDGER_ROWS.filter((row) => row.riskThen.includes('security')).length;
  t.diagnostic(`security rows: ${security.length} (rows ${security.join(', ') || 'none'}), recorded then: ${before}`);
  assert.ok(security.length <= MAX_SECURITY_ROWS, `security on ${security.length} rows: ${security.join(', ')}`);
});
