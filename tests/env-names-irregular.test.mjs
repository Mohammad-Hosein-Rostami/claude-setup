// Tests for the regular-file rule (second audit): a file is regular only when every line is blank, a comment or one complete
// definition. From an irregular file a name is shown only when code or a deploy file names it too. Inputs are the ones from the
// security re-audit (made-up words with the marker "zqx_", any case; the underscore keeps the
// marker out of random temp folder and snapshot names, which hold only letters and digits).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRegularEnvText, namesFromEnvText } from '../home/tools/env-names/lib/env-file-names.mjs';
import { PEM_BEGIN, PEM_END, everythingPrinted, makeProject, run } from './env-names-fixtures.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const lines = (...parts) => `${parts.join('\n')}\n`;
const HIDDEN_NOTE = 'this file has multi-line or unusual values; only names also found in code or deploy files are listed';

const REAUDIT_INPUTS = {
  'NEW-1 heredoc then blank line': lines("read -r -d '' APP_CONFIG <<'EOF'", 'zqx_user=admin', '', 'zqx_password=Zqx_Pw1', 'ZQX_UPPERPASSPHRASE=', 'EOF', 'AFTER=1'),
  'NEW-1 command substitution heredoc': lines("export CERT_INFO=$(cat <<'EOF'", 'zqx_line=1', '', 'zqx_innerkey=Zqx_V', 'EOF', ')', 'AFTER=1'),
  'NEW-1 here-string': lines('export DECODED=$(base64 -d <<< "multi', '', 'zqx_k=', '")', 'AFTER=1'),
  'NEW-1 shell if block': lines('if [ -n "$CI" ]; then', "  read -r -d '' X <<'EOF'", '  zqx_a=1', '', 'zqx_user=Zqx_U', 'EOF', 'fi', 'AFTER=1'),
  'NEW-1 unquoted JSON value': lines('GOOGLE_CREDS={', '  "type": "service",', '', 'zqx_inner=', '}', 'AFTER=1'),
  'NEW-1 colon form after a blank line': lines('JUNK words here', '', 'zqx_apikey: Zqx_V', 'CORRECTZQX_HORSEBATTERY=', 'AFTER=1'),
  'NEW-1 quote not at the start of the value': lines('JAVA_OPTS=-Dpass="multi', '', 'zqx_inner=', '"', 'AFTER=1'),
  'NEW-2 END line inside a quoted value': lines(`TLS_BUNDLE="${PEM_BEGIN}`, 'MIIBabc', PEM_END, 'zqx_passphrase=Zqx_Pass', 'ZQX_HEXKEY0123ABCDEF=', '"', 'AFTER=1'),
  'NEW-8 lone CR inside a value': 'K=abc\rZQX_HALFSECRET=\nAFTER=1\n',
};

test('re-audit inputs: nothing value-derived is printed anywhere (text, --json, snapshot, diff)', async () => {
  for (const [label, env] of Object.entries(REAUDIT_INPUTS)) {
    for (const eol of ['\n', '\r\n']) {
      const content = eol === '\n' || env.includes('\r') ? env : env.replace(/\n/g, '\r\n');
      const { text } = await everythingPrinted({ '.env': content });
      assert.doesNotMatch(text, /zqx_/i, `${label} (${JSON.stringify(eol)})`);
      assert.match(text, /irregular/, label);
    }
  }
});

test('re-audit inputs: the parser alone never returns the fragments either (second defence for the quote and END cases)', () => {
  const bundle = namesFromEnvText(REAUDIT_INPUTS['NEW-2 END line inside a quoted value']);
  assert.deepEqual(bundle.names, ['AFTER', 'TLS_BUNDLE']);
  assert.deepEqual(namesFromEnvText(lines(`K="${PEM_BEGIN}`, PEM_END, 'zqxafter=1', '"', 'B=2')).names, ['B', 'K']);
});

test('a -----END line ends only the PEM state: a quote that does not close on that line stays open, one that closes after it closes', () => {
  assert.deepEqual(namesFromEnvText(lines(`K="${PEM_BEGIN}`, `${PEM_END}`, 'zqxinside=1', '"', 'B=2')).names, ['B', 'K']);
  assert.deepEqual(namesFromEnvText(lines(`K="${PEM_BEGIN}`, `${PEM_END}"`, 'C=3')).names, ['C', 'K']);
});

test('isRegularEnvText: what is regular and what is not', () => {
  const regular = ['', '# only a comment\n', 'A=1\nexport B=2\nC = 3\n', 'A="quoted value" # note\nB=\'x\'\nC=`y`\n', 'A=a=b\n', 'A=\n\n\n# c\nB=2', 'A=x # it is fine', '\uFEFFA=1\r\nB=2\r\n', 'A=-Da="x" -Db=\'y\'\n'];
  const irregular = [
    'A=1\nstray line\n', 'A: 1\n', 'A="open\nclose"\n', "A='open\n", 'A=abc\\\n', 'A=abc\rB=1\n', 'A=1\0B=2\n', `A=${PEM_BEGIN}\n`, 'A=<<EOF\n', 'A=$(cat <<EOF)\n',
    "A=$'x'\n", 'A="x" tail\n', 'A=-Dp="multi\n', 'A====\n', 'A==\n', '{\n', 'A=1\n}\n', '1ABC=1\n', 'has space=1\n',
  ];
  for (const text of regular) assert.equal(isRegularEnvText(text), true, JSON.stringify(text));
  for (const text of irregular) assert.equal(isRegularEnvText(text), false, JSON.stringify(text));
});

test('a regular file and its irregular twin (one multi-line value more): names shown vs hidden; names code reads are shown in both', async () => {
  const regular = lines('CORR_ONE=1', 'zqxplain=2', 'OTHER_UPPER=3');
  const twin = `${regular}MULTI="first line\nsecond line"\n`;
  const dir = await makeProject({ 'regular/.env': regular, 'twin/.env': twin, 'src/a.ts': 'process.env.CORR_ONE;\n' });
  const json = JSON.parse(run(['list', dir, '--json']).stdout);
  const byPath = Object.fromEntries(json.envFiles.map((file) => [file.path, file]));
  assert.deepEqual(byPath['regular/.env'].names, ['CORR_ONE', 'OTHER_UPPER', 'zqxplain']);
  assert.equal(byPath['regular/.env'].irregular, undefined);
  assert.deepEqual(byPath['twin/.env'].names, ['CORR_ONE']);
  assert.equal(byPath['twin/.env'].irregular, true);
  assert.equal(byPath['twin/.env'].hiddenNames, 3); // zqxplain, OTHER_UPPER, MULTI
  const text = run(['list', dir]).stdout;
  assert.match(text, new RegExp(`twin/\\.env {2}\\(1 name, 1 other line, 3 names not shown \\(${HIDDEN_NOTE.replace(/[;()]/g, '\\$&')}\\), irregular\\)`));
  assert.match(text, /regular\/\.env {2}\(3 names\)/);
});

test('a name a deploy file names (key position) also corroborates an irregular file', async () => {
  const dir = await makeProject({ '.env': lines('FROM_DEPLOY=1', 'zqxhidden=2', 'stray line'), 'docker-compose.yml': 'services:\n  a:\n    environment:\n      FROM_DEPLOY: x\n' });
  assert.deepEqual(JSON.parse(run(['list', dir, '--json']).stdout).envFiles[0].names, ['FROM_DEPLOY']);
});

test('diff compares hidden names by count only, and notes an irregular flip', async () => {
  const dir = await makeProject({ '.env': lines('CORR_ONE=1', 'stray line', '', 'zqx_a=1', 'zqx_b=2', 'zqx_c=3'), 'src/a.ts': 'process.env.CORR_ONE;\n' });
  const snapshot = join(makeTempDir('sibling-'), `hidden-${Math.random().toString(36).slice(2)}.json`);
  assert.equal(run(['list', dir, '--save', snapshot]).status, 0);
  assert.equal(run(['diff', snapshot, dir]).status, 0);
  const saved = JSON.parse(await readFile(snapshot, 'utf8'));
  assert.deepEqual([saved.envFiles[0].irregular, saved.envFiles[0].hiddenNames], [true, 3]);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(dir, '.env'), lines('CORR_ONE=1', 'stray line', '', 'zqx_a=1', 'zqx_renamed=2'));
  const changed = run(['diff', snapshot, dir]);
  assert.equal(changed.status, 1);
  assert.match(changed.stdout, /Names not shown changed \(counts only\) \(1\):\n {2}\.env {2}names not shown: 3 -> 2\n/);
  assert.doesNotMatch(changed.all, /zqx_/i);
  await writeFile(join(dir, '.env'), lines('CORR_ONE=1', 'zqx_a=1', 'zqx_renamed=2'));
  const flipped = run(['diff', snapshot, dir]);
  assert.match(flipped.stdout, /\.env {2}names not shown: 3 -> 0; irregular: yes -> no/);
  assert.doesNotMatch(flipped.stdout, /Names changed in env files/); // names shown under different rules are not compared
});

test('fuzz: irregular files never print an uncorroborated name or a zqx word; regular files print exactly their definitions', async () => {
  let seed = 424242;
  const next = (limit) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 16) % limit;
  };
  const triggers = [
    () => "read -r -d '' APP <<'EOF'", () => 'EOF', () => '}', () => '  "k": "v",', () => 'plain prose line', () => 'JAVA=-Dp="multi', () => `TLS="${PEM_BEGIN}`,
    () => PEM_END, () => 'V=abc\\', (i) => `zqx_colon_${i}: x`, (i) => `K=abc\rZQX_HALF_${i}=`, () => 'X=$(cat <<EOF', () => 'B64==',
  ];
  const definitions = [(i) => `zqx_junk_${i}=x`, (i) => `ZQX_UPPER_${i}=`, (i) => `NAME_${i}="MARKER_VALUE"`, (i) => `NAME_${i}=a=b # MARKER_COMMENT`, () => '', () => '# MARKER_COMMENT=x'];
  for (let round = 0; round < 40; round += 1) {
    const body = ['CORR_ONE=1']; // first, so no earlier line can swallow it
    let triggered = false;
    const planted = new Set();
    for (let i = 0; i < 12; i += 1) {
      const useTrigger = next(3) === 0 && round % 4 !== 3;
      const make = useTrigger ? triggers[next(triggers.length)] : definitions[next(definitions.length)];
      const line = make(`${round}_${i}`);
      triggered ||= useTrigger;
      const defined = /^(?:zqx_junk_|ZQX_UPPER_|NAME_)\w+/.exec(line);
      if (!useTrigger && defined) planted.add(defined[0]);
      body.push(line);
    }
    const dir = await makeProject({ '.env': `${body.join('\n')}\n`, 'src/a.ts': 'process.env.CORR_ONE;\n' });
    const result = run(['list', dir, '--json']);
    const entry = JSON.parse(result.stdout).envFiles[0];
    const where = JSON.stringify(body);
    if (triggered) {
      assert.equal(entry.irregular, true, where);
      assert.deepEqual(entry.names, ['CORR_ONE'], where);
      assert.doesNotMatch(result.all + run(['list', dir]).all, /zqx_|MARKER_/i, where);
    } else {
      assert.equal(entry.irregular, undefined, where);
      assert.deepEqual(entry.names, ['CORR_ONE', ...planted].sort(), where);
    }
  }
});
