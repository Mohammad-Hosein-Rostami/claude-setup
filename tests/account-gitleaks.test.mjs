// Tests for the repo's secret scanner config (.gitleaks.toml) against the secret of the account tool (security review
// 1, S9): a Claude login token of the `claude setup-token` shape in a file is found, as the API-key shape is. The
// made-up token is built from parts at run time and written only into a temp folder, so no file of the repo holds one.
// Defined where gitleaks is installed (the pre-commit hook needs it there too).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';

const CONFIG = fileURLToPath(new URL('../.gitleaks.toml', import.meta.url));
const HAS_GITLEAKS = spawnSync('gitleaks', ['version'], { encoding: 'utf8' }).status === 0;
const EXIT_LEAKS = 1;
const body = (length) => 'MadeUpGitleaksQ7x'.repeat(10).slice(0, length);
const oauthToken = () => `${['sk', 'ant', 'oat01', ''].join('-')}${body(95)}`;

/** Runs gitleaks on a temp folder holding one start-up line with `value`; returns its exit code (1 = leaks found). */
function scan(variable, value) {
  const dir = makeTempDir('account-gitleaks-');
  writeFileSync(join(dir, 'start.sh'), `export ${variable}="${value}"\n`, { mode: 0o600 });
  const run = spawnSync('gitleaks', ['dir', '--redact', '--no-banner', '--config', CONFIG, dir], { encoding: 'utf8', env: cleanEnv({ HOME: dir }) });
  assert.ok(!`${run.stdout}${run.stderr}`.includes(value), 'gitleaks redacts what it finds');
  return run.status;
}

test('gitleaks: a login token of the setup-token shape in a file is a leak; a plain word after sk-ant- is not', { skip: !HAS_GITLEAKS && 'gitleaks is not installed' }, () => {
  assert.equal(scan('CLAUDE_CODE_OAUTH_TOKEN', oauthToken()), EXIT_LEAKS, 'the OAuth token shape is found');
  assert.equal(scan('NOTE', `${['sk', 'ant', ''].join('-')}example`), 0, 'a short word is not a token');
});
