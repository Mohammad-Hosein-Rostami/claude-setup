// Consistency checks of the always-loaded text: home/CLAUDE.md, home/lead.md and home/lead-rules.md (the lead rules that were
// home/modes/_lead.md until the setup modes were removed; this test file keeps its old name) (node:test, no dependencies).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative) => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
test('lead-rules.md carries the lead-discipline rules and stays small', () => {
  const lead = read('home/lead-rules.md');
  for (const needle of ['Persian', 'No turn without a decision', 'runner', '2nd compaction', 'usage-limit', 'STATUS.md', '3k chars', 'tell the owner to restart', 'No answer in 60 s','≤ 300 words', '`implementer`, not general-purpose', 'estimate.mjs']) {
    assert.ok(lead.includes(needle), `lead-rules.md must mention ${needle}`);
  }
  assert.ok(lead.split('\n').length <= 100, 'lead-rules.md is injected into every session; keep it <= 100 lines');
});

test('home/CLAUDE.md names Persian replies, the STATUS.md re-read and the Grep tool or rg', () => {
  const text = read('home/CLAUDE.md');
  assert.match(text, /Persian included/);
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
const GLOBAL_ESTIMATE_RULE = '- Work with a `STATUS.md`: every owner request and every owner correction becomes `## Work items` rows before work on it starts. Row edits go through `node ~/.claude/tools/status/status.mjs add|start|done|deliver|rule|decision` only, never a typed time; its help and `add` output give the row rules. Every estimate you give is the `Finish:` block of `node ~/.claude/tools/estimate/estimate.mjs STATUS.md` pasted as-is, never a number or clock time of your own; if it refuses, give its reason, and do its What to do and any `Check:` line first.';

test('the estimate rules are verbatim in lead-rules.md and home/CLAUDE.md, and the old bullet is gone', () => {
  assert.ok(read('home/lead-rules.md').split('\n').includes(LEAD_ESTIMATE_RULE), 'lead-rules.md estimate line');
  assert.ok(LEAD_ESTIMATE_RULE.length <= 200, 'lead-rules.md is injected into every session: the estimate line stays within 200 characters');
  const global = read('home/CLAUDE.md');
  assert.ok(global.split('\n').includes(GLOBAL_ESTIMATE_RULE), 'home/CLAUDE.md estimate rule');
  assert.doesNotMatch(global, /end that reply with the new finish estimate/);
  assert.match(read('docs/daily-use.md'), /pastes the `Finish:` block of `node ~\/\.claude\/tools\/estimate\/estimate\.mjs STATUS\.md` as every estimate/);
});

// Every accuracy rule lives in home/CLAUDE.md, home/lead.md or home/lead-rules.md, which every session loads.
const GATES = ['runner', 'reviewer', 'security-auditor', 'verify-done', 'ui-quality-pass', 'visual-qa', 'ui-coverage'];
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
  assert.match(read('home/lead.md'), /re-read the cited lines/);
  assert.match(claude, /second independent source/);
  const lead = read('home/lead-rules.md');
  for (const needle of ['`architect`, not Plan', '`opus` judges', 'Never downgrade a pick to save tokens', 'security-critical decision', 'with all it needs', 'with `review` on, `reviewer` and `security-auditor` `model: "opus", effort: "max"` for risky changes (auth, data, money, concurrency, security) and the last review before push']) {
    assert.ok(lead.includes(needle), `lead-rules.md must mention ${needle}`);
  }
});

test('review agents report every blocking and should-fix finding, with no cap', () => {
  for (const agent of ['reviewer', 'security-auditor']) {
    const text = read(`home/agents/${agent}.md`);
    assert.doesNotMatch(text, /\b(at most|max) 12\b/i, `${agent}.md must not cap findings at 12`);
    assert.match(text, /no cap/i, `${agent}.md must say findings have no cap`);
  }
});

// Round 6 (owner, 2026-11-17): the form of a job (inline, one agent, a workflow) is decided by the job, stated once in home/CLAUDE.md.
test('home/lead.md states the inline / agent / workflow rule once; lead-rules.md and the workflows skill point to it', () => {
  const claude = read('home/lead.md');
  const heading = '- Inline, agent or workflow: decide by the job';
  assert.equal(claude.split(heading).length, 2, 'stated exactly once');
  for (const tier of ['Inline, no agent:', 'One background agent (Agent tool):', 'Workflow (the `workflows` skill:', 'Quality gates do not change with the form']) {
    assert.ok(claude.includes(tier), `the rule names ${tier}`);
  }
  assert.match(read('home/lead-rules.md'), /"Inline, agent or workflow"/, 'lead-rules.md points to the rule');
  assert.match(read('home/skills/workflows/SKILL.md'), /"Inline, agent or workflow"/, 'the workflows skill points to the rule');
});

test('no setup document tells sessions to run every agent or job as a workflow', () => {
  const files = ['home/CLAUDE.md', 'home/lead-rules.md', 'docs/daily-use.md', 'docs/catalog.md', 'home/hooks/README.md', 'home/workflows/README.md',
    'home/skills/workflows/SKILL.md'];
  const everythingIsAWorkflow = /Workflows always|everything that runs (is|must be) a workflow|every agent runs (inside a workflow|in one)|instead of single (sub)?agents|not as single agents|every job that runs agents (goes through|shows in)|(parallelism|sets), workflows and report brevity/i;
  for (const file of files) assert.doesNotMatch(read(file), everythingIsAWorkflow, `${file} still says workflows for everything`);
});

// Round 6 review: landing is the one job whose workflow holds a safety check (land.js: the branch is still at the reviewed tip), so a size rule must not send it to an agent.
// r9-routing-text: only landing and machine sync are always a workflow; bugfix and git cleanup are by the job.
const ALWAYS_WORKFLOW = { land: 'land', 'sync-machines': 'sync-machines' };
const BY_THE_JOB = { bugfix: 'bugfix', 'git-cleanup': 'git-cleanup' };
/** One workflow's section of the merged workflows skill (from its `## <name>` heading to the next). */
const section = (name) => read('home/skills/workflows/SKILL.md').split(/^## /m).find((part) => part.startsWith(`${name} `)) ?? '';

test('landing and machine sync always run their workflow, bugfix and git cleanup by the job, and no wf-land text sends a landing to an agent', () => {
  const rule = read('home/lead.md').split('\n').find((line) => line.includes('Always a workflow, whatever the size')) ?? '';
  for (const [workflow, skill] of Object.entries(ALWAYS_WORKFLOW)) {
    assert.ok(rule.includes(`(\`${workflow}\`)`), `the routing rule names the ${workflow} workflow`);
    assert.ok(read(`home/workflows/${workflow}.js`).length > 0 && section(skill).includes(`${workflow}.js`), `${skill} runs ${workflow}.js`);
  }
  assert.doesNotMatch(section('land'), /background agent instead|one background agent/i, 'wf-land must not offer an agent for a landing');
  for (const skill of ['land', 'sync-machines']) {
    assert.match(section(skill), /always runs this workflow/i, `${skill} says its job always runs this workflow`);
  }
  const byTheJob = read('home/lead.md').split('\n').find((line) => line.includes('By the job, like everything else')) ?? '';
  for (const [workflow, skill] of Object.entries(BY_THE_JOB)) {
    assert.ok(byTheJob.includes(`(\`${workflow}\``), `the by-the-job line names the ${workflow} workflow`);
    assert.ok(!rule.includes(`(\`${workflow}\`)`), `${workflow} is not in the always-a-workflow line`);
    assert.doesNotMatch(section(skill), /always runs this workflow/i, `${skill} no longer says always`);
  }
  for (const file of ['docs/daily-use.md']) {
    assert.match(read(file), /Landing and machine sync always run their\s+workflow/i, `${file} points at the always-a-workflow tier`);
    assert.doesNotMatch(read(file), /git cleanup and (a )?bugfix( job)? always/i, `${file} no longer sends every bugfix and cleanup to a workflow`);
  }
  assert.doesNotMatch(read('home/CLAUDE.md').split('\n').find((line) => line.includes('One background agent')) ?? '', /one debug hypothesis set\.$/, 'the agent line limits a hypothesis set to inside a running job');
  assert.match(read('home/lead-rules.md'), /via the `land` workflow/, 'lead-rules.md lands through the land workflow');
});
