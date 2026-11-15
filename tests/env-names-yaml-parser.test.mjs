// Tests for reading YAML deploy files with a real parser (fourth audit, R4-1 to R4-3, and the accuracy the line scanner lost).
// A name comes only from a parsed map key at an env position; a word from inside a value never prints. Marker words start "zqx".
// Also: hostile input (alias bomb, deep nesting, 1 MB, duplicate keys, tab, a broken
// second document, keys that are not names, CRLF and BOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanDeploy } from '../home/tools/env-names/lib/deploy-names.mjs';
import { everythingPrinted, run } from './env-names-fixtures.mjs';

const MAX_SECONDS_FOR_BIG_FILE = 5;
const BIG_FILE_BYTES = 1024 * 1024;
const NBSP = '\u00a0';
const names = (kind, text) => scanDeploy(kind, text).mentions.map((mention) => mention.name);
const lines = (...rows) => `${rows.join('\n')}\n`;

/** Everything the tool prints for one deploy file (text, --json, snapshot, diff), as one string. */
async function printedFor(path, content) {
  return (await everythingPrinted({ [path]: content })).text;
}

test('R4-1: a quote opened in an env block that runs past it does not turn a later `environment:` inside it into a block', async () => {
  const openers = [['A: &an "one'], ['A: !!str "one'], ['MY A: "one'], ["A: 'it''"], ['"one'], ['A: {a: "}", b: "x'], ['A:', '  "one'], ['- "A=one']];
  for (const opener of openers) {
    const content = lines('services:', '  a:', '    environment:', ...opener.map((row) => `      ${row}`), '  b:', '    environment:', '      zqxspill3: v', '  c"', '  d:', '    image: y');
    assert.doesNotMatch(await printedFor('docker-compose.yml', content), /zqx/, JSON.stringify(opener));
  }
});

test('R4-2: an `environment:`, `env:` or `variables:` line inside a block scalar, a quote or a flow list is value text', async () => {
  const insideText = {
    'compose literal block scalar': ['docker-compose.yml', lines('services:', '  a:', '    labels:', '      doc: |', '        environment:', '          zqxinscalar: v')],
    'compose folded block scalar': ['docker-compose.yml', lines('services:', '  a:', '    labels:', '      doc: >-', '        environment:', '          zqxfolded: v')],
    'compose configs content': ['docker-compose.yml', lines('configs:', '  c:', '    content: |', '      environment:', '        zqxconfig: v')],
    'compose environment as a block scalar': ['docker-compose.yml', lines('services:', '  a:', '    environment: |', '      zqxenvscalar: v')],
    'compose document-level block scalar': ['docker-compose.yml', lines('--- |', 'environment:', '  zqxdocscalar: v')],
    'compose multi-line quote': ['docker-compose.yml', lines('services:', '  a:', '    labels:', '      note: "line one', '        environment:', '          zqxinquoted: v', '        end"')],
    'compose multi-line flow list': ['docker-compose.yml', lines('services:', '  a:', '    command: ["sh", "-c", "one', '        environment:', '          zqxflowlist: v', '        end"]')],
    'gitlab heredoc in script': ['.gitlab-ci.yml', lines('build:', '  script:', '    - |', '      cat > x.yml <<EOF', '      env:', '        zqxheredoc: v', '      variables:', '        zqxchild: v', '      EOF')],
    'workflow heredoc in run': ['.github/workflows/ci.yml', lines('jobs:', '  a:', '    steps:', '      - run: |', '          cat > x.yml <<EOF', '          env:', '            zqxrunblock: v', '          EOF')],
  };
  for (const [label, [path, content]] of Object.entries(insideText)) {
    assert.doesNotMatch(await printedFor(path, content), /zqx/, label);
  }
});

test('R4-2: a CI file with a heredoc in `script:` still prints its real variables', () => {
  const text = lines('variables:', '  REAL_VAR: 1', 'build:', '  variables:', '    JOB_VAR: 2', '  script:', '    - |', '      cat <<EOF', '      env:', '        zqxheredoc: 1', '      EOF');
  assert.deepEqual(names('gitlab', text), ['REAL_VAR', 'JOB_VAR']);
});

test('R4-3: indentation that is not a space (no-break space, ideographic space, BOM, line separator) never makes a value line a key', async () => {
  for (const mark of [NBSP, '\u3000', '\uFEFF', '\u2028']) {
    const content = lines('services:', '  a:', '    environment:', `      ${mark}${mark}A_ONE: one`, `      ${mark}${mark}A_TWO: two`, '        - zqxindentnbsp');
    const text = await printedFor('docker-compose.yml', content);
    assert.doesNotMatch(text, /zqx/, JSON.stringify(mark));
  }
});

test('anchors with a merge key, flow maps and a block under a service print their real keys, and nothing from a value', () => {
  const text = lines(
    'x-base: &base', '  LOG_LEVEL: info', 'services:', '  web:', '    environment:', '      <<: *base', '      PORT: 8080',
    '  api:', '    environment: {API_KEY_NAME: 1, DB_HOST: zqxvalue}', '    command: echo ${COMPOSE_SUB}', '  worker:', '    environment:', '      - QUEUE=zqxjobs', '      - BARE',
  );
  const found = scanDeploy('compose', text);
  assert.deepEqual(found.mentions.map(({ name, line }) => `${name}@${line}`), ['LOG_LEVEL@2', 'PORT@7', 'API_KEY_NAME@9', 'DB_HOST@9', 'COMPOSE_SUB@10', 'QUEUE@13', 'BARE@14']);
  assert.deepEqual([found.unconfirmed, found.hidden, found.untrusted], [[], 0, false]);
});

test('merge keys: an explicit key wins over a merged one and is listed once; a list of merges works; a merge of a missing anchor makes the file untrusted', () => {
  const text = lines('x-a: &a', '  SHARED: 1', '  ONLY_A: 1', 'x-b: &b', '  SHARED: 2', '  ONLY_B: 2', 'services:', '  s:', '    environment:', '      <<: [*a, *b]', '      SHARED: 3');
  assert.deepEqual(names('compose', text).sort(), ['ONLY_A', 'ONLY_B', 'SHARED']);
  const missing = scanDeploy('compose', lines('services:', '  s:', '    environment:', '      <<: *nowhere', '      REAL: 1'));
  assert.deepEqual([missing.mentions, missing.unconfirmed.map((entry) => entry.name), missing.untrusted], [[], ['REAL'], true]);
  const valueAlias = scanDeploy('compose', lines('services:', '  s:', '    environment:', '      REAL: *nowhere'));
  assert.deepEqual([valueAlias.mentions, valueAlias.untrusted], [[], true]); // the parser reports no error for this one
});

test('an untrusted file with no names is still reported as not read, with a fixed reason', async () => {
  const { dir } = await everythingPrinted({ 'docker-compose.yml': 'services:\n  s:\n    environment:\n\tA: 1\n' });
  const notRead = JSON.parse(run(['list', dir, '--json']).stdout).notRead;
  assert.deepEqual(notRead, [{ path: 'docker-compose.yml', reason: 'the YAML parser reports a problem with this file; no names shown' }]);
});

test('GitLab variables: the scalar form, the {value, description} map form (flow and block) and a job level; sub-keys never print', () => {
  const text = lines(
    'variables:', '  PLAIN_VAR: x', '  DESCRIBED_VAR:', '    value: "zqxvalue"', '    description: "zqxdescription"', '  INLINE_VAR: {value: "1", description: "x"}',
    'build:', '  variables:', '    JOB_VAR: 1', '  script: make', 'stages: [build]',
  );
  assert.deepEqual(names('gitlab', text), ['PLAIN_VAR', 'DESCRIBED_VAR', 'INLINE_VAR', 'JOB_VAR']);
});

test('workflow env at top level, job and step, with a secrets reference in a `run: |` block', () => {
  const text = lines('env:', '  TOP_ENV: 1', 'jobs:', '  a:', '    env:', '      JOB_ENV: 1', '    steps:', '      - run: |', '          echo ${{ secrets.TOKEN_A }}', '        env:', '          STEP_ENV: 1');
  assert.deepEqual(names('workflow', text), ['TOP_ENV', 'JOB_ENV', 'TOKEN_A', 'STEP_ENV']);
});

test('a key that is a number, null, a boolean or a map is never printed, and is counted', () => {
  const text = lines('services:', '  s:', '    environment:', '      123: a', '      null: b', '      ? {m: 1}', '      : c', '      true: d', '      OK_KEY: e');
  const found = scanDeploy('compose', text);
  assert.deepEqual([found.mentions.map((mention) => mention.name), found.hidden, found.untrusted], [['OK_KEY'], 4, false]);
});

test('a key with spaces or odd characters is not a name: counted, never printed', () => {
  const found = scanDeploy('compose', lines('services:', '  s:', '    environment:', '      "my key": 1', '      GOOD_ONE: 2'));
  assert.deepEqual([found.mentions.map((mention) => mention.name), found.hidden], [['GOOD_ONE'], 1]);
});

test('an alias bomb (nested aliases) neither hangs nor prints: the file is untrusted', () => {
  const levelNames = 'abcdefghijkl'.split('');
  const bomb = levelNames.map((level, index) => `  ${level}: &${level} [${Array(12).fill(index === 0 ? 'x' : `*${levelNames[index - 1]}`).join(', ')}]`);
  const text = lines('x-bomb:', ...bomb, 'services:', '  s:', '    environment: {REAL_ONE: 1}', '    labels: *l');
  const found = scanDeploy('compose', text);
  assert.deepEqual([found.mentions, found.unconfirmed.map((entry) => entry.name), found.untrusted], [[], ['REAL_ONE'], true]);
  const asEnv = scanDeploy('compose', lines(...bomb.map((row) => row.trim()), 'services:', '  s:', '    environment: *l'));
  assert.deepEqual([asEnv.mentions, asEnv.untrusted], [[], true]);
});

test('absurd nesting does not crash the scan: the file is untrusted', () => {
  for (const opening of ['[', '{a: ']) {
    const found = scanDeploy('compose', `services:\n  s:\n    environment: ${opening.repeat(200000)}\n`);
    assert.deepEqual([found.mentions, found.untrusted], [[], true]);
  }
});

test('a 1 MB file with 30,000 variables is read in a few seconds, every name found', () => {
  let text = 'services:\n  s:\n    environment:\n';
  let count = 0;
  while (text.length < BIG_FILE_BYTES) text += `      VAR_${count++}: value ${count}\n`;
  const started = Date.now();
  const found = scanDeploy('compose', text);
  assert.ok((Date.now() - started) / 1000 < MAX_SECONDS_FOR_BIG_FILE);
  assert.deepEqual([found.mentions.length, found.untrusted], [count, false]);
});

test('a key twice in one map, a tab indent and a broken second document each make the whole file untrusted', () => {
  const duplicate = scanDeploy('compose', lines('services:', '  s:', '    environment:', '      A: 1', '      A: 2'));
  assert.deepEqual([duplicate.mentions, duplicate.untrusted], [[], true]);
  const tabbed = scanDeploy('compose', 'services:\n  s:\n    environment:\n\tA: 1\n');
  assert.deepEqual([tabbed.mentions, tabbed.untrusted], [[], true]);
  const twoDocuments = scanDeploy('workflow', lines('env:', '  GOOD_ONE: 1', '---', 'env: {BAD_ONE: ['));
  assert.deepEqual([twoDocuments.mentions, twoDocuments.untrusted], [[], true]);
  assert.ok(twoDocuments.unconfirmed.some((entry) => entry.name === 'GOOD_ONE'));
});

test('CRLF line ends and a BOM at the start are read as ordinary YAML, with correct line numbers', () => {
  const text = '\uFEFFservices:\r\n  s:\r\n    environment:\r\n      A_B: 1\r\n      C_D: 2\r\n';
  const found = scanDeploy('compose', text);
  assert.deepEqual(found.mentions.map(({ name, line }) => `${name}@${line}`), ['A_B@4', 'C_D@5']);
  assert.equal(found.untrusted, false);
});

test('a file that is not YAML at all, and an empty file, give nothing and do not crash', () => {
  for (const text of ['', '\n\n', '{{{{', 'just text: [', '- - - -']) {
    const found = scanDeploy('compose', text);
    assert.deepEqual(found.mentions, [], JSON.stringify(text));
  }
});
