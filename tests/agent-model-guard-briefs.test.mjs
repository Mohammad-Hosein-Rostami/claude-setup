// Tests for the brief lines of home/hooks/agent-model-guard.mjs (lib/agent-brief.mjs): one line naming STATUS.md goes before any brief
// whose project has `## Standing rules`, and one line asking for the Reuse inventory and Contract facts lists goes after an architect or
// Plan brief. The hook runs as a process with the hook JSON on stdin; each test gets a private HOME (mode file, advice store), a project
// folder holding a `.git` folder, and a private decision log. Nothing from a prompt or a STATUS.md may reach the added lines.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { withBriefLines } from '../home/hooks/lib/agent-brief.mjs';
import { hookEnv } from './hook-env.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/agent-model-guard.mjs', import.meta.url));
const SESSION = 'sess1';
const HOOK_TIMEOUT_MS = 5000; // settings/base.json gives the hook 5 s
const PROMPT = 'Design the sign-in flow.';
const RULES = '# Status\n\n## Standing rules\n\n- Reuse the existing snackbar.\n\n## Work items\n| id | item |\n';
const posixOnly = { skip: process.platform === 'win32' ? 'no FIFO or plain symlinks on Windows' : false };

// The two lines as the brief words them.
const rulesLine = (path) => `Read "## Standing rules" in ${path} first; they are the owner's and override this brief.`;
const DESIGN_LISTS = 'Your spec must include "Reuse inventory" (the existing component, string or helper for each need, or none: <search used>) '
  + 'and "Contract facts" (every default, fallback, limit and enum the API schema states, and what the design does about each); '
  + 'list product facts the repo does not state under "Unconfirmed".';
const allowed = (updatedInput) => ({ hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput });

/** @returns {object | null} the hook's hookSpecificOutput, or null when it printed nothing; fails the test on a crash or a hang */
function outcome({ status, stdout, stderr, error }) {
  assert.equal(error, undefined, 'the hook finished within the hook timeout');
  assert.equal(status, 0, stderr);
  assert.equal(stderr, '');
  return stdout === '' ? null : JSON.parse(stdout).hookSpecificOutput;
}

/**
 * A private HOME with the session's mode and a project folder holding `.git`. send(toolInput, options) runs one Agent call;
 * options.cwd replaces the input's cwd (undefined: left out), options.processCwd is the hook process's own folder.
 */
function briefSession(mode = 'medium', projectPrefix = 'brief-project-') {
  const home = mkdtempSync(join(tmpdir(), 'brief-home-'));
  const project = mkdtempSync(join(tmpdir(), projectPrefix));
  mkdirSync(join(home, '.claude', 'state', 'modes'), { recursive: true });
  writeFileSync(join(home, '.claude', 'state', 'modes', SESSION), `${mode}\n`);
  mkdirSync(join(project, '.git'));
  const env = hookEnv({ HOME: home, USERPROFILE: home });
  delete env.CLAUDE_MODE;
  const inputOf = (toolInput, options) => ({ session_id: SESSION, cwd: 'cwd' in options ? options.cwd : project, tool_name: 'Agent', tool_input: toolInput });
  return {
    project,
    status: join(project, 'STATUS.md'),
    send: (toolInput, options = {}) => outcome(spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(inputOf(toolInput, options)), encoding: 'utf8', env, cwd: options.processCwd, timeout: HOOK_TIMEOUT_MS,
    })),
  };
}

test('a STATUS.md with standing rules: one line naming it goes before the brief, for every subagent type', () => {
  const s = briefSession();
  writeFileSync(s.status, RULES);
  for (const type of ['implementer', 'reviewer', 'scout', 'fork', 'some-plugin:agent', undefined]) {
    const call = { description: 'x', prompt: PROMPT, ...(type === undefined ? {} : { subagent_type: type }) };
    const model = type === undefined ? { model: 'sonnet' } : {};
    assert.deepEqual(s.send(call), allowed({ ...call, ...model, prompt: `${rulesLine(s.status)}\n${PROMPT}` }), String(type));
  }
});

test('no rules line without the heading, with nothing under it, or when the brief already names STATUS.md', () => {
  const s = briefSession();
  const call = { prompt: PROMPT, subagent_type: 'implementer' };
  for (const text of ['# Status\n\n## Work items\n- a\n', '## Standing rules\n\n \t\n## Work items\n- a\n', '# S\n## Standing rules\n\n',
    '## Standing rules\n# Next\n- a\n', '- Standing rules: none\n']) {
    writeFileSync(s.status, text);
    assert.equal(s.send(call), null, JSON.stringify(text));
  }
  writeFileSync(s.status, RULES);
  assert.equal(s.send({ ...call, prompt: `${PROMPT} Follow STATUS.md.` }), null, 'the brief names STATUS.md');
});

test('a STATUS.md in a parent folder up to the git root counts; one above the git root or more than 5 levels up does not', () => {
  const s = briefSession();
  writeFileSync(s.status, RULES);
  const call = { prompt: PROMPT, subagent_type: 'implementer' };
  const withRules = allowed({ ...call, prompt: `${rulesLine(s.status)}\n${PROMPT}` });
  const five = join(s.project, '1', '2', '3', '4', '5');
  mkdirSync(join(five, '6'), { recursive: true });
  assert.deepEqual(s.send(call, { cwd: join(s.project, '1') }), withRules, 'one level up');
  assert.deepEqual(s.send(call, { cwd: five }), withRules, 'five levels up');
  assert.equal(s.send(call, { cwd: join(five, '6') }), null, 'six levels up: not looked for');
  const inner = join(s.project, 'inner');
  mkdirSync(join(inner, '.git'), { recursive: true });
  assert.equal(s.send(call, { cwd: inner }), null, 'above the git root of inner');
  const loose = mkdtempSync(join(tmpdir(), 'brief-no-git-'));
  mkdirSync(join(loose, 'sub'));
  writeFileSync(join(loose, 'STATUS.md'), RULES);
  assert.equal(s.send(call, { cwd: join(loose, 'sub') }), null, 'outside git only the folder itself counts');
  assert.deepEqual(s.send(call, { cwd: loose }), allowed({ ...call, prompt: `${rulesLine(join(loose, 'STATUS.md'))}\n${PROMPT}` }));
});

test('a STATUS.md that links out of the project is ignored, a link inside it counts; a FIFO or folder is never read', posixOnly, () => {
  const call = { prompt: PROMPT, subagent_type: 'implementer' };
  const out = briefSession();
  const outside = mkdtempSync(join(tmpdir(), 'brief-outside-'));
  writeFileSync(join(outside, 'STATUS.md'), RULES);
  symlinkSync(join(outside, 'STATUS.md'), out.status);
  assert.equal(out.send(call), null, 'a link out of the project');
  const inside = briefSession();
  mkdirSync(join(inside.project, 'docs'));
  writeFileSync(join(inside.project, 'docs', 'status.md'), RULES);
  symlinkSync(join(inside.project, 'docs', 'status.md'), inside.status);
  assert.deepEqual(inside.send(call), allowed({ ...call, prompt: `${rulesLine(inside.status)}\n${PROMPT}` }), 'a link inside');
  const fifo = briefSession();
  assert.equal(spawnSync('mkfifo', [fifo.status]).status, 0, 'mkfifo made the FIFO');
  assert.equal(fifo.send(call), null, 'a FIFO');
  const folder = briefSession();
  mkdirSync(folder.status);
  assert.equal(folder.send(call), null, 'a folder');
});

test('a 5 MB STATUS.md is read only from its start, in bounded time; CRLF line ends work', () => {
  const s = briefSession();
  const call = { prompt: PROMPT, subagent_type: 'implementer' };
  const withRules = allowed({ ...call, prompt: `${rulesLine(s.status)}\n${PROMPT}` });
  const started = performance.now();
  writeFileSync(s.status, `${RULES}${'filler line\n'.repeat(450_000)}`);
  assert.deepEqual(s.send(call), withRules, 'rules at the top of a 5 MB file');
  writeFileSync(s.status, `${'filler line\n'.repeat(450_000)}${RULES}`);
  assert.equal(s.send(call), null, 'rules after the part that is read');
  assert.ok(performance.now() - started < HOOK_TIMEOUT_MS, 'both within one hook timeout');
  writeFileSync(s.status, RULES.replaceAll('\n', '\r\n'));
  assert.deepEqual(s.send(call), withRules, 'CRLF');
});

test('hook input without cwd: the STATUS.md of the hook folder counts', () => {
  const s = briefSession();
  writeFileSync(s.status, RULES);
  const call = { prompt: PROMPT, subagent_type: 'implementer' };
  const status = join(realpathSync(s.project), 'STATUS.md'); // the hook's own folder, as the system reports it
  assert.deepEqual(s.send(call, { cwd: undefined, processCwd: s.project }), allowed({ ...call, prompt: `${rulesLine(status)}\n${PROMPT}` }));
});

test('the path in the rules line has no control or bidi characters', () => {
  const s = briefSession('medium', `brief-\u0007${String.fromCharCode(0x202e)}-`);
  writeFileSync(s.status, RULES);
  const printed = s.send({ prompt: PROMPT, subagent_type: 'implementer' }).updatedInput.prompt.split('\n')[0];
  assert.equal(printed, rulesLine(s.status.replace('\u0007', '').replace(String.fromCharCode(0x202e), '')));
});

test('an architect or Plan brief without "Reuse inventory" gets the two-lists line after it; with the words it is unchanged', () => {
  const s = briefSession();
  for (const type of ['architect', 'Plan']) {
    const call = { prompt: PROMPT, subagent_type: type };
    assert.deepEqual(s.send(call), allowed({ ...call, prompt: `${PROMPT}\n${DESIGN_LISTS}` }), type);
    assert.equal(s.send({ ...call, prompt: `${PROMPT}\nList the Reuse inventory first.` }), null, `${type} with the words`);
  }
});

test('other types get no design line', () => {
  const s = briefSession();
  for (const type of ['implementer', 'reviewer', 'architect-helper', 'plan', 'fork']) assert.equal(s.send({ prompt: PROMPT, subagent_type: type }), null, type);
  for (const type of ['Explore', 'general-purpose']) {
    const call = { prompt: PROMPT, subagent_type: type };
    assert.deepEqual(s.send(call), allowed({ ...call, model: 'sonnet' }), `${type}: the model only, as before`);
  }
  assert.equal(s.send({ prompt: 'MATRIX: none: one-file tweak, no Figma, one locale', subagent_type: 'visual-qa' }), null);
});

test('with the model rewrite: Explore gets sonnet and the rules line; Plan in ultra-high gets opus and both lines', () => {
  const s = briefSession('ultra-high');
  writeFileSync(s.status, RULES);
  const explore = { prompt: PROMPT, subagent_type: 'Explore' };
  assert.deepEqual(s.send(explore), allowed({ ...explore, model: 'sonnet', prompt: `${rulesLine(s.status)}\n${PROMPT}` }));
  const plan = { prompt: PROMPT, subagent_type: 'Plan' };
  assert.deepEqual(s.send(plan), allowed({ ...plan, model: 'opus', prompt: `${rulesLine(s.status)}\n${PROMPT}\n${DESIGN_LISTS}` }));
  assert.deepEqual(s.send({ ...plan, model: 'haiku' }), allowed({ ...plan, model: 'haiku', prompt: `${rulesLine(s.status)}\n${PROMPT}\n${DESIGN_LISTS}` }));
});

test('with the UI brief gate: a UI brief with no MATRIX line is still denied once, and its retry gets the rules line', () => {
  const s = briefSession();
  writeFileSync(s.status, RULES);
  const call = { prompt: 'Build the sign-in screen.', subagent_type: 'ui-implementer' };
  const first = s.send(call);
  assert.equal(first.permissionDecision, 'deny');
  assert.match(first.permissionDecisionReason, /^Not started: the UI brief names no coverage matrix/);
  assert.deepEqual(s.send(call), allowed({ ...call, prompt: `${rulesLine(s.status)}\n${call.prompt}` }), 'the retry');
  assert.deepEqual(s.send(call), allowed({ ...call, prompt: `${rulesLine(s.status)}\n${call.prompt}` }), 'and the same again');
});

test('a brief that already carries the lines is not extended twice', () => {
  const s = briefSession();
  writeFileSync(s.status, RULES);
  const once = s.send({ prompt: PROMPT, subagent_type: 'architect' }).updatedInput;
  assert.equal(once.prompt, `${rulesLine(s.status)}\n${PROMPT}\n${DESIGN_LISTS}`);
  assert.equal(s.send(once), null);
});

test('Persian text in the brief reaches the agent byte for byte', () => {
  const s = briefSession();
  writeFileSync(s.status, RULES);
  const persian = `طراحی صفحه${String.fromCharCode(0x200c)}ی ورود: دکمهٔ «ادامه» را از سامانهٔ طراحی بردار.\n`.repeat(3000); // over 64 KB, a ZWNJ inside
  const prompt = s.send({ prompt: persian, subagent_type: 'architect' }).updatedInput.prompt;
  assert.ok(Buffer.from(prompt).equals(Buffer.from(`${rulesLine(s.status)}\n${persian}\n${DESIGN_LISTS}`)));
});

test('withBriefLines fails open: input that throws when read, odd input or an odd cwd gives null (the brief stays as it is)', () => {
  const exploding = new Proxy({}, { get: () => { throw new Error('exploded'); } });
  for (const odd of [exploding, undefined, null, 42, 'text', { prompt: 42, subagent_type: 'architect' }]) assert.equal(withBriefLines(odd, tmpdir()), null);
  assert.equal(withBriefLines({ prompt: PROMPT, subagent_type: 'implementer' }, { not: 'a path' }), null, 'not a string: this folder, no STATUS.md');
});
