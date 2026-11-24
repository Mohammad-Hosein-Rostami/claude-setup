// Consistency checks of the always-loaded text: home/CLAUDE.md (the lead rules home/lead.md and home/lead-rules.md were removed
// with the lex-dev-tess plan; this test file keeps its old name) (node:test, no dependencies).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative) => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');

// The owner's own language (Persian) is in personal/CLAUDE.md; the shared text keeps the user's-language rule and its compaction line.
// The STATUS.md re-read and the token-discipline lines left with the short global rules (lex-dev-tess plan).
test('home/CLAUDE.md names user-language replies, the compaction language and the outward-action confirm', () => {
  const text = read('home/CLAUDE.md');
  assert.match(text, /Reply in the language the user writes in \(never default to English\)/);
  assert.match(text, /When compacting, keep the goal, the owner's constraints and language/);
  assert.doesNotMatch(text, /Persian/i, 'one person\'s language is personal');
  assert.match(text, /Confirm every outward-facing action \(push, publish, deploy, PR merge, prod-host writes\)\./);
  // max ships: it prepares the outward step and runs it only on the owner's own words; while any max runs, an outward ask needs a
  // click (the guard's timed ask enforces it)
  assert.match(text, /`max` prepares them \(release notes, deploy and rollback plans, exact commands\) and stops; it runs one only on an\s+`owner-command:` line \(the owner's chat words\)\./);
  assert.match(text, /Permission prompts \(any tool, risky ones too\) go ahead as Allow after 2 minutes unless denied;\s+while any `max` runs, an outward one needs a click\./);
  assert.match(text, /No secrets in code, logs, commits or command lines/);
});

// Owner decisions on max (ship agent ADR 0003): the boss routes shipping to it, never from a long-run step, and starts it like the
// three main agents.
test('home/CLAUDE.md routes shipping to max, never from a long-run step, and only the boss starts lex, dev, tess and max', () => {
  const text = read('home/CLAUDE.md').replace(/\s+/g, ' ');
  assert.ok(text.includes('Shipping to real users (release, deploy, showcase, incident) -> `max` on the owner\'s call, or after a job\'s last land only if lex\'s plan names a `ship:` target or the owner asked for one; never from a long-run step.'), 'the max routing sentence');
  assert.ok(text.includes('- Only the boss starts `lex`, `dev`, `tess` and `max`, and it starts no helper (the guard denies both); research goes through `lex`.'), 'the boss-starts line');
});

// The plan capped home/CLAUDE.md at 7464 bytes (the landed 7014 plus 450 for the max lanes).
const CLAUDE_MD_MAX_BYTES = 7464;

test('home/CLAUDE.md stays at or under the plan\'s cap of 7464 bytes', () => {
  const bytes = Buffer.byteLength(read('home/CLAUDE.md'));
  assert.ok(bytes <= CLAUDE_MD_MAX_BYTES, `${bytes} bytes`);
});

test('home/CLAUDE.md keeps the usage-limit bullet (L22)', () => {
  assert.match(read('home/CLAUDE.md'), /At a usage limit, tell the owner the reset time\s+and never retry before it\./);
});

test('ui-coverage hand-over step gives ONE link to the visual overview', () => {
  assert.match(read('home/skills/ui-coverage/SKILL.md'), /Give the owner ONE link, to the visual overview \(a preview or side-by-side per state\), open it yourself first and check it shows what you describe; never hand over a bare index of routes or a mock's default listing\./);
});

// The lex-dev-tess plan removes estimates, the status rows and the job machinery: the shared text names none of them.
test('home/CLAUDE.md and docs/daily-use.md name no estimate, status row, done-check or road machinery', () => {
  for (const file of ['home/CLAUDE.md', 'docs/daily-use.md']) {
    assert.doesNotMatch(read(file), /estimate\.mjs|`Finish:`|status\.mjs|STATUS\.md|done-check|road\.mjs|land-lane|watch\.mjs|recall/, file);
  }
});

// The UI skills are preloaded by the dev-ui and dev-pixel agent files (lex-dev-tess plan); the global text keeps the pixel bar.
test('home/CLAUDE.md keeps the pixel-perfect bar and the dev-pixel compare loop as part of its job', () => {
  const claude = read('home/CLAUDE.md');
  assert.match(claude, /Pixel-perfect work: no sacrifice of\s+its checks, models or effort/);
  assert.match(claude, /The compare loop of `dev-pixel` is part of its job/);
});

test('accuracy rules live in the shared files', () => {
  const claude = read('home/CLAUDE.md');
  assert.match(claude, /second independent source/);
});

test('no setup document tells sessions to run every agent or job as a workflow', () => {
  const files = ['home/CLAUDE.md', 'docs/daily-use.md', 'docs/catalog.md', 'home/hooks/README.md'];
  const everythingIsAWorkflow = /Workflows always|everything that runs (is|must be) a workflow|every agent runs (inside a workflow|in one)|instead of single (sub)?agents|not as single agents|every job that runs agents (goes through|shows in)|(parallelism|sets), workflows and report brevity/i;
  for (const file of files) assert.doesNotMatch(read(file), everythingIsAWorkflow, `${file} still says workflows for everything`);
});

// The lead texts that sent landing to land-lane were removed (lex-dev-tess plan); daily use lands through the land script and
// still sends no job to a workflow.
test('docs/daily-use.md lands with the land script, sends no bugfix or cleanup to a workflow, and the agent line keeps a hypothesis set inside a job', () => {
  assert.match(read('docs/daily-use.md'), /Landing is one script call, not an agent: the `land` script/, 'docs/daily-use.md says landing is one script call');
  assert.doesNotMatch(read('docs/daily-use.md'), /git cleanup and (a )?bugfix( job)? always/i, 'docs/daily-use.md no longer sends every bugfix and cleanup to a workflow');
  assert.doesNotMatch(read('home/CLAUDE.md').split('\n').find((line) => line.includes('One background agent')) ?? '', /one debug hypothesis set\.$/, 'the agent line limits a hypothesis set to inside a running job');
});
