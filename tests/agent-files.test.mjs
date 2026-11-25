// Tests for home/agents/*.md: exactly the seventeen agents of the lex/dev/tess setup, each with frontmatter whose name matches its
// file, the model and effort pins the guard's floor reads (lib/agent-pins.mjs), the preloaded skills of the plan, the Agent tool
// for the agents that start helpers, the browser servers only where the plan puts them, tess in the background, and no text
// about the removed job machinery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readPin } from '../home/hooks/lib/agent-pins.mjs';

const AGENTS_DIR = fileURLToPath(new URL('../home/agents/', import.meta.url));
const HOME_DIR = fileURLToPath(new URL('../home/', import.meta.url));
const agent = (name) => readFileSync(`${AGENTS_DIR}${name}.md`, 'utf8');
const frontmatter = (name) => agent(name).split('---')[1];
const field = (name, key) => new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(frontmatter(name))?.[1] ?? '';
const listed = (name, key) => field(name, key).split(',').map((item) => item.trim()).filter(Boolean);
/** The `- item` lines under a frontmatter key (a YAML list). */
function listItems(name, key) {
  const lines = frontmatter(name).split('\n');
  const start = lines.findIndex((line) => line === `${key}:`);
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => !line.startsWith(' '));
  return rest.slice(0, end === -1 ? rest.length : end).filter((line) => /^ {2}- /.test(line)).map((line) => line.slice(4).trim());
}

// The plan's table (lex-dev-tess plan, "Agents"): model, effort and preloaded skills of each agent.
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-5-5';
const PLAN = {
  lex: { model: OPUS, effort: 'high', skills: ['tradeoff-analysis', 'tech-research'] },
  'lex-scout': { model: HAIKU, effort: 'high', skills: [] },
  'lex-web': { model: SONNET, effort: 'high', skills: ['tech-research'] },
  dev: { model: OPUS, effort: 'high', skills: ['clean-code'] },
  'dev-ui': {
    model: OPUS, effort: 'high',
    skills: ['responsive-ui', 'accessibility-build', 'forms-validation', 'async-ui-states', 'ui-quality-pass', 'frontend-performance', 'frontend-security'],
  },
  'dev-pixel': { model: OPUS, effort: 'high', skills: ['figma-pixel-perfect', 'responsive-ui', 'accessibility-build', 'ui-quality-pass', 'ui-coverage'] },
  'pixel-qa': { model: SONNET, effort: 'high', skills: ['figma-pixel-perfect'] },
  'dev-debug': { model: OPUS, effort: 'xhigh', skills: ['root-cause-debug'] },
  'dev-run': { model: HAIKU, effort: 'high', skills: [] },
  // team-split plan: tess manages its helpers on Opus, and its test writer runs on Sonnet
  tess: { model: OPUS, effort: 'high', skills: ['qa-plan'] },
  'tess-review': { model: OPUS, effort: 'high', skills: ['review-checklist'] },
  'tess-write': { model: SONNET, effort: 'high', skills: ['test-writing'] },
  // team-split plan, 5.1 and 5.6: dev's part builder (dev may raise its model or effort per call) and two of tess's helpers
  'dev-part': { model: SONNET, effort: 'high', skills: ['clean-code'] },
  'tess-simple': { model: SONNET, effort: 'high', skills: ['clean-code'] },
  'tess-edge': { model: SONNET, effort: 'high', skills: [] },
  // owner decisions: dev-docs writes a job's docs on Sonnet, high; max ships on Opus, high
// final-pass plan, lane A (T1-T3): an agent preloads only the skills every run of it needs; the rest load on demand
  'dev-docs': { model: SONNET, effort: 'high', skills: ['docs-writing'] },
  max: { model: OPUS, effort: 'high', skills: ['ship-readiness'] },
};
const NAMES = Object.keys(PLAN);
const HELPER_STARTERS = ['lex', 'dev', 'dev-part', 'dev-ui', 'dev-pixel', 'dev-debug', 'tess', 'max'];
const BROWSER_AGENTS = ['dev-ui', 'dev-pixel', 'pixel-qa'];
const REMOVED_MACHINERY = /done-check|road\.mjs|status\.mjs|estimate|recall|ask\.mjs|ASK_QUEUE|land-lane|watch\.mjs|lead-rules|lead\.md/;

test('home/agents holds exactly the seventeen agents, each named like its file, with a description', () => {
  assert.deepEqual(readdirSync(AGENTS_DIR).sort(), NAMES.map((name) => `${name}.md`).sort());
  for (const name of NAMES) {
    assert.ok(agent(name).startsWith('---\n'), `${name}: frontmatter opens the file`);
    assert.equal(field(name, 'name'), name);
    assert.ok(field(name, 'description').length > 40, `${name}: a description the boss can route by`);
    assert.doesNotMatch(frontmatter(name), /^maxTurns:/m, `${name}: no turn cap`);
  }
});

test('each agent pins the model and effort of the plan, and the guard floor reads exactly that pin', () => {
  for (const [name, { model, effort }] of Object.entries(PLAN)) {
    assert.equal(field(name, 'model'), model, name);
    assert.equal(field(name, 'effort'), effort, name);
    assert.deepEqual(readPin(name, '/', { CLAUDE_CONFIG_DIR: HOME_DIR }), { model, effort }, `${name}: pin floor`);
  }
});

test('each agent preloads exactly the skills of the plan, and every one exists in home/skills', () => {
  for (const [name, { skills }] of Object.entries(PLAN)) {
    assert.deepEqual(listItems(name, 'skills'), skills, name);
    for (const skill of skills) assert.ok(readFileSync(`${HOME_DIR}skills/${skill}/SKILL.md`, 'utf8'), `${name}: ${skill} exists`);
  }
});

test('the agents that start helpers have the Agent tool; the others cannot start agents', () => {
  for (const name of NAMES) {
    const tools = listed(name, 'tools');
    const denied = listed(name, 'disallowedTools');
    const hasAgent = (tools.length === 0 || tools.includes('Agent')) && !denied.includes('Agent');
    assert.equal(hasAgent, HELPER_STARTERS.includes(name), name);
  }
});

test('playwright and chrome-devtools are defined only on dev-ui, dev-pixel and pixel-qa, with no tools allowlist to hide them', () => {
  for (const name of NAMES) {
    const servers = listItems(name, 'mcpServers');
    if (!BROWSER_AGENTS.includes(name)) {
      assert.deepEqual(servers, [], name);
      continue;
    }
    assert.deepEqual(servers, ['playwright:', 'chrome-devtools:'], name);
    assert.match(frontmatter(name), /args: \["@playwright\/mcp@0\.0\.86"\]/, name);
    assert.match(frontmatter(name), /args: \["chrome-devtools-mcp@1\.14\.0"\]/, name);
    assert.equal(field(name, 'tools'), '', `${name}: inherits every tool, its own servers included`);
  }
});

// The plan keeps the browser tool lists out of every other session and agent: the plugins that would load them globally stay off.
test('the playwright and chrome-devtools plugins are off in settings/base.json and plugins/plugins.json', () => {
  const browserPlugins = ['playwright@anthropic-plugin-directory', 'chrome-devtools-mcp@claude-plugins-official'];
  const settings = JSON.parse(readFileSync(new URL('../settings/base.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(readFileSync(new URL('../plugins/plugins.json', import.meta.url), 'utf8'));
  for (const id of browserPlugins) {
    assert.equal(settings.enabledPlugins[id], false, id);
    assert.ok(manifest.disabled.includes(id) && !manifest.enabled.includes(id), id);
  }
});

test('tess runs in the background; no other agent does', () => {
  for (const name of NAMES) assert.equal(field(name, 'background') === 'true', name === 'tess', name);
});

// omitClaudeMd and autoCompactWindow are documented subagent frontmatter fields (code.claude.com/docs/en/sub-agents.md);
// the window is a plain integer, since frontmatter reads `200k` as 200.
test('only lex-scout, lex-web, dev-run, dev-part, dev-docs, tess-simple and tess-edge skip CLAUDE.md, and each carries the global rules it needs', () => {
  const skipping = ['lex-scout', 'lex-web', 'dev-run', 'dev-part', 'dev-docs', 'tess-simple', 'tess-edge'];
  for (const name of NAMES) assert.equal(field(name, 'omitClaudeMd') === 'true', skipping.includes(name), name);
  for (const name of skipping) {
    const text = agent(name);
    assert.match(text, /Reply in the language the caller wrote in\./, name);
    assert.match(text, /Never print a secret/, name);
  }
  for (const name of ['lex-scout', 'lex-web']) {
    assert.match(agent(name), /Read-only: never create, edit or delete a file, and change nothing in git\./, name);
  }
  assert.match(agent('dev-run'), /Never push, publish or delete/);
});

test('dev-run, tess and lex-web compact at 200000 tokens; no other agent sets a window', () => {
  const lowered = ['dev-run', 'tess', 'lex-web'];
  for (const name of NAMES) assert.equal(field(name, 'autoCompactWindow'), lowered.includes(name) ? '200000' : '', name);
});

test('read-only agents cannot write files', () => {
  for (const name of ['lex-scout', 'lex-web', 'dev-run', 'tess', 'tess-review', 'tess-simple', 'tess-edge', 'pixel-qa']) {
    const tools = listed(name, 'tools');
    const denied = listed(name, 'disallowedTools');
    const writes = ['Write', 'Edit'].some((tool) => (tools.length === 0 || tools.includes(tool)) && !denied.includes(tool));
    assert.equal(writes, false, name);
  }
});

test('the writers work in their own worktree and commit without a merge commit', () => {
  for (const name of ['dev', 'dev-part', 'dev-docs', 'dev-ui', 'dev-pixel', 'dev-debug', 'tess-write', 'max']) {
    assert.match(agent(name), /own worktree/, name);
    assert.match(agent(name), /never `--no-verify`/i, name);
    assert.match(agent(name), /never return with uncommitted work/i, name);
  }
});

test('an agent that may need the owner returns a questions block; lex asks at job start', () => {
  for (const name of ['lex', 'dev', 'dev-ui', 'dev-pixel', 'dev-debug']) assert.match(agent(name), /questions:/, name);
  for (const name of ['lex', 'dev', 'dev-ui', 'dev-pixel']) assert.match(agent(name), /recommended/, name);
  assert.match(agent('lex'), /At job start/);
});

test('dev carries every core rule C1-C37', () => {
  const text = agent('dev');
  for (let id = 1; id <= 37; id += 1) assert.match(text, new RegExp(`\\bC${id}\\b`), `C${id}`);
});

test('dev-ui and dev-pixel carry the UI rules; dev-pixel loops with ui-check and starts pixel-qa as its final gate', () => {
  for (const name of ['dev-ui', 'dev-pixel']) for (const id of ['U1', 'U2', 'U3', 'U13', 'U14']) assert.match(agent(name), new RegExp(`\\b${id}\\b`), `${name} ${id}`);
  assert.match(agent('dev-pixel'), /ui-check\/cli\.mjs run --matrix/);
  assert.match(agent('dev-pixel'), /No round limit/);
  assert.match(agent('dev-pixel'), /start `pixel-qa`/);
  assert.match(agent('pixel-qa'), /ui-proof\.mjs review-page/);
});

// Owner rule: only the boss starts lex, dev, tess and max; an agent asks for one with a `needs:` line (by SendMessage to main while it runs
// in the background, and in its report). "starts `lex`" is allowed only as "the boss starts"; `dev-run` and the like are helpers.
const STARTS_MAIN_AGENT = /(?<!boss )\b(?:start|starts|launch|launches|spawn|spawns)\s+`?(?:lex|dev|tess|max)`?(?![\w-])/i;
const MAIN_AGENTS = ['lex', 'dev', 'tess', 'max'];

test('no agent file tells an agent to start lex, dev, tess or max; each asks the boss with a needs: line', () => {
  for (const name of NAMES) assert.doesNotMatch(agent(name), STARTS_MAIN_AGENT, name);
  for (const name of [...MAIN_AGENTS, 'dev-ui', 'dev-pixel', 'dev-debug']) assert.match(agent(name), /Only the boss starts `/, name);
  for (const name of MAIN_AGENTS) {
    assert.match(agent(name), /`needs: <agent> to <task>, blocks:\s+<what>`/, `${name}: the mid-run ask`);
    assert.match(agent(name).replace(/\s+/g, ' '), /`needs:` \(each `<agent> to <task>` you want the boss to start, or `needs: none`\)/, `${name}: the report line`);
    assert.ok(listed(name, 'tools').includes('SendMessage'), `${name}: can message main`);
  }
});

test('no agent names the removed job machinery', () => {
  for (const name of NAMES) assert.doesNotMatch(agent(name), REMOVED_MACHINERY, name);
});

// Owner decisions on max (ADR 0003): it prepares everything up to the outward step and stops; it acts outward only on an
// `owner-command:` brief line, which only the boss writes from the owner's own chat words.
test('max acts outward only on an owner-command: line the boss writes from the owner\'s words; it prepares and stops', () => {
  const text = agent('max').replace(/\s+/g, ' ');
  assert.match(field('max', 'description'), /Prepares everything, then stops\.$/);
  assert.ok(text.includes('Only with an `owner-command:` line in the brief. Run exactly that action from the landed sha the boss names, nothing more;'), 'the owner-command section');
  assert.ok(text.includes('Push, tag, publish, deploy, merge a PR, write to production or run a migration on real data without an `owner-command:` for that action.'), 'the outward never-list');
  assert.ok(text.includes('only the boss writes `owner-command:`, from the owner\'s own chat words.'), 'who writes the line');
});

// docs-writing (X6-X8) binds the text a person reads: clean-code and dev-ui point to it rather than repeat it.
test('clean-code and dev-ui point the text a person reads to docs-writing, which exists', () => {
  assert.ok(readFileSync(`${HOME_DIR}skills/docs-writing/SKILL.md`, 'utf8'), 'docs-writing exists');
  const cleanCode = readFileSync(`${HOME_DIR}skills/clean-code/SKILL.md`, 'utf8').replace(/\s+/g, ' ');
  assert.ok(cleanCode.includes('Text a person reads follows `docs-writing` (X6-X8).'), 'clean-code');
  assert.ok(agent('dev-ui').replace(/\s+/g, ' ').includes('U12 Plain sentence-case copy, no placeholder text; error and empty-state text by X6 (`docs-writing`).'), 'dev-ui');
});

// Final-pass plan, lane A (acceptance A-2 to A-4 and A-8): the preload cuts, the pinned browser servers, the removed finding caps, the
// word caps, the `skills:` brief field, the e2e qa kind and max's new never-line. Each test fails on the text before the lane.
const flat = (text) => text.replace(/\s+/g, ' ');
const ON_DEMAND_SKILLS = ['safe-refactor', 'datetime-handling', 'git-linear-history', 'repo-restructure'];
const MAX_DESCRIPTION_WORDS = 40; // the plan cuts it to "about 30 words"; it was 57

test('no agent preloads safe-refactor, datetime-handling, git-linear-history or repo-restructure, and max does not preload clean-code', () => {
  for (const name of NAMES) {
    const preloaded = listItems(name, 'skills');
    for (const skill of ON_DEMAND_SKILLS) assert.ok(!preloaded.includes(skill), `${name}: ${skill} loads on demand`);
  }
  assert.ok(!listItems('max', 'skills').includes('clean-code'), 'max writes release files, not code');
});

test('no agent file names the unpinned playwright server or the old chrome-devtools 1.11', () => {
  for (const name of NAMES) assert.doesNotMatch(agent(name), /mcp@latest|chrome-devtools-mcp@1\.11/, name);
});

test('tess-review and tess-simple carry no finding or word cap; tess-review keeps its must-fix rule and confidence', () => {
  for (const name of ['tess-review', 'tess-simple']) assert.doesNotMatch(agent(name), /At most 8|at most 200 words/, name);
  const review = flat(agent('tess-review'));
  assert.ok(review.includes('Every finding you could check, worst first.'), 'tess-review: no cap');
  assert.ok(review.includes('`severity` (`must-fix` only with a repro and `breaks` not `none`; else `follow-up`)'), 'tess-review: the must-fix rule');
  assert.ok(review.includes('`confidence` (high or medium; a guess you could not check is not reported)'), 'tess-review: confidence');
  assert.ok(flat(agent('tess-simple')).includes('Every finding, each with its rule id, the simpler form and the number of callers you found.'), 'tess-simple: no cap');
});

test('dev briefs a helper with a skills: field and dev-part loads the brief\'s skills before its first edit', () => {
  assert.ok(flat(agent('dev')).includes('`skills:` (the skills the part needs, which it loads before its first edit,'), 'dev: the helper brief list');
  assert.ok(flat(agent('dev-part')).includes('Before the first edit, load each skill the brief\'s `skills:` line names (Skill tool).'), 'dev-part: the Start line');
});

test('e2e is a qa kind in tess, lex and qa-plan, and tess runs it from the main checkout at the landed sha with the scenarios\' lines copied unchanged', () => {
  const tess = flat(agent('tess'));
  assert.ok(tess.includes('(any of `checks full review tests edge deps ui repro e2e`;'), 'tess: the qa kinds name e2e');
  assert.ok(tess.includes('## e2e `qa: e2e` runs the real end-to-end scenarios: only when the owner asks or for a final pass, never per lane.'), 'tess: the e2e section');
  assert.ok(tess.includes('`timeout` 7200000 runs `node tests/e2e/run.mjs --all --out <detail dir>` in the main checkout at the landed sha.'), 'tess: the command');
  assert.ok(tess.includes('Copy each scenario\'s `check | expected | observed | PASS/FAIL` line unchanged into the detail file.'), 'tess: the lines are copied');
  assert.ok(tess.includes('`not run (limit, resets <time>)`, never retried before then. `landing:` does not apply.'), 'tess: a usage-limit stop');
  assert.ok(flat(agent('lex')).includes('`e2e` only for a final pass the owner asks for'), 'lex: the qa kinds');
  assert.ok(flat(readFileSync(`${HOME_DIR}skills/qa-plan/SKILL.md`, 'utf8')).includes('| e2e (`qa: e2e`) | only when the owner asks, or a final pass; never per lane:'), 'qa-plan: the e2e row');
});

test('lex-web and lex-scout cap their reply at the brief\'s word cap, else 250 and 200 words (a map 500), and drop facts, never sources', () => {
  assert.ok(flat(agent('lex-web')).includes('Return at most the brief\'s word cap, else 250 words:'), 'lex-web');
  assert.ok(flat(agent('lex-web')).includes('Over the cap, drop the least important facts, never a fact\'s source.'), 'lex-web: the drop rule');
  assert.ok(flat(agent('lex-scout')).includes('Return at most the brief\'s word cap, else 200 words (a map 500):'), 'lex-scout');
  assert.ok(flat(agent('lex-scout')).includes('Over the cap, drop the least important findings, never a finding\'s `path:line`.'), 'lex-scout: the drop rule');
});

test('max\'s description stays short with its triggers, and its Never list names starting claude or a long-run', () => {
  const description = field('max', 'description');
  assert.ok(description.split(/\s+/).length <= MAX_DESCRIPTION_WORDS, `${description.split(/\s+/).length} words`);
  for (const trigger of ['release', 'deploy', 'publish', 'showcase', 'readiness review', 'incident', 'the owner asks', '`ship:` target']) {
    assert.ok(description.includes(trigger), `description keeps the trigger ${trigger}`);
  }
  assert.ok(flat(agent('max')).includes('Start a Claude session (`claude`) or a long-run: the guard denies it; the command goes into the commands file.'), 'the Never line');
});
