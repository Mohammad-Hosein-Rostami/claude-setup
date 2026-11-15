// Consistency checks between the mode list in mode.mjs, the playbooks, ccm, docs/modes.md, home/CLAUDE.md and home/modes/_lead.md
// (node:test, no dependencies). A mode added to MODES must show up everywhere or one of these tests fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MODES } from '../home/hooks/mode.mjs';

const read = (relative) => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
const SESSION_ONLY_ENDING = 'Applies to this session only.';

test('every mode has a playbook ending with the session-only line', () => {
  for (const mode of MODES) {
    const playbook = read(`home/modes/${mode}.md`).trimEnd();
    assert.ok(playbook.endsWith(SESSION_ONLY_ENDING), `${mode}.md must end with "${SESSION_ONLY_ENDING}"`);
  }
});

const LANE_BUDGETS = { normal: 2, medium: 3, high: 6, 'extra-high': 6, 'ultra-high': 8 };

test('every playbook states its lane budget', () => {
  for (const mode of MODES) {
    assert.match(read(`home/modes/${mode}.md`), new RegExp(`Lane budget: (up to )?${LANE_BUDGETS[mode]} agents? at`), `${mode}.md lane budget`);
  }
});

test('_lead.md carries the lead-discipline rules and stays small', () => {
  const lead = read('home/modes/_lead.md');
  for (const needle of ['Persian', 'No turn without a decision', 'runner', '2nd compaction', 'usage-limit', 'STATUS.md', '3k chars', 'restart the session', 'No answer in 60 s','≤ 300 words', 'continue them with SendMessage', 'estimate.mjs']) {
    assert.ok(lead.includes(needle), `_lead.md must mention ${needle}`);
  }
  assert.ok(lead.split('\n').length <= 100, '_lead.md is injected into every session; keep it <= 100 lines');
});

test('ultra-high playbook keeps the assembly and compact-before-waiting rules', () => {
  const playbook = read('home/modes/ultra-high.md');
  assert.match(playbook, /Workflow assembly is not judgment/);
  assert.match(playbook, /max 1 continuation/);
  assert.match(playbook, /`\/compact` first/);
});

test('home/CLAUDE.md names Persian replies, the STATUS.md re-read and the Grep tool or rg', () => {
  const text = read('home/CLAUDE.md');
  assert.match(text, /Persian included/);
  assert.match(text, /`STATUS\.md` path/);
  assert.match(text, /Grep tool or `rg`/);
  assert.match(text, /Git push[\s\S]*confirm dialog even in bypass mode[\s\S]*auto-allow after 3 minutes[\s\S]*literal password or token/);
});

test('ccm, docs/modes.md, home/CLAUDE.md and home/modes/_lead.md mention all five modes', () => {
  assert.equal(MODES.length, 5);
  for (const file of ['home/bin/ccm', 'docs/modes.md', 'home/CLAUDE.md', 'home/modes/_lead.md']) {
    const text = read(file);
    for (const mode of MODES) assert.ok(text.includes(mode), `${file} must mention ${mode}`);
  }
});

test('home/CLAUDE.md keeps the standing-rules, delegation-size and usage-limit bullets (L22)', () => {
  const text = read('home/CLAUDE.md');
  assert.match(text, /goes into STATUS\.md under `## Standing rules` the moment it is given, in the owner's words; every brief names that file; re-read it after a compaction or a resume\./);
  assert.match(text, /Size a delegated job to finish within about 120 tool calls; split a bigger one into stages with a commit between them\. An agent that returns without its report is continued once \("commit, then report"\), not restarted\./);
  assert.match(text, /At a usage limit: read the reset time from the message, tell the owner that time, and schedule ONE wake a few minutes after it\. Never retry before the reset\./);
});

test('ui-coverage hand-over step gives ONE link to the visual overview', () => {
  assert.match(read('home/skills/ui-coverage/SKILL.md'), /Give the owner ONE link, to the visual overview \(a preview or side-by-side per state\), open it yourself first and check it shows what you describe; never hand over a bare index of routes or a mock's default listing\./);
});

// L30 stage 2: sessions paste the estimate tool's Finish block and record the closing and rework rows that feed it.
const LEAD_ESTIMATE_RULE = '- Multi-day: `STATUS.md` `## Work items`, a row per owner request or correction before work starts. Estimates: paste the `Finish:` block of `node ~/.claude/tools/estimate/estimate.mjs STATUS.md`, never your own.';
const GLOBAL_ESTIMATE_RULE = '- Work with a `STATUS.md`: every owner request and every owner correction becomes a `## Work items` row before work on it starts (a correction\'s item starts `rework:`; never clear a done cell). Review, fixes from a review, recheck and landing rows start `close:`, or are left to the tool\'s closing phase; never fold them into a build row. Set started and done when they happen. Every estimate you give is the `Finish:` block of `node ~/.claude/tools/estimate/estimate.mjs STATUS.md` pasted as-is with its Excludes and After lines, never a number or clock time of your own; re-run it whenever rows change; if it refuses, give its reason and its What to do.';

test('the estimate rules are verbatim in _lead.md and home/CLAUDE.md, and the old bullet is gone', () => {
  assert.ok(read('home/modes/_lead.md').split('\n').includes(LEAD_ESTIMATE_RULE), '_lead.md estimate line');
  const global = read('home/CLAUDE.md');
  assert.ok(global.split('\n').includes(GLOBAL_ESTIMATE_RULE), 'home/CLAUDE.md estimate rule');
  assert.doesNotMatch(global, /end that reply with the new finish estimate/);
  assert.match(read('docs/daily-use.md'), /pastes the `Finish:` block of `node ~\/\.claude\/tools\/estimate\/estimate\.mjs STATUS\.md` as every estimate/);
});
