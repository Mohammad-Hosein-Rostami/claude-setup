// Tests for the output rule and the structured-file rule (second defences after the parsers): a name from an env file is
// printed only when it is UPPER_SNAKE or lower_snake of at most 64 characters, or code or a deploy file names it too; the
// others are counted. `.env.yaml`-style files are not env files. Also the audit inputs end to end through the CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { PEM_BEGIN, PEM_END, leaked, makeProject, run } from './env-names-fixtures.mjs';

const listJson = (dir, ...extra) => JSON.parse(run(['list', dir, '--json', ...extra]).stdout);

test('structured files named like env files (.yaml .yml .json .toml) are listed as not read and never parsed', async () => {
  const body = 'PRIVATE_KEY: |\n  ZqxYamlLine0=\n';
  const dir = await makeProject({ '.env.yaml': body, '.env.yml': body, '.env.json': '{"ZqxJson": "x"}', '.env.toml': 'ZqxToml = 1\n', '.env': 'REAL=1\n' });
  const result = run(['list', dir]);
  for (const name of ['.env.yaml', '.env.yml', '.env.json', '.env.toml']) assert.match(result.stdout, new RegExp(`${name.replace('.', '\\.')} {2}\\(not read \\(structured file\\)\\)`));
  assert.deepEqual(leaked(result.all), []);
  assert.doesNotMatch(result.all, /Zqx|PRIVATE_KEY/);
  assert.match(result.stdout, /\.env {2}\(1 name\)/);
});

test('odd-shaped names from an env file are counted, not printed; a name code reads is printed', async () => {
  const longName = `ZQX${'L'.repeat(1200)}`;
  const dir = await makeProject({
    '.env': `ZQX_OK=1\nlower_ok=2\nZqxMixedCase=3\nZqxAlsoMixed=4\n${longName}=5\nReadByCode=6\n`,
    'src/a.ts': 'process.env.ReadByCode;\n',
  });
  const text = run(['list', dir]);
  assert.match(text.stdout, /\.env {2}\(3 names, 3 names not shown \(mixed case or too long\)\)/);
  assert.doesNotMatch(text.all, /ZqxMixedCase|ZqxAlsoMixed|LLLLLLLL/);
  const json = listJson(dir);
  assert.deepEqual(json.envFiles[0].names, ['ReadByCode', 'lower_ok', 'ZQX_OK'].sort());
  assert.equal(json.envFiles[0].hiddenNames, 3);
});

test('a FIFO named .env is listed as not a regular file and never opened (no hang)', async () => {
  const dir = await makeProject({ 'a.txt': 'x\n' });
  if (spawnSync('mkfifo', [join(dir, '.env')]).status !== 0) return; // no mkfifo on this platform: nothing to open
  const result = spawnSync(process.execPath, [new URL('../home/tools/env-names/env-names.mjs', import.meta.url).pathname, 'list', dir], { encoding: 'utf8', timeout: 8000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\.env {2}\(not a regular file, not read\)/);
});

test('audit inputs end to end: every printed name was planted as a name, no fragment is printed', async () => {
  const pemBody = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7', 'ZqxLastLineAbc0=='].join('\n');
  const dir = await makeProject({
    '.env': `PRIVATE_KEY=${PEM_BEGIN}\n${pemBody}\n${PEM_END}\nAFTER_PEM=1\n`,
    'colon/.env': `KEY: "${PEM_BEGIN}\nZqxColonPad==\n${PEM_END}"\nAFTER_COLON: 1\n`,
    'totp/.env': 'TOTP=\nZQXTOTPABCDEFG2====\n',
    'escaped/.env': "K='abc\\'\nZqxSqEsc=1\n'\nAFTER_ESCAPED=1\n",
    'docker/Dockerfile': 'ENV TOKEN_ENV=ZqxFirstHalf\\\nZqxSecondHalf\nENV ZQX_NAME=\\\nZqxWholeToken\nENV A=x ZqxWord\n',
  });
  const json = run(['list', dir, '--json']);
  const planted = new Set(['PRIVATE_KEY', 'AFTER_PEM', 'KEY', 'AFTER_COLON', 'TOTP', 'K', 'AFTER_ESCAPED', 'TOKEN_ENV', 'ZQX_NAME', 'A']);
  const parsed = JSON.parse(json.stdout);
  const printed = [...parsed.envFiles.flatMap((file) => file.names), ...Object.keys(parsed.deploy)];
  assert.deepEqual(printed.filter((name) => !planted.has(name)), []);
  assert.ok(printed.includes('KEY') && printed.includes('TOTP') && printed.includes('ZQX_NAME'));
  assert.doesNotMatch(run(['list', dir]).all + json.all, /Zqx|ZQXTOTP|MIIEvQ/);
});
