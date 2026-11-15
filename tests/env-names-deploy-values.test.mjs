// Tests for deploy files, second audit: quoted YAML values that continue over lines (and block scalars) are skipped, a quote that
// never closes stops trusting the file, Dockerfile heredoc bodies are skipped, and compose `$${NAME}` is a literal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanDeploy } from '../home/tools/env-names/lib/deploy-names.mjs';
import { PEM_BEGIN, PEM_END } from './env-names-fixtures.mjs';

const names = (kind, text) => scanDeploy(kind, text).mentions.map((mention) => mention.name);
const compose = (...entries) => `services:\n  a:\n    environment:\n${entries.map((entry) => `      ${entry}`).join('\n')}\n`;

test('compose: a double-quoted value continued at the key indent gives no trusted name (the block is irregular: its names print only when code reads them)', () => {
  assert.deepEqual(names('compose', compose(`CERT: "${PEM_BEGIN}`, 'ZqxCertKey: abc', `${PEM_END}"`, 'AFTER: 1')), []);
});

test('compose: single-quoted, list-form and escaped-quote continuations', () => {
  assert.deepEqual(names('compose', compose("NOTE: 'line one", 'zqxpassword: ZqxV', "'", 'AFTER: 1')), []);
  assert.deepEqual(names('compose', compose('- "CERT=-----first', '- zqxlooks=1', '"', '- AFTER=1')), []);
  assert.deepEqual(names('compose', compose('NOTE: "has \\" inside', 'zqxinner: 1', '"', 'AFTER: 1')), []);
  assert.deepEqual(names('compose', compose("NOTE: 'it''s", 'zqxinner: 1', "'", 'AFTER: 1')), []);
});

test('workflow and gitlab: the same continued quoted value in env and variables blocks', () => {
  assert.deepEqual(names('workflow', 'jobs:\n  a:\n    steps:\n      - run: x\n        env:\n          CERT: "multi\n          ZqxWfKey: abc\n          "\n          AFTER: 1\n'), []);
  assert.deepEqual(names('gitlab', 'variables:\n  CERT: "multi\n  zqxglkey: abc\n  "\n  AFTER: 1\n'), []);
});

test('a block scalar with any indicator is valid YAML: its key prints, the words inside its text never do', () => {
  for (const indicator of ['|', '>', '|-', '>-', '|+', '>+', '|2', '>2-', '|2+ # note']) {
    assert.deepEqual(names('compose', compose(`SCRIPT: ${indicator}`, '  zqxinner: 1', '  ZqxMixed: 2', 'AFTER: 1')), ['SCRIPT', 'AFTER'], indicator);
  }
});

test('a quote that never closes: the file is untrusted, every name the parser still sees is unconfirmed, none is trusted', () => {
  const text = `${compose('FIRST: 1', 'BROKEN: "never closes', 'zqxlater: 1')}    image: x:\${LATER_SUBSTITUTION}\n`;
  const result = scanDeploy('compose', text);
  assert.deepEqual(result.mentions, []);
  assert.deepEqual(result.unconfirmed.map((mention) => mention.name), ['FIRST', 'BROKEN', 'LATER_SUBSTITUTION']);
});

test('dockerfile: heredoc bodies are skipped for RUN, COPY and ADD, tags quoted or with <<-', () => {
  const text = [
    'FROM node', 'RUN <<EOF', 'env zqxheredocword', 'ARG ZQXHEREDOCUPPER', 'EOF', 'COPY <<EOF /etc/app.conf', 'env production_zqx', 'EOF',
    "RUN cat <<-'TAG' > /x", '\tARG ZQX_IN_TAB_HEREDOC', '\tTAG', 'ARG REAL_ONE', 'ADD <<"END" /y', 'ENV ZQXINADD=1', 'END', 'ENV REAL_TWO=1',
  ].join('\n');
  assert.deepEqual(names('dockerfile', text), ['REAL_ONE', 'REAL_TWO']);
});

test('dockerfile: an arithmetic shift is not a heredoc', () => {
  assert.deepEqual(names('dockerfile', 'RUN echo $((1<<2))\nARG STILL_READ\n'), ['STILL_READ']);
});

test('compose: $${NAME} is an escaped literal and is not a substitution; ${NAME} still is', () => {
  const text = compose('PASSWORD: "ab$${ZqxLiteralInValue}cd"', 'URL: "${REAL_HOST}/x"');
  assert.deepEqual(names('compose', text), ['PASSWORD', 'REAL_HOST', 'URL']);
});
