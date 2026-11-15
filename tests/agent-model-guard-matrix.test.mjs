// Tests for the UI brief gate of home/hooks/agent-model-guard.mjs: a ui-implementer or visual-qa call whose prompt names no coverage
// matrix is denied once with the ui-coverage init advice, and the identical call sent again runs (lib/bounce-once.mjs adviceOnce);
// every other call, and the model routing, behaves as before. Each test gets a private HOME (mode file, advice store), a project folder
// holding docs/matrix.json and a private decision log; the hook runs as a process with the hook JSON on stdin (the last tests call the
// exported functions directly). Nothing named in a prompt is executed.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MAX_MATRIX_BYTES, matrixLines, uiBriefDeny } from '../home/hooks/agent-model-guard.mjs';
import { adviceOnce } from '../home/hooks/lib/bounce-once.mjs';
import { hookEnv } from './hook-env.mjs';
import { fastestMs } from './timing.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/agent-model-guard.mjs', import.meta.url));
const SESSION = 'sess1';
const UI_TYPES = ['ui-implementer', 'visual-qa'];
const HOOK_TIMEOUT_MS = 5000; // settings/base.json gives the hook 5 s
const PROMPT = 'Build the sign-in screen.';

// The deny text as the spec words it; a problem line goes before the init line.
const NOT_STARTED = 'Not started: the UI brief names no coverage matrix (the owner was not asked).';
const INIT_LINE = '- Before the first UI lane run `node ~/.claude/tools/ui-coverage/ui-coverage.mjs init <matrix.json> --locales .. --widths .. '
  + '--surfaces .. [--frames frames.json]` and add the line `MATRIX: <path>` (or `MATRIX: none: <reason>` for a one-file tweak with no Figma).';
const SEND_AGAIN = 'Send the same call again unchanged and it runs.';
const SHORT_REASON = '- `MATRIX: none:` needs a reason of 15 or more characters.';
const notAMatrix = (path) => `- \`${path}\` does not exist or is not a matrix.`;
const denied = (...problems) => ({
  hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: [NOT_STARTED, ...problems, INIT_LINE, SEND_AGAIN].join('\n'),
});
const withSonnet = (toolInput) => ({ hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...toolInput, model: 'sonnet' } });

/** @returns {object | null} the hook's hookSpecificOutput, or null when it printed nothing (the call runs); fails the test on a crash */
function outcome({ status, stdout, stderr, error }) {
  assert.equal(error, undefined, 'the hook finished within the hook timeout');
  assert.equal(status, 0, stderr);
  assert.equal(stderr, '');
  return stdout === '' ? null : JSON.parse(stdout).hookSpecificOutput;
}

/**
 * A private HOME with the session's mode, a project folder holding docs/matrix.json, and a private decision log.
 * send(toolInput, options) runs one Agent call through the hook; options.cwd / options.session replace the input's cwd / session_id
 * (present but undefined: left out of the input), options.processCwd is the hook process's own folder.
 */
function gateSession(mode = 'medium') {
  const home = mkdtempSync(join(tmpdir(), 'matrix-gate-home-'));
  const project = mkdtempSync(join(tmpdir(), 'matrix-gate-project-'));
  mkdirSync(join(home, '.claude', 'state', 'modes'), { recursive: true });
  writeFileSync(join(home, '.claude', 'state', 'modes', SESSION), `${mode}\n`);
  mkdirSync(join(project, 'docs'));
  writeFileSync(join(project, 'docs', 'matrix.json'), JSON.stringify({ surfaces: [{ id: 'signin' }] }));
  const env = hookEnv({ HOME: home, USERPROFILE: home });
  delete env.CLAUDE_MODE;
  const inputOf = (toolInput, options) => ({
    session_id: 'session' in options ? options.session : SESSION, cwd: 'cwd' in options ? options.cwd : project, tool_name: 'Agent', tool_input: toolInput,
  });
  return {
    home,
    project,
    store: join(home, '.claude', 'state', 'guard-bounced'),
    log: () => (existsSync(env.CLAUDE_GUARD_LOG) ? readFileSync(env.CLAUDE_GUARD_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []),
    send: (toolInput, options = {}) => outcome(spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(inputOf(toolInput, options)), encoding: 'utf8', env, cwd: options.processCwd, timeout: HOOK_TIMEOUT_MS,
    })),
  };
}

/** The log lines as [hook, tool, decision, outcome]. */
const logRows = (session) => session.log().map((line) => [line.hook, line.tool, line.decision, line.outcome]);

test('no MATRIX line: a ui-implementer and a visual-qa call are denied once with the init advice; the identical call sent again runs', () => {
  const s = gateSession();
  for (const type of UI_TYPES) {
    const call = { description: 'build', prompt: PROMPT, subagent_type: type };
    assert.deepEqual(s.send(call), denied(), `${type}: first send`);
    assert.equal(s.send(call), null, `${type}: the identical retry runs`);
  }
  const once = [['agent-model-guard', 'Agent', 'deny', 'advice'], ['agent-model-guard', 'Agent', 'allow', 'advice-retry']];
  assert.deepEqual(logRows(s), [...once, ...once]);
});

test('a changed prompt, folder or session is a new call: denied again', () => {
  const s = gateSession();
  const call = { prompt: PROMPT, subagent_type: 'ui-implementer' };
  assert.deepEqual(s.send(call), denied());
  assert.deepEqual(s.send({ ...call, prompt: `${PROMPT} ` }), denied(), 'one blank more');
  assert.deepEqual(s.send(call, { cwd: s.home }), denied(), 'another folder');
  assert.deepEqual(s.send(call, { session: 'sess2' }), denied(), 'another session');
  assert.equal(s.send(call), null, 'the first call again: runs');
});

test('a MATRIX line naming a matrix file is quiet: relative to the call cwd, absolute, ~, CRLF line ends, indented, inside a code fence', () => {
  const s = gateSession();
  mkdirSync(join(s.home, 'm'));
  writeFileSync(join(s.home, 'm', 'matrix.json'), JSON.stringify({ surfaces: [] }));
  const prompts = [
    `${PROMPT}\nMATRIX: docs/matrix.json\nDone.`,
    `MATRIX: ${join(s.project, 'docs', 'matrix.json')}`,
    'MATRIX: ~/m/matrix.json',
    `${PROMPT}\r\nMATRIX: docs/matrix.json\r\nDone.\r\n`,
    ' \t MATRIX:   docs/matrix.json  ',
    'Brief:\n```\nMATRIX: docs/matrix.json\n```',
  ];
  for (const prompt of prompts) for (const type of UI_TYPES) assert.equal(s.send({ prompt, subagent_type: type }), null, `${type}: ${prompt}`);
  assert.deepEqual(s.log(), [], 'a quiet gate logs nothing');
  assert.equal(existsSync(s.store), false, 'and stores nothing');
});

test('a named file that is missing or not a matrix object with a surfaces array is named in the advice', () => {
  const s = gateSession();
  const files = { 'array.json': '[{"surfaces":[]}]', 'cells.json': '{"cells":[]}', 'surfaces-object.json': '{"surfaces":{}}', 'broken.json': '{"surfaces":[',
    'null.json': 'null', 'empty.json': '' };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(s.project, 'docs', name), text);
  for (const path of [...Object.keys(files).map((name) => `docs/${name}`), 'docs/missing.json', 'docs', '~/nothing.json']) {
    assert.deepEqual(s.send({ prompt: `${PROMPT}\nMATRIX: ${path}`, subagent_type: 'visual-qa' }), denied(notAMatrix(path)), path);
  }
});

test('a FIFO named as the matrix is never opened: the advice comes at once', { skip: process.platform === 'win32' ? 'no FIFO or mkfifo on Windows' : false }, () => {
  const s = gateSession();
  const made = spawnSync('mkfifo', [join(s.project, 'docs', 'pipe.json')]);
  assert.equal(made.status, 0, 'mkfifo made the FIFO');
  assert.deepEqual(s.send({ prompt: 'MATRIX: docs/pipe.json', subagent_type: 'ui-implementer' }), denied(notAMatrix('docs/pipe.json')));
});

test('MATRIX: none: needs a reason of 15 or more characters', () => {
  const s = gateSession();
  for (const reason of ['one-file tweak, no Figma, one locale', 'x'.repeat(15), `  ${'x'.repeat(15)}  `]) {
    assert.equal(s.send({ prompt: `${PROMPT}\nMATRIX: none: ${reason}`, subagent_type: 'ui-implementer' }), null, reason);
  }
  for (const prompt of ['MATRIX: none: short tweak', `MATRIX: none: ${'x'.repeat(14)}`, 'MATRIX: none:', `MATRIX: none:    ${'x'.repeat(14)}   `]) {
    assert.deepEqual(s.send({ prompt, subagent_type: 'ui-implementer' }), denied(SHORT_REASON), prompt);
  }
});

test('only a line that starts with MATRIX: counts: mid-line text, inline code, a bullet, other letter case do not', () => {
  const s = gateSession();
  const prompts = ['Use the line `MATRIX: docs/matrix.json` in briefs.', 'Notes - MATRIX: docs/matrix.json', '- MATRIX: docs/matrix.json',
    '> MATRIX: docs/matrix.json', 'matrix: docs/matrix.json', 'Matrix: docs/matrix.json', 'MATRIX docs/matrix.json', 'MATRIX:'];
  for (const prompt of prompts) assert.deepEqual(s.send({ prompt, subagent_type: 'ui-implementer' }), denied(), prompt);
});

test('one usable MATRIX line is enough; with none usable, each problem is listed once', () => {
  const s = gateSession();
  assert.equal(s.send({ prompt: 'MATRIX: docs/missing.json\nMATRIX: docs/matrix.json', subagent_type: 'ui-implementer' }), null);
  assert.equal(s.send({ prompt: 'MATRIX: none: short\nMATRIX: none: one-file tweak, no Figma', subagent_type: 'ui-implementer' }), null);
  const prompt = 'MATRIX: docs/a.json\nMATRIX: none: short\nMATRIX: docs/a.json';
  assert.deepEqual(s.send({ prompt, subagent_type: 'ui-implementer' }), denied(notAMatrix('docs/a.json'), SHORT_REASON));
});

test('the quoted path loses its control and bidi characters and is cut', () => {
  const s = gateSession();
  const coloured = `docs/\u001b[31mred\u0007${String.fromCharCode(0x202e, 0x2028)}.json`;
  assert.deepEqual(s.send({ prompt: `MATRIX: ${coloured}`, subagent_type: 'ui-implementer' }), denied(notAMatrix('docs/[31mred.json')));
  const long = `docs/${'a'.repeat(5000)}.json`;
  assert.deepEqual(s.send({ prompt: `MATRIX: ${long}`, subagent_type: 'ui-implementer' }), denied(notAMatrix(`${long.slice(0, 200)}...`)));
});

test('hook input without cwd: a relative path is read from the hook folder, and the identical retry still runs', () => {
  const s = gateSession();
  const noCwd = { cwd: undefined, processCwd: s.project };
  assert.equal(s.send({ prompt: 'MATRIX: docs/matrix.json', subagent_type: 'ui-implementer' }, noCwd), null);
  const call = { prompt: 'MATRIX: docs/missing.json', subagent_type: 'ui-implementer' };
  assert.deepEqual(s.send(call, noCwd), denied(notAMatrix('docs/missing.json')));
  assert.equal(s.send(call, noCwd), null);
});

test('other subagent types are untouched: the same output as before, no log line, no store', () => {
  const s = gateSession('ultra-high');
  for (const type of ['general-purpose', 'Explore', undefined]) {
    const call = { prompt: PROMPT, ...(type === undefined ? {} : { subagent_type: type }) };
    assert.deepEqual(s.send(call), withSonnet(call), `${type}: sonnet as before`);
  }
  for (const type of ['implementer', 'fork', 'scout', 'some-plugin:ui-implementer', 'UI-Implementer', 'ui-implementer ']) {
    assert.equal(s.send({ prompt: PROMPT, subagent_type: type }), null, `${type}: untouched as before`);
  }
  assert.deepEqual(s.log(), []);
  assert.equal(existsSync(s.store), false);
});

test('the model routing is unchanged around a gated call: its retry gets no model (the agent file pins one), Explore still gets sonnet', () => {
  const s = gateSession('ultra-high');
  const call = { prompt: PROMPT, subagent_type: 'visual-qa', model: '' };
  assert.deepEqual(s.send(call), denied());
  assert.equal(s.send(call), null, 'the retry: no updatedInput, as before for a pinned agent');
  const explore = { prompt: PROMPT, subagent_type: 'Explore' };
  assert.deepEqual(s.send(explore), withSonnet(explore));
  assert.equal(s.send({ prompt: 'MATRIX: docs/matrix.json', subagent_type: 'ui-implementer', model: 'opus' }), null, 'an explicit model is kept');
});

test('fail open: an unusable store or no session id lets the call run and logs advice-unrecorded', () => {
  const s = gateSession();
  mkdirSync(join(s.home, '.claude', 'state'), { recursive: true });
  writeFileSync(s.store, 'not a folder');
  const call = { prompt: PROMPT, subagent_type: 'ui-implementer' };
  for (const send of [1, 2]) assert.equal(s.send(call), null, `send ${send}`);
  assert.equal(s.send(call, { session: undefined }), null, 'no session id');
  assert.equal(s.send(call, { session: '../escape' }), null, 'an odd session id');
  assert.deepEqual(logRows(s), Array(4).fill(['agent-model-guard', 'Agent', 'allow', 'advice-unrecorded']));
  assert.equal(readFileSync(s.store, 'utf8'), 'not a folder');
});

test('a huge prompt is decided within the hook timeout', () => {
  const s = gateSession();
  const junk = [`${' '.repeat(1_000_000)}x`, '\n'.repeat(500_000), `MATRIX:${' '.repeat(500_000)}`, Array(100_000).fill(' \tMATRIX docs/x.json').join('\n')].join('\n');
  const started = performance.now();
  assert.deepEqual(s.send({ prompt: junk, subagent_type: 'ui-implementer' }), denied());
  assert.equal(s.send({ prompt: `${junk}\nMATRIX: docs/matrix.json`, subagent_type: 'ui-implementer' }), null, 'a MATRIX line after the junk is found');
  assert.ok(performance.now() - started < HOOK_TIMEOUT_MS, 'both calls together within one hook timeout');
});

test('adviceOnce names the hook and tool it is given in the log line; without them the line says pre-bash-guard and Bash as before', () => {
  const home = mkdtempSync(join(tmpdir(), 'advice-names-'));
  const env = { HOME: home, CLAUDE_GUARD_LOG: join(home, 'guard.jsonl') };
  const input = { session_id: SESSION };
  adviceOnce(['advice text'], { command: 'first', cwd: home, input }, env);
  adviceOnce(['advice text'], { command: 'second', cwd: home, input, hook: 'agent-model-guard', tool: 'Agent' }, env);
  const lines = readFileSync(env.CLAUDE_GUARD_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => Object.keys(line).slice(0, 3)), [['ts', 'hook', 'tool'], ['ts', 'hook', 'tool']], 'same key order as before');
  assert.deepEqual(lines.map((line) => [line.hook, line.tool, line.outcome]), [['pre-bash-guard', 'Bash', 'advice'], ['agent-model-guard', 'Agent', 'advice']]);
});

test('a matrix file of MAX_MATRIX_BYTES is read; one byte more is never read and is named in the advice', () => {
  const s = gateSession();
  writeFileSync(join(s.project, 'docs', 'at-cap.json'), '{"surfaces":[]}'.padEnd(MAX_MATRIX_BYTES));
  writeFileSync(join(s.project, 'docs', 'over-cap.json'), '{"surfaces":[]}'.padEnd(MAX_MATRIX_BYTES + 1));
  assert.equal(s.send({ prompt: 'MATRIX: docs/at-cap.json', subagent_type: 'ui-implementer' }), null);
  assert.deepEqual(s.send({ prompt: 'MATRIX: docs/over-cap.json', subagent_type: 'ui-implementer' }), denied(notAMatrix('docs/over-cap.json')));
});

test('matrixLines: only lines that start with MATRIX: count; blanks and a CRLF are trimmed; empty values are left out; at most five', () => {
  const prompt = 'a\nMATRIX: x.json\r\n  MATRIX:\ty.json \nb MATRIX: z.json\nMATRIX:\n```\nMATRIX: none: why\n```';
  assert.deepEqual(matrixLines(prompt), ['x.json', 'y.json', 'none: why']);
  assert.deepEqual(matrixLines('MATRIX: first.json\nrest'), ['first.json'], 'the first line of the prompt counts');
  const nine = Array.from({ length: 9 }, (_, n) => `MATRIX: m${n}.json`).join('\n');
  assert.deepEqual(matrixLines(nine), ['m0.json', 'm1.json', 'm2.json', 'm3.json', 'm4.json']);
  assert.deepEqual(matrixLines(''), []);
});

test('matrixLines: a huge hostile prompt is scanned in linear time', () => {
  const hostile = [`${' '.repeat(2_000_000)}x`, '\n'.repeat(2_000_000), `MATRIX:${' \t'.repeat(1_000_000)}`,
    Array(200_000).fill(' \tMATRIX docs/x.json').join('\n'), ' '.repeat(2_000_000)].join('\n');
  assert.ok(fastestMs(() => matrixLines(hostile)) < 500, 'far inside the 5 s hook timeout');
});

test('uiBriefDeny fails open: input or an environment that throws when read, and odd input, give no output', async () => {
  const home = mkdtempSync(join(tmpdir(), 'matrix-gate-odd-'));
  const env = { HOME: home, CLAUDE_GUARD_LOG: join(home, 'guard.jsonl') };
  const exploding = new Proxy({}, { get: () => { throw new Error('exploded'); } });
  assert.equal(await uiBriefDeny(exploding, env), '');
  assert.equal(await uiBriefDeny({ tool_input: exploding }, env), '');
  const homeMatrix = { session_id: SESSION, cwd: home, tool_input: { prompt: 'MATRIX: ~/matrix.json', subagent_type: 'ui-implementer' } };
  assert.equal(await uiBriefDeny(homeMatrix, exploding), '', 'HOME cannot be read');
  for (const odd of [undefined, null, 42, 'text', { tool_input: null }, { tool_input: { subagent_type: 'ui-implementer', prompt: 42 } }]) {
    assert.equal(await uiBriefDeny(odd, env), '', JSON.stringify(odd));
  }
  assert.equal(existsSync(env.CLAUDE_GUARD_LOG), false, 'nothing logged');
});
