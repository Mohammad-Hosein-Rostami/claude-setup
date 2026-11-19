// Size test for the one string home/hooks/mode.mjs prints at SessionStart: mode line, _lead.md, playbook, lead note, project-agents
// note and compaction notes.
// Why: Claude Code caps a hook's plain stdout at 10,000 characters, measured whole per hook (hooks reference, "capped at 10,000
// characters", https://code.claude.com/docs/en/hooks). Over the cap the lead gets a file path and a 2,000-character preview, so most of
// the lead rules and the playbook would be lost.
// How it measures: the real home/modes and home/agents are copied into a temp HOME; every mode runs one startup and then COMPACTIONS
// compactions with a model that forces the lead note; the longest stdout over the modes is checked for each stage.
// Assumption: the hook prints the STATUS file path whole and a path has no length limit, so the test fixes one of STATUS_PATH_CHARS
// (80) characters. A longer path uses up MIN_HEADROOM_CHARS first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/mode.mjs', import.meta.url));
const MODES_DIR = fileURLToPath(new URL('../home/modes', import.meta.url));
const PERSONAL_AGENTS_DIR = fileURLToPath(new URL('../home/agents', import.meta.url));
const MODES = ['normal', 'medium', 'high', 'extra-high', 'ultra-high'];
const MAX_HOOK_OUTPUT_CHARS = 10_000; // the documented cap for a hook's plain stdout
const MIN_HEADROOM_CHARS = 150; // room for a longer path or note without crossing the cap
const SIZE_LIMIT_CHARS = MAX_HOOK_OUTPUT_CHARS - MIN_HEADROOM_CHARS;
const STATUS_PATH_CHARS = 80;
const STATUS_FILE = '/STATUS.md';
const STATUS_PATH = `/${'p'.repeat(STATUS_PATH_CHARS - STATUS_FILE.length - 1)}${STATUS_FILE}`;
const MISMATCHED_MODEL = 'claude-haiku-5-5'; // no mode leads on this model, so the lead note is printed in every mode
const COMPACTIONS = 3; // the third compaction adds the handoff line
const TRANSCRIPT = 'transcript.jsonl';
const COPIED_AGENTS = 10;
const AGENT_NOTE_START = 'Project agent files in .claude/agents: ';

const agentFile = (name, extra) => `---\nname: ${name}\ndescription: x\n${extra}---\nBody\n`;
const longer = (a, b) => (b.length > a.length ? b : a);

/** A temp HOME with the real mode files and personal agents, and a transcript in which the session wrote STATUS_PATH. */
async function realHome() {
  const home = makeTempDir('start-size-');
  await cp(MODES_DIR, join(home, '.claude', 'modes'), { recursive: true });
  await cp(PERSONAL_AGENTS_DIR, join(home, '.claude', 'agents'), { recursive: true });
  const write = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: STATUS_PATH } }] } };
  await writeFile(join(home, TRANSCRIPT), `${JSON.stringify(write)}\n`);
  return home;
}

/** A temp project whose `.claude/agents` holds the given [file name, file text] pairs. */
async function projectWith(files) {
  const agents = join(makeTempDir('start-size-proj-'), '.claude', 'agents');
  await mkdir(agents, { recursive: true });
  for (const [name, text] of files) await writeFile(join(agents, name), text);
  return join(agents, '..', '..');
}

/** The stdout of one session in `mode`: the startup, the first compaction and the last of COMPACTIONS. */
function stagesOf(home, mode, projectDir) {
  const run = (source) => {
    const input = { hook_event_name: 'SessionStart', session_id: `size-${mode}`, source, model: MISMATCHED_MODEL, cwd: projectDir, transcript_path: join(home, TRANSCRIPT) };
    const out = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_MODE: mode }, encoding: 'utf8' }).stdout;
    assert.match(out, /Lead|lead/, `${mode} ${source}: lead rules present`);
    assert.equal(out.includes(home), false, `${mode} ${source}: the size must not depend on the temp HOME path`);
    return out;
  };
  // The playbook printed on a compaction is the one the startup saved, so the startup runs first.
  const startup = run('startup');
  const compacts = Array.from({ length: COMPACTIONS }, () => run('compact'));
  return { startup, firstCompact: compacts[0], lastCompact: compacts.at(-1) };
}

/**
 * Runs every mode's session and keeps the longest output of each stage.
 * @param {string} [projectDir] the session's project folder; none for a session without project agents
 * @returns {Promise<{ startup: string, firstCompact: string, lastCompact: string }>} the longest stdout over the modes, per stage
 */
async function longestOutputs(projectDir) {
  const home = await realHome();
  const perMode = MODES.map((mode) => stagesOf(home, mode, projectDir));
  return Object.fromEntries(Object.keys(perMode[0]).map((stage) => [stage, perMode.map((stages) => stages[stage]).reduce(longer)]));
}

/** Fails when a stage is empty or longer than the cap less the headroom; the measured lengths go to the test output. */
function assertFits(t, outputs) {
  const lengths = Object.entries(outputs).map(([stage, out]) => [stage, out.length]);
  t.diagnostic(lengths.map(([stage, length]) => `${stage} ${length}`).join(', '));
  for (const [stage, length] of lengths) assert.ok(length > 0 && length <= SIZE_LIMIT_CHARS, `longest ${stage} output is ${length} chars, limit ${SIZE_LIMIT_CHARS}`);
}

test('the fixed STATUS path is STATUS_PATH_CHARS long', () => {
  assert.equal(STATUS_PATH.length, STATUS_PATH_CHARS);
});

test('no project agents: startup, the first compaction with the STATUS line and the third compaction fit the hook output cap', async (t) => {
  const outputs = await longestOutputs();
  assertFits(t, outputs);
  assert.ok(outputs.firstCompact.includes(`Re-read ${STATUS_PATH} `), 'the STATUS line is in the compaction output');
  assert.match(outputs.lastCompact, new RegExp(`compacted ${COMPACTIONS} times`));
  assert.equal(outputs.lastCompact.includes(AGENT_NOTE_START), false);
});

test('a project with 10 agents named like the personal ones, each with maxTurns: 60, fits the cap', async (t) => {
  const personal = readdirSync(PERSONAL_AGENTS_DIR).filter((file) => file.endsWith('.md')).sort().slice(0, COPIED_AGENTS);
  assert.equal(personal.length, COPIED_AGENTS);
  const outputs = await longestOutputs(await projectWith(personal.map((file) => [file, agentFile(file.replace(/\.md$/, ''), 'maxTurns: 60\n')])));
  assertFits(t, outputs);
  for (const out of Object.values(outputs)) assert.ok(out.includes(`${AGENT_NOTE_START}${personal[0]} (maxTurns 60, shadows the personal agent)`));
});
