// Tests for the fifth audit of the YAML reader: characters that other YAML parsers read as line breaks (F1), work that grows with
// the input (F2: measured as pairs and characters examined, never seconds), and where the parser is loaded from (F3).
// Marker words start with "zqx".
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectProject } from '../home/tools/env-names/lib/collect.mjs';
import { scanDeploy } from '../home/tools/env-names/lib/deploy-names.mjs';
import { loadYamlParser, scanYamlDeploy } from '../home/tools/env-names/lib/deploy-yaml-names.mjs';
import { formatList } from '../home/tools/env-names/lib/report.mjs';
import { everythingPrinted, makeProject } from './env-names-fixtures.mjs';

const TOOL_DIR = fileURLToPath(new URL('../home/tools/env-names/', import.meta.url));
const MAX_WORK_PER_CHARACTER = 3; // linear work: a few passes over the text; the walk's own limit is 4
const FILE_WORK_LIMIT_PER_CHARACTER = 5;
const lines = (...rows) => `${rows.join('\n')}\n`;

/** One character of every class other YAML parsers treat differently, with a name for the failure message. */
const FOREIGN = {
  'line separator U+2028': '\u2028', 'paragraph separator U+2029': '\u2029', 'next line U+0085': '\u0085', 'lone CR': '\r',
  'C0 control U+0001': '\u0001', 'NUL': '\u0000', 'DEL': '\u007f', 'C1 control U+009F': '\u009f', 'BOM inside the file': '\uFEFF',
};

/** A file of each kind with `hide` placed where a comment or a scalar value of the env block can hold it. */
const IN_COMMENT = {
  compose: (hide) => `services:\n  a:\n    image: x\n    environment: # c${hide}      x: |\n        zqxlsblock: v\n`,
  gitlab: (hide) => `variables: # c${hide}  x: |\n  zqxlsblock: v\n`,
  workflow: (hide) => `env: # c${hide}  x: |\n  zqxlsblock: v\n`,
};
const IN_PLAIN_VALUE = {
  compose: (hide) => `services:\n  a:\n    environment:\n      A: one${hide}two\n      zqxplain: v\n`,
  gitlab: (hide) => `variables:\n  A: one${hide}two\n  zqxplain: v\n`,
  workflow: (hide) => `env:\n  A: one${hide}two\n  zqxplain: v\n`,
};
const IN_QUOTED_VALUE = {
  compose: (hide) => `services:\n  a:\n    environment:\n      A: "one${hide}two"\n      zqxquoted: v\n`,
  gitlab: (hide) => `variables:\n  A: "one${hide}two"\n  zqxquoted: v\n`,
  workflow: (hide) => `env:\n  A: "one${hide}two"\n  zqxquoted: v\n`,
};

test('F1: every foreign line break or control character, in a comment, a plain value or a quoted value, makes the file untrusted', () => {
  for (const [where, builders] of Object.entries({ comment: IN_COMMENT, 'plain value': IN_PLAIN_VALUE, 'quoted value': IN_QUOTED_VALUE })) {
    for (const [kind, build] of Object.entries(builders)) {
      for (const [label, hide] of Object.entries(FOREIGN)) {
        const result = scanDeploy(kind, build(hide));
        assert.deepEqual(result.mentions, [], `${label} in a ${where} of a ${kind} file`);
        assert.equal(result.untrusted, true, `${label} in a ${where} of a ${kind} file`);
      }
    }
  }
});

test('F1: the marker behind a foreign character in a comment is absent from text, --json, snapshot and diff', async () => {
  const files = {};
  Object.values(FOREIGN).forEach((hide, index) => {
    files[`docker-compose.${index}.yml`] = IN_COMMENT.compose(hide);
    files[`d${index}/.gitlab-ci.yml`] = IN_COMMENT.gitlab(hide);
    files[`.github/workflows/${index}.yml`] = IN_COMMENT.workflow(hide);
  });
  const { text } = await everythingPrinted(files);
  assert.doesNotMatch(text, /zqx/);
});

test('F1: ordinary CRLF line ends, a leading BOM and a tab inside a comment are not foreign: the names still print', () => {
  const crlf = 'services:\r\n  a:\r\n    environment: # note\twith a tab\r\n      CRLF_NAME: 1\r\n';
  assert.deepEqual(scanDeploy('compose', crlf).mentions.map((mention) => mention.name), ['CRLF_NAME']);
  assert.deepEqual(scanDeploy('gitlab', `\uFEFFvariables:\n  BOM_NAME: 1\n`).mentions.map((mention) => mention.name), ['BOM_NAME']);
  assert.deepEqual(scanDeploy('workflow', '\uFEFFenv:\r\n  BOTH_NAME: 1\r\n').mentions.map((mention) => mention.name), ['BOTH_NAME']);
});

test('F2: references in a long `run: |` block are found in one pass; an unclosed `${{` finds none and costs one scan', () => {
  const body = Array.from({ length: 20000 }, () => '          secrets.A').join('\n');
  const unclosed = lines('jobs:', '  a:', '    steps:', '      - run: |', '          echo ${{ x', body);
  const open = scanYamlDeploy('workflow', unclosed);
  assert.equal(open.found.length, 0);
  assert.ok(open.work <= MAX_WORK_PER_CHARACTER * unclosed.length, `work ${open.work} for ${unclosed.length} characters`);
  const closed = lines('jobs:', '  a:', '    steps:', '      - run: |', ...Array.from({ length: 5000 }, (_, index) => `          echo \${{ secrets.S_${index} }}`));
  const found = scanYamlDeploy('workflow', closed);
  assert.equal(found.found.length, 5000);
  assert.ok(found.work <= MAX_WORK_PER_CHARACTER * closed.length, `work ${found.work} for ${closed.length} characters`);
});

test('F2: a big map merged by many services is walked within a limit proportional to the file and the file becomes untrusted', () => {
  const keys = Array.from({ length: 20000 }, (_, index) => `  K${index}: 1`);
  const services = Array.from({ length: 250 }, (_, index) => `  s${index}:\n    <<: *base\n    environment: {OWN_${index}: 1}`);
  const text = lines('x-base: &base', ...keys, 'services:', ...services);
  const result = scanYamlDeploy('compose', text);
  assert.equal(result.untrusted, true);
  assert.ok(result.work <= FILE_WORK_LIMIT_PER_CHARACTER * text.length, `work ${result.work} for ${text.length} characters`);
});

test('F2: an ordinary merge stays trusted and costs little; a map that merges itself is untrusted', () => {
  const services = Array.from({ length: 20 }, (_, index) => `  s${index}:\n    environment:\n      <<: *base\n      OWN_${index}: 1`);
  const text = lines('x-base: &base', '  SHARED_ONE: 1', '  SHARED_TWO: 2', 'services:', ...services);
  const result = scanYamlDeploy('compose', text);
  assert.equal(result.untrusted, false);
  assert.equal(result.found.length, 20 * 3);
  assert.ok(result.work <= MAX_WORK_PER_CHARACTER * text.length, `work ${result.work} for ${text.length} characters`);
  const cycle = scanYamlDeploy('compose', lines('services:', '  s:', '    environment: &e', '      <<: *e', '      A: 1'));
  assert.equal(cycle.untrusted, true);
});

test('F3: with no parser the YAML files are skipped with one notice and the Dockerfile is still read', async () => {
  const dir = await makeProject({ 'docker-compose.yml': lines('services:', '  a:', '    environment:', '      YAML_NAME: 1'), '.gitlab-ci.yml': lines('variables:', '  CI_NAME: 1'), Dockerfile: 'ARG DOCKER_NAME\n' });
  const collected = collectProject(dir, [], new Date(), false);
  assert.deepEqual(collected.notices, ['yaml parser not installed: 2 deploy files not read; run scripts/install.sh']);
  assert.deepEqual(Object.keys(collected.deploy), ['DOCKER_NAME']);
  assert.match(formatList(collected), /^yaml parser not installed: 2 deploy files not read; run scripts\/install\.sh$/m);
  assert.deepEqual(scanDeploy('compose', 'services: {}\n', false), { mentions: [], unconfirmed: [], hidden: 0, untrusted: false, parserMissing: true });
});

test('F3: loadYamlParser gives null for a folder with no yaml package, and reads the entry file the package.json names', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'env-names-no-yaml-'));
  assert.equal(await loadYamlParser(pathToFileURL(`${empty}/`)), null);
  const real = await loadYamlParser();
  assert.equal(typeof real.parseAllDocuments, 'function');
});

test('F3: a node_modules/yaml in a parent folder or in the scanned project is never loaded', async () => {
  const fakeYaml = 'require("node:fs").writeFileSync(__dirname + "/loaded.txt", "x");\nmodule.exports = { parseAllDocuments() { return []; } };\n';
  const fakePackage = JSON.stringify({ name: 'yaml', version: '0.0.0', main: './index.js', exports: { '.': { node: './index.js' } } });
  for (const place of ['parent folder of the tool', 'scanned project that holds the tool']) {
    const root = await mkdtemp(join(tmpdir(), 'env-names-planted-'));
    const project = place === 'parent folder of the tool' ? join(root, 'project') : root;
    const toolCopy = place === 'parent folder of the tool' ? join(root, 'tool') : join(root, 'tools', 'env-names');
    await cp(TOOL_DIR, toolCopy, { recursive: true, filter: (source) => !source.includes('node_modules') });
    await mkdir(join(root, 'node_modules', 'yaml'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'yaml', 'package.json'), fakePackage);
    await writeFile(join(root, 'node_modules', 'yaml', 'index.js'), fakeYaml);
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'docker-compose.yml'), lines('services:', '  a:', '    environment:', '      PLANTED_NAME: 1'));
    const result = spawnSync(process.execPath, [join(toolCopy, 'env-names.mjs'), 'list', project], { encoding: 'utf8' });
    assert.equal(result.status, 0, place);
    assert.match(result.stdout, /^yaml parser not installed: 1 deploy files not read; run scripts\/install\.sh$/m, place);
    assert.doesNotMatch(result.stdout, /PLANTED_NAME/, place);
    assert.equal(existsSync(join(root, 'node_modules', 'yaml', 'loaded.txt')), false, `${place}: the planted module ran`);
  }
});
