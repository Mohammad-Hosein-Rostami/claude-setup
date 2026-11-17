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
  for (const needle of ['Persian', 'No turn without a decision', 'runner', '2nd compaction', 'usage-limit', 'STATUS.md', '3k chars', 'restart the session', 'No answer in 2 min','≤ 300 words', 'continue them with SendMessage', 'estimate.mjs']) {
    assert.ok(lead.includes(needle), `_lead.md must mention ${needle}`);
  }
  assert.ok(lead.split('\n').length <= 100, '_lead.md is injected into every session; keep it <= 100 lines');
});

test('ultra-high playbook keeps the assembly and compact-before-waiting rules', () => {
  const playbook = read('home/modes/ultra-high.md');
  assert.match(playbook, /Workflow assembly is not judgment/);
  assert.match(playbook, /continue only reachable items, once; what is still left goes to a fresh agent/);
  assert.match(playbook, /`\/compact` first/);
});

test('home/CLAUDE.md names Persian replies, the STATUS.md re-read and the Grep tool or rg', () => {
  const text = read('home/CLAUDE.md');
  assert.match(text, /Persian included/);
  assert.match(text, /`STATUS\.md` path/);
  assert.match(text, /Grep tool or `rg`/);
  assert.match(text, /Git push[\s\S]*confirm dialog even in bypass mode[\s\S]*auto-allow after 2 min[\s\S]*literal password or token/);
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

// Estimator rebuild stage 3: rows are listed first and edited by status.mjs only, a Stop hook records the hand-over, and every
// estimate is the Finish block pasted as-is.
const LEAD_ESTIMATE_RULE = '- Multi-day: `STATUS.md` `## Work items`: list the job\'s rows first; row edits by `status.mjs` only. Estimates: the `Finish:` block of `node ~/.claude/tools/estimate/estimate.mjs STATUS.md` only.';
const GLOBAL_ESTIMATE_RULE = '- Work with a `STATUS.md`: every owner request and every owner correction becomes `## Work items` rows (`id | item | size S/M/L | started | done | evidence`) before work on it starts: list the whole job first, review, fixes and landing rows (`close:`) included; a correction\'s item starts `rework:`; a step found later is a new row at once; never fold steps into one row, never clear a done cell. Row edits go through `node ~/.claude/tools/status/status.mjs add|start|done|deliver|rule|decision` only, never a typed time: `start` when work on a row begins, `done` with its evidence when it ends. A hand-over is recorded by itself when your turn ends with no open row; `deliver "<what>"` records one while rows stay open. Every estimate you give is the `Finish:` block of `node ~/.claude/tools/estimate/estimate.mjs STATUS.md` pasted as-is, never a number or clock time of your own; the tool keeps one time and says why when it moves; if it refuses, give its reason, and do its What to do and any `Check:` line first.';

test('the estimate rules are verbatim in _lead.md and home/CLAUDE.md, and the old bullet is gone', () => {
  assert.ok(read('home/modes/_lead.md').split('\n').includes(LEAD_ESTIMATE_RULE), '_lead.md estimate line');
  assert.ok(LEAD_ESTIMATE_RULE.length <= 200, '_lead.md is injected into every session: the estimate line stays within 200 characters');
  const global = read('home/CLAUDE.md');
  assert.ok(global.split('\n').includes(GLOBAL_ESTIMATE_RULE), 'home/CLAUDE.md estimate rule');
  assert.doesNotMatch(global, /end that reply with the new finish estimate/);
  assert.match(read('docs/daily-use.md'), /pastes the `Finish:` block of `node ~\/\.claude\/tools\/estimate\/estimate\.mjs STATUS\.md` as every estimate/);
});

// Modes differ in cost and speed only: every accuracy rule lives in home/CLAUDE.md or _lead.md, which every mode loads.
const GATES = ['runner', 'reviewer', 'security-auditor', 'verify-done', 'ui-quality-pass', 'visual-qa', 'ui-coverage'];
const LESS_ACCURACY = [/thrift/i, /\bskip\b/i, /nice-to-have/i, /fewer (checks|reviews|tests)/i, /\bno (review|verify|tests?)\b/i];
// Phrases that drop, skip or lessen a gate or check ("skip the reviewer", "no tests", "verify-done is optional").
// One sentence is checked at a time; a pattern that would also hit an honest sentence is left out (see the fixtures).
const LOWERS_A_GATE = /\b(skip|omit|drop|without|no|fewer|less|leave out)\b[^.;\n]{0,40}\b(runner|reviewers?|security-auditor|verify-done|ui-quality-pass|visual-qa|ui-coverage|reviews?|verif(y|ication)|tests?|checks?)\b/i;
const LOWERS_OTHERWISE = [
  /\bskip\b/i,
  /\bis optional\b/i,
  /\b(one|a single|the first) source is (enough|sufficient)\b/i,
  /\bstop after the first\b/i,
  /\bnot (fixed|listed|checked|reviewed|verified)\b/i,
  /\b(reviews?|reviewer|verify-done)\b[^.;\n]{0,15}\bonly (for|on|when|if)\b/i,
];
const lowersAGate = (sentence) => LOWERS_A_GATE.test(sentence) || LOWERS_OTHERWISE.some((pattern) => pattern.test(sentence));
const SHARED_TEXT_FILES = ['home/modes/_lead.md', ...MODES.map((mode) => `home/modes/${mode}.md`)];

test('every playbook keeps the same gates and none lowers accuracy', () => {
  for (const mode of MODES) {
    const playbook = read(`home/modes/${mode}.md`);
    assert.match(playbook, /same quality gates as every mode/i, `${mode}.md must state the shared gates`);
    for (const pattern of LESS_ACCURACY) assert.doesNotMatch(playbook, pattern, `${mode}.md lowers accuracy: ${pattern}`);
  }
});

test('no sentence of _lead.md or a playbook lowers a gate that home/CLAUDE.md requires', () => {
  const lowering = [
    'Skip the reviewer on small diffs.', 'Do small work without verify-done.', 'Fewer checks in this mode.', 'No tests for quick fixes.',
    'Reviews: only for risky changes.', 'Research: one source is enough.', 'verify-done is optional in this mode.',
    'Leave out the reviewer for one-line fixes.', 'Stop after the first finding that explains the bug.',
    'Reviewer findings marked optional are not fixed or listed.', 'Skip review on small diffs.', 'skip responsive',
  ];
  for (const sentence of lowering) assert.ok(lowersAGate(sentence), `detector must flag: ${sentence}`);
  const honest = [
    'Never downgrade a model or effort pick to save tokens; the quality gates still run.', 'No duplicate agents on the same question.',
    'Gates to risk: one reviewer pass per batch on changed lines; `security-auditor` only auth/secrets/data/money/hooks/untrusted input.',
    're-run browser/responsive checks only for failed, not-run or risky (auth, payments) items.',
  ];
  for (const sentence of honest) assert.ok(!lowersAGate(sentence), `detector must not flag: ${sentence}`);
  for (const file of SHARED_TEXT_FILES) {
    for (const sentence of read(file).split(/(?<=[.;])\s+|\n+/)) assert.ok(!lowersAGate(sentence), `${file} lowers a gate: ${sentence}`);
  }
});

test('every gate is named in home/CLAUDE.md, which every session and agent loads', () => {
  const claude = read('home/CLAUDE.md');
  const section = (heading) => claude.split(/^## /m).find((part) => part.startsWith(heading)) ?? '';
  const qualityGates = section('Quality gates');
  for (const gate of ['runner', 'reviewer', 'security-auditor', 'verify-done', 'ui-quality-pass']) assert.ok(qualityGates.includes(`\`${gate}\``), `Quality gates must name ${gate}`);
  const uiRouting = section('Skill routing (UI)');
  for (const gate of ['visual-qa', 'ui-coverage']) assert.ok(uiRouting.includes(`\`${gate}\``), `Skill routing (UI) must name ${gate}`);
  for (const gate of GATES) assert.ok(claude.includes(`\`${gate}\``), `home/CLAUDE.md must name ${gate}`);
});

test('accuracy rules live in the shared files', () => {
  const claude = read('home/CLAUDE.md');
  assert.match(claude, /re-read the cited lines/);
  assert.match(claude, /second independent source/);
  const lead = read('home/modes/_lead.md');
  for (const needle of ['`architect`, not Plan', '`opus` judges', 'never on accuracy', 'security-critical decision', 'with all it needs', '`security-auditor` `model: "opus", effort: "max"` for risky changes and the last review before push']) {
    assert.ok(lead.includes(needle), `_lead.md must mention ${needle}`);
  }
});

test('review agents report every blocking and should-fix finding, with no cap', () => {
  for (const agent of ['reviewer', 'security-auditor']) {
    const text = read(`home/agents/${agent}.md`);
    assert.doesNotMatch(text, /\b(at most|max) 12\b/i, `${agent}.md must not cap findings at 12`);
    assert.match(text, /no cap/i, `${agent}.md must say findings have no cap`);
  }
});
