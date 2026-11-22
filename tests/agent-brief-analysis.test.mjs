// Tests for the analysis-brief exception of the design line in home/hooks/lib/agent-brief.mjs (used by agent-model-guard.mjs): an
// architect or Plan brief whose first non-empty line starts `analysis:` (after blanks) is an analysis brief and gets no Reuse inventory /
// Contract facts line; every other architect or Plan brief is a spec brief and still gets it, also with `analysis:` deeper in it. The project folder holds an empty
// `.git` folder, so no STATUS.md line is added and only the design line is in play.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { withBriefLines } from '../home/hooks/lib/agent-brief.mjs';
import { hookEnv } from './hook-env.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/agent-model-guard.mjs', import.meta.url));
const HOOK_TIMEOUT_MS = 5000; // settings/base.json gives the hook 5 s
const QUESTION = 'Compare the two status line designs and recommend one.';
const DESIGN_LINE_START = 'Your spec must include "Reuse inventory"';

/** @returns {string} a project folder that is a git root with no STATUS.md */
function projectFolder() {
  const project = makeTempDir('brief-analysis-');
  mkdirSync(join(project, '.git'));
  return project;
}

test('an analysis brief to architect or Plan gets no design line when analysis: opens its first non-empty line', () => {
  const cwd = projectFolder();
  for (const type of ['architect', 'Plan']) {
    for (const prompt of [`analysis: ${QUESTION}`, `\n  \n  analysis: ${QUESTION}`, `\r\nanalysis:\r\n${QUESTION}`]) {
      assert.equal(withBriefLines({ prompt, subagent_type: type }, cwd), null, `${type}: ${JSON.stringify(prompt)}`);
    }
  }
});

test('a spec brief still gets the design line: analysis: deeper in it (pasted text), inside a line or in another case changes nothing', () => {
  const cwd = projectFolder();
  const pasted = `Write the spec for the cache.\nPasted config:\n  analysis: enabled\n${QUESTION}`;
  for (const prompt of [QUESTION, pasted, `Context first.\nanalysis: ${QUESTION}`, `Write the spec. Not an analysis: ${QUESTION}`, `Analysis: ${QUESTION}`, `ANALYSIS: ${QUESTION}`]) {
    const out = withBriefLines({ prompt, subagent_type: 'architect' }, cwd);
    assert.ok(out?.prompt.startsWith(`${prompt}\n${DESIGN_LINE_START}`), JSON.stringify(prompt));
  }
});

test('through the hook: an architect analysis brief passes untouched, a spec brief gets the design line', () => {
  const cwd = projectFolder();
  const home = makeTempDir('brief-analysis-home-');
  const send = (prompt) => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: 'analysis1', cwd, tool_name: 'Agent', tool_input: { prompt, subagent_type: 'architect' } }),
    encoding: 'utf8', env: hookEnv({ HOME: home, USERPROFILE: home }), timeout: HOOK_TIMEOUT_MS,
  });
  const analysis = send(`analysis: ${QUESTION}`);
  assert.equal(analysis.status, 0, analysis.stderr);
  assert.equal(analysis.stdout, '', 'nothing to add: the call runs as sent');
  const spec = send(QUESTION);
  assert.equal(spec.status, 0, spec.stderr);
  assert.match(JSON.parse(spec.stdout).hookSpecificOutput.updatedInput.prompt, new RegExp(`^${QUESTION}\\n${DESIGN_LINE_START}`));
});
