// Fixed-seed fuzz for the YAML deploy reader: files built from pieces (quotes, block scalars, anchors, tags, flow collections,
// tabs, no-break spaces, CRLF, BOM, `---`, second documents) whose values carry marker words. The YAML parser itself, used the
// plain way (strict, unique keys, `toJS`), is the oracle: the tool must print exactly the names the oracle finds as keys at the env
// positions of a file the parser accepts, nothing from a file the parser rejects, and never a marker word. Markers start "zqxv".
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAllDocuments } from '../home/tools/env-names/node_modules/yaml/dist/index.js';
import { scanDeploy } from '../home/tools/env-names/lib/deploy-names.mjs';
import { everythingPrinted } from './env-names-fixtures.mjs';

const SEED = 20261115;
const FILES = 600;
const END_TO_END_FILES = 120;
const MAX_PIECES = 5;
const NAME_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLAIN_NAME = /^(?:[A-Z_][A-Z0-9_]{0,63}|[a-z_][a-z0-9_]{0,63})$/;
const MAX_KEY_LENGTH = 64;

function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

// Map entries. `m` is a marker word (only ever inside a value or a comment, or as a key in a piece that is invalid), `n` a unique number.
const VALID_MAP_PIECES = [
  (m, n) => [`OK_${n}: value ${m}`], (m, n) => [`OK_${n}: "quoted ${m}"`], (m, n) => [`OK_${n}:`], (m) => [`# note ${m}`], (m, n) => [`OK_${n}: 'it''s ${m}'`],
  (m, n) => [`OK_${n}: &anc${n} ${m}`], (m, n) => [`OK_${n}: !!str ${m}`], (m, n) => [`OK_${n}: |`, `  ${m}: 1`], (m, n) => [`OK_${n}: >-`, `  ${m}: 1`, '  more'],
  (m, n) => [`OK_${n}: {a: ${m}, b: 2}`], (m, n) => [`OK_${n}: [${m}, x]`], (m, n) => [`"OK_${n}": ${m}`], (m, n) => [`OK_${n}: "multi`, `  ${m}`, '  end"'],
  (m, n) => [`OK_${n}: plain`, `  ${m} continued`], (m, n) => [`OK_${n}: 'one`, `  ${m}'`], (m, n) => [`OK_${n}: "C:\\\\dir\\\\ ${m}"`], (m, n) => [`${n}_NUM: ${m}`, `Mixed_${n}: 1`],
];
const INVALID_MAP_PIECES = [
  (m) => ['K: &a "x', `${m}: v`, 'end"'], (m) => ['K: !!str "x', `${m}: v`, 'end"'], (m) => ['MY K: "x', `${m}: v`, 'end"'], (m) => ['"Q": "x', `${m}: v`, 'end"'],
  (m) => ['K:', '  "x', `${m}: v`, '  end"'], (m) => ['K: {a: 1,', `${m}: 2}`], (m) => ['K: [a,', `${m}: 2]`], (m) => [`\t${m}: 1`], (m) => ['K: *nowhere', `${m}: 1`],
  (m) => ['K: plain', `  ${m}: continued`], (m) => ["K: 'it''s", `${m}: 2`, "'"], (m) => ['K: 1', `  ${m}: 2`], (m, n) => [`OK_${n}: 1`, `OK_${n}: 2`], (m) => ['K: "never closes', m],
  (m, n) => [`\u00a0\u00a0NB_${n}: one`, `\u00a0\u00a0NB_X${n}: two`, `  - ${m}`], (m) => [`<<: *missing`, `${m}: 1`],
];
const VALID_LIST_PIECES = [(m, n) => [`- OK_${n}=${m}`], (m, n) => [`- BARE_${n}`], (m, n) => [`- 'OK_${n}=it''s ${m}'`], (m) => [`# note ${m}`], (m, n) => [`- "OK_${n}=a b ${m}"`]];
const INVALID_LIST_PIECES = [(m) => ['- "A=one', `${m}"`], (m) => ['- OK=1', `  ${m}: 2`], (m) => ['- [a,', `${m}]`]];

const SKELETONS = {
  compose: (block) => `services:\n  a:\n    environment:\n${block.map((row) => `      ${row}`).join('\n')}\n`,
  gitlab: (block) => `variables:\n${block.map((row) => `  ${row}`).join('\n')}\n`,
  workflow: (block) => `jobs:\n  a:\n    steps:\n      - run: x\n        env:\n${block.map((row) => `          ${row}`).join('\n')}\n`,
};

/** One YAML document of `kind` built from random pieces; `list` makes a compose list block instead of a map. */
function buildDocument(random, kind, tag) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const list = kind === 'compose' && random() < 0.25;
  const valid = list ? VALID_LIST_PIECES : VALID_MAP_PIECES;
  const invalid = list ? INVALID_LIST_PIECES : INVALID_MAP_PIECES;
  const block = [];
  for (let piece = 0, count = 1 + Math.floor(random() * MAX_PIECES); piece < count; piece += 1) {
    block.push(...pick(random() < 0.6 ? valid : invalid)(`zqxv${tag}x${piece}`, `${tag}_${piece}`));
  }
  return SKELETONS[kind](block);
}

/** A whole file: one or two documents, optionally a BOM, a leading `---`, and CRLF line ends. */
function buildFile(random, kind, index) {
  let text = buildDocument(random, kind, `${index}a`);
  if (random() < 0.15) text = `---\n${text}`;
  if (random() < 0.15) text += `---\n${buildDocument(random, kind, `${index}b`)}`;
  if (random() < 0.2) text = text.replaceAll('\n', '\r\n');
  return random() < 0.1 ? `\uFEFF${text}` : text;
}

const ENV_POSITIONS = {
  compose: (js) => Object.values(js?.services ?? {}).map((service) => service?.environment),
  gitlab: (js) => [js?.variables, ...Object.entries(js ?? {}).filter(([key]) => key !== 'variables').map(([, job]) => job?.variables)],
  workflow: (js) => [js?.env, ...Object.values(js?.jobs ?? {}).flatMap((job) => [job?.env, ...(job?.steps ?? []).map((step) => step?.env)])],
};

// The output rule: a map key may be mixed case up to 64 characters, a name from the left of `=` in a list item must be plain.
const shownKeys = (env) => Object.keys(env ?? {}).filter((key) => NAME_SHAPE.test(key) && key.length <= MAX_KEY_LENGTH);
const shownItems = (env) => env.filter((item) => typeof item === 'string').map((item) => item.split('=')[0]).filter((name) => PLAIN_NAME.test(name));
const shownNames = (env) => (Array.isArray(env) ? shownItems(env) : shownKeys(env));

/** The names the parser, used the plain way, says are keys at env positions; null when it reports any error or warning or `toJS` throws. */
function oracleNames(kind, text) {
  const documents = [...parseAllDocuments(text, { strict: true, uniqueKeys: true, merge: true })];
  if (documents.some((doc) => doc.errors.length > 0 || doc.warnings.length > 0)) return null;
  const found = new Set();
  try {
    for (const doc of documents) {
      for (const env of ENV_POSITIONS[kind](doc.toJS())) shownNames(env).forEach((name) => found.add(name));
    }
  } catch {
    return null; // `toJS` throws for an alias that is not defined and for a merge of something that is not a map: the file is broken
  }
  return [...found].sort();
}

test('fuzz (fixed seed, 600 files): the tool prints what the parser says are env keys, nothing from a rejected file, never a marker', () => {
  const random = seededRandom(SEED);
  const kinds = Object.keys(SKELETONS);
  const outcomes = { accepted: 0, rejected: 0 };
  for (let index = 0; index < FILES; index += 1) {
    const kind = kinds[index % kinds.length];
    const text = buildFile(random, kind, index);
    const expected = oracleNames(kind, text);
    const result = scanDeploy(kind, text);
    const printed = [...new Set(result.mentions.map((mention) => mention.name))].sort();
    outcomes[expected === null ? 'rejected' : 'accepted'] += 1;
    assert.deepEqual(printed, expected ?? [], `file ${index} (${kind}): ${JSON.stringify(text)}`);
    assert.equal(result.untrusted, expected === null, `file ${index} (${kind}) trust`);
    if (expected !== null && !expected.some((name) => name.startsWith('zqxv'))) assert.doesNotMatch(JSON.stringify(result), /zqxv/, `file ${index}`);
  }
  assert.ok(outcomes.accepted > FILES / 5 && outcomes.rejected > FILES / 5, `the mix should hold both kinds: ${JSON.stringify(outcomes)}`);
});

test('fuzz, end to end: the same kind of files through the CLI print no marker word in text, --json, snapshot or diff', async () => {
  const random = seededRandom(SEED + 1);
  const files = {};
  const kindOf = {};
  for (let index = 0; index < END_TO_END_FILES; index += 1) {
    const kind = Object.keys(SKELETONS)[index % 3];
    const path = { compose: `docker-compose.${index}.yml`, gitlab: `d${index}/.gitlab-ci.yml`, workflow: `.github/workflows/${index}.yml` }[kind];
    files[path] = buildFile(random, kind, index);
    kindOf[path] = kind;
  }
  const { text } = await everythingPrinted(files);
  // A marker may print only where the parser itself says it is a real key (a piece that was meant to be invalid but is not).
  const realMarkerKeys = Object.entries(files).flatMap(([path, content]) => oracleNames(kindOf[path], content) ?? []).filter((name) => name.startsWith('zqxv'));
  for (const marker of text.match(/zqxv\w+/g) ?? []) assert.ok(realMarkerKeys.includes(marker), `${marker} printed but is not a key the parser accepts`);
});
