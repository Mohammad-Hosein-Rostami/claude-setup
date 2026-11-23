// Consistency checks of the always-loaded text: home/CLAUDE.md, home/lead.md and home/lead-rules.md (the lead rules that were
// home/modes/_lead.md until the setup modes were removed; this test file keeps its old name) (node:test, no dependencies).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative) => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
test('lead-rules.md carries the lead-discipline rules and stays small', () => {
  const lead = read('home/lead-rules.md');
  assert.doesNotMatch(lead, /Persian/i, 'the reply language of one person is in personal/CLAUDE.md');
  for (const needle of ["Reply in the user's language.", 'No turn without a decision', 'runner', '2nd compaction', 'usage-limit', 'STATUS.md', '3k chars', 'tell the owner to restart', 'No answer in 2 min','≤ 300 words', '`implementer`, not general-purpose', 'estimate.mjs']) {
    assert.ok(lead.includes(needle), `lead-rules.md must mention ${needle}`);
  }
  assert.ok(lead.split('\n').length <= 100, 'lead-rules.md is injected into every session; keep it <= 100 lines');
});

// Was "ultra-high playbook keeps ..." on home/modes/ultra-high.md; two of its rules moved to lead-rules.md with the modes removal.
test('lead-rules.md keeps the assembly and compact-before-waiting rules', () => {
  const lead = read('home/lead-rules.md');
  assert.match(lead, /Assembly is not judgment/);
  assert.match(lead, /`\/compact` first/);
});

// The owner's own language (Persian) is in personal/CLAUDE.md; the shared text keeps the user's-language rule and its compaction line.
test('home/CLAUDE.md names user-language replies, the STATUS.md re-read and the Grep tool or rg', () => {
  const text = read('home/CLAUDE.md');
  assert.match(text, /Reply in the language the user writes\s+in \(never default to English\)/);
  assert.match(text, /and the user's language: reply in it\)/);
  assert.doesNotMatch(text, /Persian/i, 'one person\'s language is personal');
  assert.match(text, /`STATUS\.md` path/);
  assert.match(text, /Grep tool or `rg`/);
  assert.match(text, /Git push[\s\S]*confirm dialog even in bypass mode[\s\S]*goes ahead after 2 min unless the owner clicks Deny[\s\S]*literal password or token/);
});

test('home/lead.md keeps the standing-rules and delegation-size bullets, home/CLAUDE.md the usage-limit bullet (L22)', () => {
  const text = read('home/lead.md');
  assert.match(text, /goes into STATUS\.md under `## Standing rules` the moment it is given, in the owner's words; every brief names that file; re-read it after a compaction or a resume\./);
  assert.match(text, /Size a delegated job to finish within about 120 tool calls; split a bigger one into stages with a commit between them\. An agent that returns without its report is continued once \("commit, then report"\), not restarted\./);
  assert.match(read('home/CLAUDE.md'), /At a usage limit: read the reset time from the message, tell the owner that time, and never retry before the reset[\s\S]*schedule one wake a few minutes after the reset only where that does not reach/);
});

test('ui-coverage hand-over step gives ONE link to the visual overview', () => {
  assert.match(read('home/skills/ui-coverage/SKILL.md'), /Give the owner ONE link, to the visual overview \(a preview or side-by-side per state\), open it yourself first and check it shows what you describe; never hand over a bare index of routes or a mock's default listing\./);
});

// Estimator rebuild stage 3: rows are listed first and edited by status.mjs only, a Stop hook records the hand-over, and every
// estimate is the Finish block pasted as-is.
const LEAD_ESTIMATE_RULE = '- Multi-day: `STATUS.md` `## Work items`: list the job\'s rows first; row edits by `status.mjs` only. Estimates: the `Finish:` block of `node ~/.claude/tools/estimate/estimate.mjs STATUS.md` only.';
// one-home-rules (R16 item 19): the rest of the STATUS bullet is lead-only and moved to lead-rules.md; home/CLAUDE.md keeps the
// row-edit line every agent may need.
const GLOBAL_STATUS_RULE = '- `STATUS.md` row edits go through `node ~/.claude/tools/status/status.mjs add|start|done|deliver|rule|decision` only, never a typed time (the tool writes it); the lead plans the rows.';
const LEAD_ESTIMATE_DETAIL = 'Paste the `Finish:` block as-is, never a number or time of your own; if it refuses, give its reason, do its What to do and `Check:` lines first.';

test('the estimate rules are verbatim in lead-rules.md, the row-edit rule in home/CLAUDE.md, and the old bullet is gone', () => {
  const leadRules = read('home/lead-rules.md');
  assert.ok(leadRules.split('\n').includes(LEAD_ESTIMATE_RULE), 'lead-rules.md estimate line');
  assert.ok(LEAD_ESTIMATE_RULE.length <= 200, 'lead-rules.md is injected into every session: the estimate line stays within 200 characters');
  assert.ok(leadRules.replace(/\n +/g, ' ').includes(LEAD_ESTIMATE_DETAIL), 'lead-rules.md: the Finish block is pasted as-is');
  assert.match(leadRules, /Every owner request and correction becomes rows before work on it starts/);
  const global = read('home/CLAUDE.md');
  assert.ok(global.split('\n').includes(GLOBAL_STATUS_RULE), 'home/CLAUDE.md row-edit rule');
  assert.doesNotMatch(global, /end that reply with the new finish estimate/);
  assert.match(read('docs/daily-use.md'), /pastes the `Finish:` block of `node ~\/\.claude\/tools\/estimate\/estimate\.mjs STATUS\.md` as every estimate/);
});

// Every accuracy rule lives in home/CLAUDE.md, home/lead.md or home/lead-rules.md, which every session loads.
const GATES = ['ui-quality-pass', 'visual-qa', 'ui-coverage'];
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
// The final reply names the categories left off with the exact label `not checked: <categories off>` (spec r9-checks-off): that is the
// owner's rule saying what was not run, not a lowered gate, so the label is taken out before a sentence is tested.
const NOT_CHECKED_LABEL = /`not checked: <categories off>`/g;
const lowersAGate = (sentence) => {
  const text = sentence.replace(NOT_CHECKED_LABEL, '');
  return LOWERS_A_GATE.test(text) || LOWERS_OTHERWISE.some((pattern) => pattern.test(text));
};
const SHARED_TEXT_FILES = ['home/lead-rules.md'];

test('no sentence of lead-rules.md lowers a gate that home/CLAUDE.md requires', () => {
  const lowering = [
    'Skip the reviewer on small diffs.', 'Do small work without verify-done.', 'Fewer checks in this mode.', 'No tests for quick fixes.',
    'Reviews: only for risky changes.', 'Research: one source is enough.', 'verify-done is optional in this mode.',
    'Leave out the reviewer for one-line fixes.', 'Stop after the first finding that explains the bug.',
    'Say `not checked: <categories off>` and skip the reviewer.', 'The reviewer findings are not checked.',
    'Say `not checked: <review, test>` and land.',
    'Reviewer findings marked optional are not fixed or listed.', 'Skip review on small diffs.', 'skip responsive',
  ];
  for (const sentence of lowering) assert.ok(lowersAGate(sentence), `detector must flag: ${sentence}`);
  const honest = [
    'Never downgrade a model or effort pick to save tokens; the quality gates still run.', 'No duplicate agents on the same question.',
    'Gates to risk: one reviewer pass per batch on changed lines; `security-auditor` only auth/secrets/data/money/hooks/untrusted input.',
    're-run browser/responsive checks only for failed, not-run or risky (auth, payments) items.',
    'Final reply: obey the line cap; say `not checked: <categories off>`.',
  ];
  for (const sentence of honest) assert.ok(!lowersAGate(sentence), `detector must not flag: ${sentence}`);
  for (const file of SHARED_TEXT_FILES) {
    for (const sentence of read(file).split(/(?<=[.;])\s+|\n+/)) assert.ok(!lowersAGate(sentence), `${file} lowers a gate: ${sentence}`);
  }
});

test('every remaining gate (the UI ones) is named in home/CLAUDE.md, which every session and agent loads', () => {
  const claude = read('home/CLAUDE.md');
  const section = (heading) => claude.split(/^## /m).find((part) => part.startsWith(heading)) ?? '';
  assert.match(section('Checks'), /`done-check` runs/, 'the Checks section says the done-check runs by itself');
  const uiRouting = section('Skill routing (UI)');
  for (const gate of ['visual-qa', 'ui-coverage']) assert.ok(uiRouting.includes(`\`${gate}\``), `Skill routing (UI) must name ${gate}`);
  for (const gate of GATES) assert.ok(claude.includes(`\`${gate}\``), `home/CLAUDE.md must name ${gate}`);
});

test('accuracy rules live in the shared files', () => {
  const claude = read('home/CLAUDE.md');
  assert.match(claude, /second independent source/);
  const lead = read('home/lead-rules.md');
  for (const needle of ['`architect`, not Plan', '`opus` judges', 'Never downgrade a pick to save tokens', 'security-critical decision', 'with all it needs']) {
    assert.ok(lead.includes(needle), `lead-rules.md must mention ${needle}`);
  }
});

// Owner, 2026-11-22: no Workflow tool, only subagents in batches of 1-5. The form of a job is stated once, in home/lead.md.
test('home/lead.md states the inline / agents rule once; lead-rules.md points to it', () => {
  const claude = read('home/lead.md');
  const heading = '- Inline or agents, by the job';
  assert.equal(claude.split(heading).length, 2, 'stated exactly once');
  for (const part of ['Inline:', 'A batch is 1-5 agents launched together', 'A fixed sequence is one script call', 'Two fix rounds per lane']) {
    assert.ok(claude.includes(part), `the rule names ${part}`);
  }
  assert.match(read('home/lead-rules.md'), /"Job form and order"/, 'lead-rules.md points to the rule');
});

test('no setup document tells sessions to run every agent or job as a workflow', () => {
  const files = ['home/CLAUDE.md', 'home/lead-rules.md', 'docs/daily-use.md', 'docs/catalog.md', 'home/hooks/README.md'];
  const everythingIsAWorkflow = /Workflows always|everything that runs (is|must be) a workflow|every agent runs (inside a workflow|in one)|instead of single (sub)?agents|not as single agents|every job that runs agents (goes through|shows in)|(parallelism|sets), workflows and report brevity/i;
  for (const file of files) assert.doesNotMatch(read(file), everythingIsAWorkflow, `${file} still says workflows for everything`);
});

// Landing is a fixed sequence: one script call, never an agent per command (lead.md "Job form and order"). The machine sync is
// an owner-only script, so its lines live in personal/CLAUDE.md, never in the shared lead text.
test('lead.md and lead-rules.md send landing to land-lane, leave machine sync to the personal rules and name no workflow', () => {
  const lead = read('home/lead.md');
  assert.match(lead, /`land-lane` \(the only landing route, one land at a time\)/);
  assert.doesNotMatch(lead, /sync-machines/, 'machine sync is personal');
  assert.match(read('home/lead-rules.md'), /via `land-lane`/, 'lead-rules.md lands through land-lane');
  assert.doesNotMatch(read('home/lead-rules.md'), /sync-machines/, 'machine sync is personal');
  assert.match(lead, /`road\.mjs join`/, 'the fixed sequences name road.mjs join');
  assert.match(lead, /The hook refuses a 6th/, 'the batch cap of 5 is stated with its hook');
  assert.match(lead, /goes to the architect with its open findings by class/, 'two fix rounds, then the architect re-plans');
  for (const file of ['home/lead.md', 'home/lead-rules.md', 'home/skills/road/SKILL.md']) {
    assert.doesNotMatch(read(file), /workflow|verifier|not capped/i, `${file} names no workflow`);
  }
  for (const file of ['docs/daily-use.md']) {
    assert.match(read(file), /Fixed sequences are one script call, not an agent: `land-lane`/, `${file} says landing is one script call`);
    assert.doesNotMatch(read(file), /git cleanup and (a )?bugfix( job)? always/i, `${file} no longer sends every bugfix and cleanup to a workflow`);
  }
  assert.doesNotMatch(read('home/CLAUDE.md').split('\n').find((line) => line.includes('One background agent')) ?? '', /one debug hypothesis set\.$/, 'the agent line limits a hypothesis set to inside a running job');
});
