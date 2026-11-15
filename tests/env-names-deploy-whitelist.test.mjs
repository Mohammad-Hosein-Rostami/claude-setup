// Tests for the deploy-file whitelist (third audit, R3-3): a block under `environment:`, `env:` or `variables:` is trusted only
// when every line is blank, a comment or a clean entry. Any other layout makes the block irregular: no name of it prints on its own
// evidence (only a name that code also reads), and the names left out are counted as not shown. Marker words start with "zqx".
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanDeploy } from '../home/tools/env-names/lib/deploy-names.mjs';
import { everythingPrinted, run } from './env-names-fixtures.mjs';

const SEED = 20240611;
const FUZZ_BLOCKS = 400;
const MAX_PIECES_PER_BLOCK = 4;

const composeFile = (entries) => `services:\n  a:\n    environment:\n${entries.map((entry) => `      ${entry}`).join('\n')}\n`;
const gitlabFile = (entries) => `variables:\n${entries.map((entry) => `  ${entry}`).join('\n')}\n`;
const workflowFile = (entries) => `jobs:\n  a:\n    steps:\n      - run: x\n        env:\n${entries.map((entry) => `          ${entry}`).join('\n')}\n`;
const FILES = [['docker-compose.yml', 'compose', composeFile], ['.gitlab-ci.yml', 'gitlab', gitlabFile], ['.github/workflows/ci.yml', 'workflow', workflowFile]];

/** Every layout the audit named, each with one marker key that a parser reads as value text or that is not a key position. */
const IRREGULAR_LAYOUTS = {
  'anchor before a multi-line quote': ['KEY: &anc "line one', 'zqxanchored: v', 'end"'],
  'tag before a multi-line quote': ['KEY: !!str "line one', 'zqxtagged: v', 'end"'],
  'key with a space, multi-line quote': ['MY KEY: "line one', 'zqxspacekey: v', 'end"'],
  'quoted key, multi-line quote': ['"QUOTED_KEY": "line one', 'zqxquotedkey: v', 'end"'],
  'quoted value on the next line': ['KEY:', '  "multi', 'zqxnextline: v', '  end"'],
  'anchor and alias': ['BASE: &base value', 'KEY: *base', 'zqxaliased: v'],
  'merge key with an alias': ['<<: *base', 'zqxmerged: v'],
  'literal block scalar': ['SCRIPT: |', '  zqxliteral: 1'],
  'folded block scalar': ['SCRIPT: >-', '  zqxfolded: 1'],
  'flow map over lines': ['KEY: {a: 1,', 'zqxflowmap: 2}'],
  'flow list over lines': ['KEY: [a,', 'zqxflowlist: 2]'],
  'flow map on one line': ['KEY: {a: 1}', 'zqxafterflow: 2'],
  'plain value continued on a deeper line': ['KEY: plain text', '  zqxcontinued: more'],
  'a line indented deeper than the entries': ['KEY: 1', '  zqxdeeper: 2'],
  'a line shifted left of the entries': ['    KEY: 1', '  zqxshifted: 2'],
  'a tab in the line': ['KEY: 1', '\tzqxtab: 2'],
  'single quote that does not close': ["KEY: 'it''s", 'zqxsingle: 2', "'"],
  'quote with a backslash before the closing quote': ['KEY: "C:\\\\logs\\\\"', 'zqxbackslash: 2'],
};

/** The end-to-end result for a file of this kind: what the tool prints, and what the JSON says was left out. */
async function printedFor(path, content, extra = {}) {
  const { dir, text } = await everythingPrinted({ [path]: content, ...extra });
  const notRead = JSON.parse(run(['list', dir, '--json']).stdout).notRead.filter((entry) => entry.path === path);
  return { text, notRead };
}

test('irregular layouts: the marker word is absent from text, --json, snapshot and diff, and the names left out are counted', async () => {
  for (const [label, layout] of Object.entries(IRREGULAR_LAYOUTS)) {
    for (const [path, , build] of FILES) {
      const { text, notRead } = await printedFor(path, build([...layout, 'AFTER_ENTRY: 1']));
      assert.doesNotMatch(text, /zqx/i, `${label} in ${path}`);
      assert.doesNotMatch(text, /AFTER_ENTRY/, `${label} in ${path}: a name of an irregular block needs code that reads it`);
      assert.match(notRead.map((entry) => entry.reason).join(), /\d+ names not shown \(.*unusual layout/, `${label} in ${path}`);
    }
  }
});

test('irregular block, corroborated: a name that code also reads is printed, the others are not', async () => {
  const content = composeFile(['KEY: &anc "line one', 'zqxanchored: v', 'end"', 'READ_BY_CODE: 1']);
  const { text, notRead } = await printedFor('docker-compose.yml', content, { 'src/a.ts': 'process.env.READ_BY_CODE;\n' });
  assert.match(text, /READ_BY_CODE/);
  assert.doesNotMatch(text, /zqx/i);
  assert.doesNotMatch(text, /\bKEY\b/);
  assert.match(notRead[0].reason, /names not shown/);
});

test('ordinary files still print every name: compose map and list forms, a CI env map, a GitLab variables block', () => {
  const mapEntries = ['# the settings', 'NODE_ENV: production', 'API_URL: "https://x.example/${API_HOST}"', '', "'SINGLE_QUOTED': 'it''s'", 'EMPTY:', 'PORT: 8080 # note', '"MixedKey": plain'];
  const listEntries = ['- PLAIN_ITEM=1', '- BARE_ITEM', '- "QUOTED_ITEM=a b"', "- 'SINGLE_ITEM=c'", '- URL_ITEM=a:b#c'];
  const expectedMap = ['NODE_ENV', 'API_URL', 'API_HOST', 'SINGLE_QUOTED', 'EMPTY', 'PORT', 'MixedKey'].sort();
  const names = (kind, text) => scanDeploy(kind, text).mentions.map((mention) => mention.name).sort();
  assert.deepEqual(names('compose', composeFile(mapEntries)), expectedMap);
  assert.deepEqual(names('compose', composeFile(listEntries)), ['BARE_ITEM', 'PLAIN_ITEM', 'QUOTED_ITEM', 'SINGLE_ITEM', 'URL_ITEM']);
  assert.deepEqual(names('workflow', workflowFile(['TOKEN: ${{ secrets.DEPLOY_TOKEN }}', 'MODE: "release"', 'EMPTY:'])), ['DEPLOY_TOKEN', 'EMPTY', 'MODE', 'TOKEN']);
  assert.deepEqual(names('gitlab', gitlabFile(['CI_FLAG: "true"', 'PLAIN_VAR: value'])), ['CI_FLAG', 'PLAIN_VAR']);
  const result = scanDeploy('compose', composeFile(mapEntries));
  assert.deepEqual([result.unconfirmed, result.hidden], [[], 0]);
});

test('ordinary files, end to end: no names hidden, nothing counted as not shown', async () => {
  const { text, notRead } = await printedFor('docker-compose.yml', composeFile(['NODE_ENV: production', 'PORT: 8080']));
  assert.match(text, /NODE_ENV/);
  assert.match(text, /PORT/);
  assert.deepEqual(notRead, []);
});

// A fixed-seed fuzz: blocks built from clean pieces and irregular pieces, with marker words in values and in key position.
function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const CLEAN_PIECES = [
  (m, n) => [`OK_${n}: value ${m}`], (m, n) => [`OK_${n}: "quoted ${m}"`], (m, n) => [`OK_${n}:`], (m, n) => [`# note ${m}`], (m, n) => [`OK_${n}: 'it''s ${m}'`],
];
const IRREGULAR_PIECES = [
  (m) => ['K: &a "x', `${m}: v`, 'end"'], (m) => ['K: !!str "x', `${m}: v`, 'end"'], (m) => ['MY K: "x', `${m}: v`, 'end"'], (m) => ['"Q": "x', `${m}: v`, 'end"'],
  (m) => ['K:', '  "x', `${m}: v`, '  end"'], (m) => ['K: {a: 1,', `${m}: 2}`], (m) => ['K: [a,', `${m}: 2]`], (m) => ['K: |', `  ${m}: 1`], (m) => ['K: >-', `  ${m}: 1`],
  (m) => ['K: *alias', `${m}: 1`], (m) => ['K: plain', `  ${m}: continued`], (m) => [`\t${m}: 1`], (m) => ["K: 'it''s", `${m}: 2`, "'"], (m) => ['K: "C:\\\\x\\\\"', `${m}: 2`],
];

test('fuzz (fixed seed): no marker word is ever trusted, an irregular block trusts nothing, a clean block trusts all its names', () => {
  const random = seededRandom(SEED);
  const pick = (list) => list[Math.floor(random() * list.length)];
  for (let n = 0; n < FUZZ_BLOCKS; n += 1) {
    const [, kind, build] = pick(FILES);
    const lines = [];
    const cleanNames = [];
    let irregular = false;
    for (let piece = 0, count = 1 + Math.floor(random() * MAX_PIECES_PER_BLOCK); piece < count; piece += 1) {
      const marker = `zqxmark${n}x${piece}`;
      const useIrregular = random() < 0.5;
      irregular ||= useIrregular;
      const made = pick(useIrregular ? IRREGULAR_PIECES : CLEAN_PIECES)(marker, `${n}_${piece}`);
      lines.push(...made);
      if (!useIrregular && made[0].startsWith('OK_')) cleanNames.push(made[0].split(':')[0]);
    }
    const result = scanDeploy(kind, build(lines));
    assert.doesNotMatch(JSON.stringify(result.mentions), /zqx/, `block ${n}: ${JSON.stringify(lines)}`);
    const trusted = result.mentions.map((mention) => mention.name);
    assert.deepEqual(trusted, irregular ? [] : cleanNames, `block ${n}: ${JSON.stringify(lines)}`);
  }
});
