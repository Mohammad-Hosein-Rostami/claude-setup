// Tests the Bash guard on the 31 rm asks of the real run (spec X8, lane guard-rm): deletes of the session's own scratch folder and of
// `cs-test-*` folders that waited 2 minutes for an answer. Each row of tests/fixtures/guard-real-run/rm-scratch-asks.json (synthetic
// names and paths, the shape of the logged line kept) is decided as its `expect` column says: a path not there yet, a variable the line
// sets, a link maker after the delete run unasked; a command that may make links before a delete (docker, cp, git, mv, node, go) keeps
// asking. A fake temp root (TMPDIR, a `cs-test-` folder) holds the session tree; the hook input's session_id names the session. Command
// strings are only passed to decide(); nothing they name is executed.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { makeTempDir, removeTempDir } from './temp-dir-helpers.mjs';

const TEMP = makeTempDir('rm-real-run-');
process.env.TMPDIR = TEMP; // the guard reads its temp root when it loads, so it loads after this
const { decide } = await import('../home/hooks/pre-bash-guard.mjs');
after(() => removeTempDir(TEMP));

const SESSION_ID = '5d6c7b8a-1f2e-4d3c-8b9a-0e1f2a3b4c5d';
const SCRATCH = join(TEMP, 'claude-501', '-Users-dev-desk', SESSION_ID, 'scratchpad');
mkdirSync(SCRATCH, { recursive: true }); // the scratchpad is there; nothing the rows delete is
const PROJECT = '/work/desk';
const FIXTURE = new URL('./fixtures/guard-real-run/rm-scratch-asks.json', import.meta.url);
const { rows } = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const EXPECTED_ROWS = 31; // the post-FR6 timed-out rm asks the spec counted (fixes-spec X8)
const filled = (text) => text.replaceAll('{S}', SCRATCH).replaceAll('{T}', TEMP);
const decided = (row) => decide(filled(row.command), { cwd: row.cwd, project: PROJECT, sessionId: SESSION_ID });

const EXPECTS = ['allow', 'ask', 'bounce']; // bounce: the delete runs unasked, another rule (named in why) bounces the line once
const deleteAsk = (got) => (got.reasons ?? []).some((reason) => reason.startsWith('DESTRUCTIVE: '));

test('the fixture holds the 31 rows, numbered once each, every one with a known expect and a why', () => {
  assert.equal(rows.length, EXPECTED_ROWS);
  assert.deepEqual(rows.map((row) => row.id), Array.from({ length: EXPECTED_ROWS }, (_, at) => at + 1));
  for (const row of rows) assert.ok(EXPECTS.includes(row.expect) && row.why.length > 0, `row ${row.id}`);
});

test('each real-run row is decided as its expect column says', () => {
  for (const row of rows) {
    const got = decided(row);
    const label = `row ${row.id} (${row.why}): ${got.reason}`;
    if (row.expect === 'allow') assert.equal(got.ask, undefined, label);
    else if (row.expect === 'bounce') assert.ok(got.ask === true && !deleteAsk(got), label);
    else assert.ok(deleteAsk(got), label);
  }
});

test('the rows that run unasked cover each cause the spec names, and a link maker before the delete keeps asking', () => {
  const allowed = rows.filter((row) => row.expect !== 'ask').map((row) => row.why);
  for (const cause of ['not there yet', 'same-line literal', 'same-line mktemp -d template', 'after the delete']) {
    assert.ok(allowed.some((why) => why.includes(cause)), cause);
  }
  const before = rows.filter((row) => / before the delete may make/.test(row.why));
  assert.ok(before.length > 0 && before.every((row) => row.expect === 'ask'));
});
