// Tests for the runner split (owner, 2026-11-25): home/agents/tess-run.md is a copy of home/agents/dev-run.md that serves tess and its
// helpers, and dev, its helpers and max keep dev-run. The two files differ only in the frontmatter name and description, the heading and
// the ui-proof line (ui-proof records only dev-run and pixel-qa); tess, tess-write and tess-edge name tess-run and never dev-run; the dev
// side never names tess-run; the route names tess as tess-run's starter and the role list counts it read-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mainRouteReason } from '../home/hooks/lib/agent-route.mjs';
import { READ_ONLY_ROLES, WRITER_ROLES, isWriterRole } from '../home/hooks/lib/agent-roles.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const agentLines = (name) => readFileSync(fileURLToPath(new URL(`../home/agents/${name}.md`, import.meta.url)), 'utf8').replace(/\r\n/g, '\n').split('\n');
const agentText = (name) => agentLines(name).join('\n');

// The lines the two runner files may differ in. The ui-proof bullet starts at the line that names the recorder and runs on over its
// indented continuation lines.
const FRONTMATTER_KEYS_THAT_DIFFER = ['name', 'description'];
const HEADING = /^# /;
const UI_PROOF_START = /ui-proof\.mjs record/;
const CONTINUATION = /^ {2,}\S/;

/**
 * Splits a runner file into the lines that may differ and the rest.
 * @param {string[]} lines the file's lines
 * @returns {{shared: string[], allowed: {frontmatter: string[], heading: string[], uiProof: string[]}}}
 */
function splitRunner(lines) {
  const closing = lines.indexOf('---', 1); // the frontmatter's end
  const shared = [];
  const allowed = { frontmatter: [], heading: [], uiProof: [] };
  let inUiProof = false;
  lines.forEach((line, index) => {
    const inFrontmatter = index < closing;
    if (inFrontmatter && FRONTMATTER_KEYS_THAT_DIFFER.some((key) => line.startsWith(`${key}:`))) allowed.frontmatter.push(line);
    else if (!inFrontmatter && allowed.heading.length === 0 && HEADING.test(line)) allowed.heading.push(line);
    else if (UI_PROOF_START.test(line)) { inUiProof = true; allowed.uiProof.push(line); }
    else if (inUiProof && CONTINUATION.test(line)) allowed.uiProof.push(line);
    else { inUiProof = false; shared.push(line); }
  });
  return { shared, allowed };
}

test('dev-run.md and tess-run.md are equal line for line except the name, the description, the heading and the ui-proof line', () => {
  const dev = splitRunner(agentLines('dev-run'));
  const tess = splitRunner(agentLines('tess-run'));
  assert.deepEqual(tess.shared, dev.shared);
  // the filter must not swallow shared text: it takes out exactly name + description, one heading, and a ui-proof bullet of a few lines
  for (const { allowed } of [dev, tess]) {
    assert.equal(allowed.frontmatter.length, 2, 'name and description');
    assert.equal(allowed.heading.length, 1, 'the heading');
    assert.ok(allowed.uiProof.length >= 1 && allowed.uiProof.length <= 3, `the ui-proof bullet is ${allowed.uiProof.length} lines`);
  }
  assert.ok(dev.shared.length > 30, 'the runner text was read');
});

test('each runner names itself in its frontmatter name and heading, and both record a render as dev-run', () => {
  for (const name of ['dev-run', 'tess-run']) {
    const { allowed } = splitRunner(agentLines(name));
    assert.ok(allowed.frontmatter.includes(`name: ${name}`), `${name}: frontmatter name`);
    assert.ok(allowed.heading[0].startsWith(`# ${name}:`), `${name}: heading`);
    assert.ok(allowed.uiProof.join(' ').includes('ui-proof.mjs record --as dev-run --'), `${name}: ui-proof records only dev-run and pixel-qa`);
  }
});

test('tess, tess-write and tess-edge name tess-run and never dev-run, except the ui-proof --as dev-run record form', () => {
  for (const name of ['tess', 'tess-write', 'tess-edge']) {
    const text = agentText(name);
    assert.match(text, /tess-run/, `${name}: names its runner`);
    assert.doesNotMatch(text.replaceAll('--as dev-run', ''), /dev-run/, name);
  }
});

test('dev, its helpers and max never name tess-run', () => {
  for (const name of ['dev', 'dev-part', 'dev-ui', 'dev-pixel', 'dev-debug', 'pixel-qa', 'max']) assert.doesNotMatch(agentText(name), /tess-run/, name);
});

test('the boss may not start tess-run: it is tess\'s helper, and tess itself may start it', () => {
  const fromBoss = mainRouteReason({ tool_input: { subagent_type: 'tess-run' } });
  assert.equal(
    fromBoss,
    'agent route: the boss starts lex, dev, tess or max; tess-run is tess\'s helper: start tess with the brief, and it starts tess-run',
  );
  assert.equal(mainRouteReason({ agent_id: 'agent-tess-1', agent_type: 'tess', tool_input: { subagent_type: 'tess-run' } }), '');
});

test('tess-run is a read-only role by name, never a writer, even when its agent file claims write tools', () => {
  assert.ok(READ_ONLY_ROLES.includes('tess-run'));
  assert.ok(!WRITER_ROLES.includes('tess-run'));
  // a file that contradicts the name: without the name rule, isWriterRole would read the Write tool and say yes
  const home = makeTempDir('runner-split-home-');
  const agents = join(home, '.claude', 'agents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, 'tess-run.md'), '---\nname: tess-run\ndescription: test agent\ntools: Read, Write, Edit\n---\n');
  const env = { HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: makeTempDir('runner-split-project-') };
  assert.equal(isWriterRole('tess-run', env), false);
});
