// Tests that every text a check line shows only the start of is masked before it is cut (review round 4, R3): formatLine's
// 400-character cut, and the report and command texts that E6 reads from the transcripts (which nothing redacted before). A
// registered login of no known shape that straddles the cut must leave no part of itself in the line; a cut first would leave its
// head, which the exact-value mask no longer matches. No real `claude` runs: transcripts come from tests/e2e-fixtures.mjs, written
// into temp folders.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { bash, say, writeSession } from './e2e-fixtures.mjs';
import { LOGIN_ENV, useLogin } from './e2e/lib/env.mjs';
import { redactedSlice, REDACTED } from './e2e/lib/redact.mjs';
import { formatLine, OBSERVED_MAX_CHARS } from './e2e/lib/report.mjs';
import * as E6 from './e2e/scenarios/E6.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const VALUE = 'made-up-cut-login-value-0055-abcdefghij'; // no sk-ant- shape: only the exact-value mask catches it
const HEAD = VALUE.slice(0, REDACTED.length); // the part of VALUE a cut REDACTED.length chars after its start keeps

/** A text whose VALUE starts REDACTED.length chars before `cut`, so a cut at `cut` goes through it. */
const straddling = (cut, lead = '') => `${lead}${'x'.repeat(cut - REDACTED.length - lead.length)}${VALUE} tail`;

/** Runs `body` with VALUE registered as the run's login and no terminal token (the stored-login case). */
function withLogin(body) {
  const kept = process.env[LOGIN_ENV];
  delete process.env[LOGIN_ENV];
  try {
    useLogin(VALUE);
    body();
  } finally {
    useLogin(null);
    if (kept !== undefined) process.env[LOGIN_ENV] = kept;
  }
}

const byName = (lines) => Object.fromEntries(lines.map((line) => [line.check, line]));
const assertMasked = (observed, where) => {
  assert.ok(!observed.includes(HEAD), `${where}: ${observed.slice(-60)}`);
  assert.ok(observed.includes(REDACTED), `${where}: the value was there, masked`);
};

test('redactedSlice and formatLine: a registered value cut in two leaves no part of itself', () => {
  withLogin(() => {
    assert.equal(redactedSlice(straddling(40), 40), `${'x'.repeat(40 - REDACTED.length)}${REDACTED}`);
    const line = formatLine('E3', { check: 'c', expected: straddling(OBSERVED_MAX_CHARS), observed: straddling(OBSERVED_MAX_CHARS), pass: false });
    assertMasked(line, 'formatLine');
  });
});

test("E6: max's report and a push command of its Bash are masked before their 120- and 80-character cuts", () => {
  withLogin(() => {
    const dir = makeTempDir('harness-cuts-e6-');
    for (const sub of ['repo', 'tmp']) mkdirSync(join(dir, sub));
    const paths = { projectsDir: join(dir, 'projects'), tmp: join(dir, 'tmp'), stateDir: join(dir, 'state') };
    const maxLines = [...bash('b1', straddling(80, 'git push origin main # ')), say(straddling(120), 9)];
    writeSession(paths.projectsDir, join(dir, 'repo'), { sessionId: 'rel', lines: [say('go')], agents: [{ id: 'm1', type: 'max', lines: maxLines }] });
    const ctx = { dry: false, dir, repo: join(dir, 'repo'), origin: join(dir, 'origin.git'), paths, sessions: [], git: () => ({ code: 0, stdout: 'refs', stderr: '' }),
      notes: { originBefore: 'refs', release: { session: { sessionId: 'rel' }, originRefs: 'refs', prod: [] } } };
    const lines = byName(E6.check(ctx));
    assertMasked(lines['release: max reported ship-ready:'].observed, 'E6 report');
    assertMasked(lines['release: no push or deploy in the Bash of max or its helpers'].observed, 'E6 command');
  });
});
