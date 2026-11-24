// Tests for home/agents/*.md: exactly the eleven agents of the lex/dev/tess setup, each with frontmatter whose name matches its
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
  lex: { model: OPUS, effort: 'high', skills: ['tradeoff-analysis', 'tech-research', 'repo-restructure'] },
  'lex-scout': { model: HAIKU, effort: 'high', skills: [] },
  'lex-web': { model: SONNET, effort: 'high', skills: ['tech-research'] },
  dev: { model: OPUS, effort: 'high', skills: ['clean-code', 'safe-refactor', 'datetime-handling', 'git-linear-history'] },
  'dev-ui': {
    model: OPUS, effort: 'high',
    skills: ['responsive-ui', 'accessibility-build', 'forms-validation', 'async-ui-states', 'ui-quality-pass', 'frontend-performance', 'frontend-security'],
  },
  'dev-pixel': { model: OPUS, effort: 'high', skills: ['figma-pixel-perfect', 'responsive-ui', 'accessibility-build', 'ui-quality-pass', 'ui-coverage'] },
  'pixel-qa': { model: SONNET, effort: 'high', skills: ['figma-pixel-perfect'] },
  'dev-debug': { model: OPUS, effort: 'xhigh', skills: ['root-cause-debug'] },
  'dev-run': { model: HAIKU, effort: 'high', skills: [] },
  tess: { model: SONNET, effort: 'high', skills: [] },
  'tess-review': { model: OPUS, effort: 'high', skills: [] },
};
const NAMES = Object.keys(PLAN);
const HELPER_STARTERS = ['lex', 'dev', 'dev-ui', 'dev-pixel', 'dev-debug', 'tess'];
const BROWSER_AGENTS = ['dev-ui', 'dev-pixel', 'pixel-qa'];
const REMOVED_MACHINERY = /done-check|road\.mjs|status\.mjs|estimate|recall|ask\.mjs|ASK_QUEUE|land-lane|watch\.mjs|lead-rules|lead\.md/;

test('home/agents holds exactly the eleven agents, each named like its file, with a description', () => {
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
    assert.match(frontmatter(name), /args: \["@playwright\/mcp@latest"\]/, name);
    assert.match(frontmatter(name), /args: \["chrome-devtools-mcp@1\.11\.0"\]/, name);
    assert.equal(field(name, 'tools'), '', `${name}: inherits every tool, its own servers included`);
  }
});

test('tess runs in the background; no other agent does', () => {
  for (const name of NAMES) assert.equal(field(name, 'background') === 'true', name === 'tess', name);
});

// omitClaudeMd and autoCompactWindow are documented subagent frontmatter fields (code.claude.com/docs/en/sub-agents.md);
// the window is a plain integer, since frontmatter reads `200k` as 200.
test('only lex-scout, lex-web and dev-run skip CLAUDE.md, and each carries the global rules it needs', () => {
  const skipping = ['lex-scout', 'lex-web', 'dev-run'];
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
  for (const name of ['lex-scout', 'lex-web', 'dev-run', 'tess', 'tess-review', 'pixel-qa']) {
    const tools = listed(name, 'tools');
    const denied = listed(name, 'disallowedTools');
    const writes = ['Write', 'Edit'].some((tool) => (tools.length === 0 || tools.includes(tool)) && !denied.includes(tool));
    assert.equal(writes, false, name);
  }
});

test('the writers work in their own worktree and commit without a merge commit', () => {
  for (const name of ['dev', 'dev-ui', 'dev-pixel', 'dev-debug']) {
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

test('no agent names the removed job machinery', () => {
  for (const name of NAMES) assert.doesNotMatch(agent(name), REMOVED_MACHINERY, name);
});
