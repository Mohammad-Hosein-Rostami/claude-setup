// Tests for the two scanners of env-names: names read by source code (lib/code-reads.mjs) and names mentioned in deploy
// files (lib/deploy-names.mjs). Each kind has a present and an absent case; inline values must never be returned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanCode } from '../home/tools/env-names/lib/code-reads.mjs';
import { scanDeploy } from '../home/tools/env-names/lib/deploy-names.mjs';
import { leaked } from './env-names-fixtures.mjs';

const readNames = (text, wrappers) => scanCode(text, wrappers).reads.map((read) => `${read.name}@${read.line}${read.builtin ? ':builtin' : ''}`);
const deployNames = (kind, text) => scanDeploy(kind, text).mentions.map((mention) => `${mention.name}@${mention.line}`);

test('code: process.env.NAME, process.env["NAME"], import.meta.env and Deno.env.get with the line number', () => {
  const text = [
    'const a = process.env.ALPHA;',
    "const b = process.env['BETA'] + process.env[\"GAMMA\"];",
    'const c = import.meta.env.VITE_DELTA;',
    "const d = import.meta.env['VITE_EPSILON'];",
    "const e = Deno.env.get('ZETA');",
  ].join('\n');
  assert.deepEqual(readNames(text), ['ALPHA@1', 'BETA@2', 'GAMMA@2', 'VITE_DELTA@3', 'VITE_EPSILON@4', 'ZETA@5']);
});

test('code: absent case, no env access gives no reads and no dynamic count', () => {
  assert.deepEqual(scanCode('const env = { A: 1 }; env.A; process.argv;', []), { reads: [], dynamic: 0 });
});

test('code: a wrapper named with --wrapper is read, an unnamed one is not', () => {
  const text = "const a = getEnvVariable('WRAPPED');\nconst b = otherFn('NOT_WRAPPED');\nreadEnv(\"SECOND\")";
  assert.deepEqual(readNames(text, ['getEnvVariable', 'readEnv']), ['WRAPPED@1', 'SECOND@3']);
  assert.deepEqual(readNames(text, []), []);
});

test('code: Vite built-in names are flagged builtin', () => {
  const text = 'if (import.meta.env.DEV || import.meta.env.MODE) {}\nimport.meta.env.PROD;import.meta.env.SSR;import.meta.env.BASE_URL;';
  const reads = scanCode(text, []).reads;
  assert.equal(reads.length, 5);
  assert.ok(reads.every((read) => read.builtin));
});

test('code: process.env.MODE is a normal variable, not a Vite built-in', () => {
  assert.deepEqual(readNames('process.env.MODE', []), ['MODE@1']);
});

test('code: dynamic access is counted and never produces a name', () => {
  const text = 'process.env[name];\nimport.meta.env[`X_${k}`];\nprocess.env["OK"];\nDeno.env.get(key);\nprocess.env[a + b]';
  const result = scanCode(text, []);
  assert.equal(result.dynamic, 4);
  assert.deepEqual(result.reads.map((read) => read.name), ['OK']);
});

test('deploy dockerfile: ARG and ENV names, both ENV forms, quoted values hide nothing and add no fake name', () => {
  const text = [
    'FROM node:22',
    'ARG BUILD_ARG',
    'ARG WITH_DEFAULT=MARKER_VALUE',
    'ENV ONE=MARKER_VALUE TWO="MARKER_VALUE THREE=fake" FOUR=x\\ y',
    'ENV LEGACY MARKER_VALUE words',
    'ENV MULTI=a \\',
    '    CONTINUED=MARKER_VALUE',
    '# ENV COMMENTED=MARKER_COMMENT',
    'RUN echo NOT_A_NAME=1',
  ].join('\n');
  const mentions = deployNames('dockerfile', text);
  assert.deepEqual(mentions, ['BUILD_ARG@2', 'WITH_DEFAULT@3', 'FOUR@4', 'ONE@4', 'TWO@4', 'LEGACY@5', 'CONTINUED@6', 'MULTI@6']);
  assert.deepEqual(leaked(JSON.stringify(scanDeploy('dockerfile', text))), []);
});

test('deploy dockerfile: absent case, no ARG or ENV gives nothing', () => {
  assert.deepEqual(deployNames('dockerfile', 'FROM node:22\nRUN npm ci\n'), []);
});

test('deploy compose: environment map keys, list items, ${NAME} substitutions; values stay out', () => {
  const text = [
    'services:',
    '  web:',
    '    image: app:${IMAGE_TAG:-latest}',
    '    environment:',
    '      MAP_KEY: MARKER_COMPOSE',
    '      # COMMENTED: MARKER_COMMENT',
    '      OTHER_KEY:',
    '      URL: "${DB_HOST}/MARKER_COMPOSE"',
    '  api:',
    '    environment:',
    '      - LIST_ITEM=MARKER_COMPOSE',
    '      - "QUOTED_ITEM=MARKER_COMPOSE"',
    '      - PASS_THROUGH',
    '    ports: ["80:80"]',
    '    labels:',
    '      NOT_ENV: x',
  ].join('\n');
  const mentions = deployNames('compose', text);
  assert.deepEqual(mentions, ['IMAGE_TAG@3', 'MAP_KEY@5', 'OTHER_KEY@7', 'DB_HOST@8', 'URL@8', 'LIST_ITEM@11', 'QUOTED_ITEM@12', 'PASS_THROUGH@13']);
  assert.deepEqual(leaked(JSON.stringify(scanDeploy('compose', text))), []);
});

test('deploy compose: absent case, a file without environment or substitutions gives nothing', () => {
  assert.deepEqual(deployNames('compose', 'services:\n  web:\n    image: nginx\n    ports:\n      - "80:80"\n'), []);
});

test('deploy workflow: env keys, secrets.NAME and vars.NAME', () => {
  const text = [
    'env:',
    '  TOP_LEVEL: MARKER_VALUE',
    'jobs:',
    '  build:',
    '    steps:',
    '      - run: deploy',
    '        env:',
    '          TOKEN_FROM_SECRET: ${{ secrets.DEPLOY_TOKEN }}',
    '          PLAIN: ${{ vars.SITE_URL }}',
    '      - run: echo done',
  ].join('\n');
  const mentions = deployNames('workflow', text);
  assert.deepEqual(mentions, ['TOP_LEVEL@2', 'DEPLOY_TOKEN@8', 'TOKEN_FROM_SECRET@8', 'PLAIN@9', 'SITE_URL@9']);
  assert.deepEqual(leaked(JSON.stringify(scanDeploy('workflow', text))), []);
  // A block scalar in the same env block makes it irregular: nothing from the block is trusted, whatever its layout.
  const withScalar = text.replace('      - run: echo done', '          MULTI: |\n            NOT_A_KEY: MARKER_VALUE\n      - run: echo done');
  assert.deepEqual(deployNames('workflow', withScalar), ['TOP_LEVEL@2']);
  assert.deepEqual(scanDeploy('workflow', withScalar).unconfirmed.map((mention) => mention.name), ['DEPLOY_TOKEN', 'TOKEN_FROM_SECRET', 'PLAIN', 'SITE_URL', 'MULTI', 'NOT_A_KEY']);
});

test('deploy gitlab: env and variables blocks plus secrets.NAME; absent case gives nothing', () => {
  assert.deepEqual(deployNames('gitlab', 'variables:\n  GL_VAR: MARKER_VALUE\nbuild:\n  script: make\n'), ['GL_VAR@2']);
  assert.deepEqual(deployNames('workflow', 'on: push\njobs:\n  a:\n    steps: []\n'), []);
});

test('deploy dockerfile: a continued ENV value is joined with no space and never printed (audit F2)', () => {
  const cases = [
    ['ENV TOKEN=ZqxFirstHalf\\\nZqxSecondHalf\n', ['TOKEN@1']],
    ['ENV ZQX_NAME=\\\nZqxWholeToken\n', ['ZQX_NAME@1']],
    ['ARG ZQX_ARG=\\\nZqxWholeToken\n', ['ZQX_ARG@1']],
    ['ENV A=x ZqxWord\n', ['A@1']],
    ['ENV A=x ZqxWord B=y\n', ['A@1']], // a bare word ends the scan: Docker would reject the line
    ['ENV A=x ZQX_WORD\n', ['A@1']], // a name-shaped bare word: only the parser rule stops it, not the output rule
    ['ENV A=x\\\nB=y\n', ['A@1']], // Docker joins with no space: `xB=y` is one value, so B is no name
    ['ENV LEGACY \\\nZqxValue\n', ['LEGACY@1']],
    ['ENV LEGACY ZqxValue more words\n', ['LEGACY@1']],
  ];
  for (const [text, expected] of cases) assert.deepEqual(deployNames('dockerfile', text), expected, text);
});

test('deploy output rule: odd-shaped names from the left of = are hidden and counted; YAML keys and ${NAME} may be mixed case', () => {
  const dockerfile = scanDeploy('dockerfile', `ENV MixedCase=1 UPPER_OK=2\nENV ${'X'.repeat(70)}=3\n`);
  assert.deepEqual(dockerfile, { mentions: [{ name: 'UPPER_OK', line: 1 }], unconfirmed: [], hidden: 2 });
  const compose = scanDeploy('compose', 'services:\n  a:\n    environment:\n      mixedKey: 1\n      - MixedItem=1\n      - PLAIN_ITEM=2\n    image: x:${MixedSub}\n');
  assert.deepEqual(compose.mentions.map((mention) => mention.name), ['mixedKey', 'PLAIN_ITEM', 'MixedSub']);
  assert.equal(compose.hidden, 1);
  assert.deepEqual(scanDeploy('compose', `services:\n  a:\n    environment:\n      ${'k'.repeat(65)}: 1\n`), { mentions: [], unconfirmed: [], hidden: 1 });
});

test('deploy workflow: secrets.X and vars.X count only inside ${{ }}, not in a plain string', () => {
  const text = 'jobs:\n  a:\n    steps:\n      - run: echo "rotate secrets.ZqxNotAName"\n      - run: echo ${{ secrets.MixedRef }} ${{ vars.PLAIN_REF }}\n';
  assert.deepEqual(deployNames('workflow', text), ['MixedRef@5', 'PLAIN_REF@5']);
});
