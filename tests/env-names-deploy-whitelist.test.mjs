// Tests for the audit layouts (third audit, R3-3) of a block under `environment:`, `env:` or `variables:`, read by the YAML parser:
// a layout that is valid YAML prints its REAL keys and never a word of a value; an invalid one makes the whole file untrusted, so no
// name of it prints on its own evidence (only a name that code also reads) and the names left out are counted as not shown.
// Marker words start with "zqx". The fixed-seed fuzz against the parser as oracle is in env-names-yaml-fuzz.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanDeploy } from '../home/tools/env-names/lib/deploy-names.mjs';
import { everythingPrinted, everythingPrintedAsync, run, runAsync } from './env-names-fixtures.mjs';

const composeFile = (entries) => `services:\n  a:\n    environment:\n${entries.map((entry) => `      ${entry}`).join('\n')}\n`;
const gitlabFile = (entries) => `variables:\n${entries.map((entry) => `  ${entry}`).join('\n')}\n`;
const workflowFile = (entries) => `jobs:\n  a:\n    steps:\n      - run: x\n        env:\n${entries.map((entry) => `          ${entry}`).join('\n')}\n`;
const FILES = [['docker-compose.yml', 'compose', composeFile], ['.gitlab-ci.yml', 'gitlab', gitlabFile], ['.github/workflows/ci.yml', 'workflow', workflowFile]];

/** Layouts the audit named that are NOT valid YAML (or whose reader is unclear): the parser reports a problem, nothing prints on its own. */
const INVALID_LAYOUTS = {
  'anchor before a multi-line quote': ['KEY: &anc "line one', 'zqxanchored: v', 'end"'],
  'tag before a multi-line quote': ['KEY: !!str "line one', 'zqxtagged: v', 'end"'],
  'key with a space, multi-line quote': ['MY KEY: "line one', 'zqxspacekey: v', 'end"'],
  'quoted key, multi-line quote': ['"QUOTED_KEY": "line one', 'zqxquotedkey: v', 'end"'],
  'quoted value on the next line': ['KEY:', '  "multi', 'zqxnextline: v', '  end"'],
  'merge key with an alias that is not defined': ['<<: *base', 'zqxmerged: v'],
  'flow map over lines': ['KEY: {a: 1,', 'zqxflowmap: 2}'],
  'flow list over lines': ['KEY: [a,', 'zqxflowlist: 2]'],
  'plain value continued on a deeper line': ['KEY: plain text', '  zqxcontinued: more'],
  'a line indented deeper than the entries': ['KEY: 1', '  zqxdeeper: 2'],
  'a line shifted left of the entries': ['    KEY: 1', '  zqxshifted: 2'],
  'a tab in the line': ['KEY: 1', '\tzqxtab: 2'],
  'single quote that does not close': ["KEY: 'it''s", 'zqxsingle: 2', "'"],
};

/** Layouts that are valid YAML: `names` are the real keys (AFTER_ENTRY follows each), `values` are words that sit in values and must never print. */
const VALID_LAYOUTS = {
  'anchor and alias': { lines: ['BASE: &base value', 'KEY: *base', 'zqxaliased: v'], names: ['BASE', 'KEY', 'zqxaliased'], values: [] },
  'literal block scalar': { lines: ['SCRIPT: |', '  zqxliteral: 1'], names: ['SCRIPT'], values: ['zqxliteral'] },
  'folded block scalar': { lines: ['SCRIPT: >-', '  zqxfolded: 1'], names: ['SCRIPT'], values: ['zqxfolded'] },
  'flow map on one line, then a sibling key': { lines: ['KEY: {a: 1, zqxinflow: 2}', 'zqxafterflow: 2'], names: ['KEY', 'zqxafterflow'], values: ['zqxinflow'] },
  'quote with a backslash before the closing quote': { lines: ['KEY: "C:\\\\logs\\\\"', 'zqxbackslash: 2'], names: ['KEY', 'zqxbackslash'], values: [] },
};

/** The end-to-end result for a file of this kind: what the tool prints, and what the JSON says was left out. */
async function printedFor(path, content, extra = {}) {
  const { dir, text } = await everythingPrinted({ [path]: content, ...extra });
  const notRead = JSON.parse(run(['list', dir, '--json']).stdout).notRead.filter((entry) => entry.path === path);
  return { text, notRead };
}

// The layout tests run up to this many projects side by side: each project is ~5 CLI starts that wait on nothing but node.
const PROJECTS_AT_ONCE = 4;

/** printedFor through the async runner: the same CLI calls with the same arguments. */
async function printedForAsync(path, content) {
  const { dir, text } = await everythingPrintedAsync({ [path]: content });
  const notRead = JSON.parse((await runAsync(['list', dir, '--json'])).stdout).notRead.filter((entry) => entry.path === path);
  return { text, notRead };
}

/** printedForAsync of every [path, content] in `cases`, at most PROJECTS_AT_ONCE at a time, in the order of `cases`. */
async function printedForAll(cases) {
  const results = new Array(cases.length);
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const index = next++;
      results[index] = await printedForAsync(...cases[index]);
    }
  };
  await Promise.all(Array.from({ length: PROJECTS_AT_ONCE }, worker));
  return results;
}

test('invalid layouts: the marker word is absent from text, --json, snapshot and diff, and the names left out are counted', async () => {
  const cases = Object.values(INVALID_LAYOUTS).flatMap((layout) => FILES.map(([path, , build]) => [path, build([...layout, 'AFTER_ENTRY: 1'])]));
  const printed = await printedForAll(cases);
  let at = 0;
  for (const [label] of Object.entries(INVALID_LAYOUTS)) {
    for (const [path] of FILES) {
      const { text, notRead } = printed[at++];
      assert.doesNotMatch(text, /zqx/i, `${label} in ${path}`);
      assert.doesNotMatch(text, /AFTER_ENTRY/, `${label} in ${path}: a name of an untrusted file needs code that reads it`);
      assert.match(notRead.map((entry) => entry.reason).join(), /\d+ names not shown \(.*parser reports a problem/, `${label} in ${path}`);
    }
  }
});

test('valid layouts: the real keys print, the words of values never do, nothing is counted as left out', async () => {
  const cases = Object.values(VALID_LAYOUTS).flatMap(({ lines }) => FILES.map(([path, , build]) => [path, build([...lines, 'AFTER_ENTRY: 1'])]));
  const printed = await printedForAll(cases);
  let at = 0;
  for (const [label, { lines, names, values }] of Object.entries(VALID_LAYOUTS)) {
    for (const [path, kind, build] of FILES) {
      const content = build([...lines, 'AFTER_ENTRY: 1']);
      assert.deepEqual(scanDeploy(kind, content).mentions.map((mention) => mention.name), [...names, 'AFTER_ENTRY'], `${label} in ${path}`);
      const { text, notRead } = printed[at++];
      for (const word of values) assert.doesNotMatch(text, new RegExp(word), `${label} in ${path}`);
      assert.deepEqual(notRead, [], `${label} in ${path}`);
    }
  }
});

test('untrusted file, corroborated: a name that code also reads is printed, the others are not', async () => {
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
