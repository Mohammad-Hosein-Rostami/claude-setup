// Tests for the brief lines of home/hooks/agent-model-guard.mjs (lib/agent-brief.mjs): one line naming STATUS.md goes before any brief
// whose project has `## Standing rules`, and one line asking for the Reuse inventory and Contract facts lists goes after an architect or
// Plan brief. The hook runs as a process with the hook JSON on stdin; each test gets a private HOME (mode file, advice store), a project
// folder holding a `.git` folder whose info/exclude lists STATUS.md (built by hand: the hook reads files and runs no program), and a
// private decision log. Nothing from a prompt or a STATUS.md may reach the added lines.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MAX_EXCLUDE_BYTES, withBriefLines } from '../home/hooks/lib/agent-brief.mjs';
import { hookEnv } from './hook-env.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/agent-model-guard.mjs', import.meta.url));
const SESSION = 'sess1';
const HOOK_TIMEOUT_MS = 5000; // settings/base.json gives the hook 5 s
const PROMPT = 'Design the sign-in flow.';
const RULES = '# Status\n\n## Standing rules\n\n- Reuse the existing snackbar.\n\n## Work items\n| id | item |\n';
const posixOnly = { skip: process.platform === 'win32' ? 'no FIFO or plain symlinks on Windows' : false };

// The two lines as the brief words them.
const rulesLine = (path) => `Read "## Standing rules" in ${path} first; where they differ from this brief, follow them.`;
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

/** Writes info/exclude of the git folder gitDir (made when missing). */
function writeExclude(gitDir, text) {
  mkdirSync(join(gitDir, 'info'), { recursive: true });
  writeFileSync(join(gitDir, 'info', 'exclude'), text);
}

/**
 * A private HOME with the session's mode and a project folder (its real path) holding a `.git` folder whose info/exclude lists
 * STATUS.md. send(toolInput, options) runs one Agent call; options.cwd replaces the input's cwd (undefined: left out),
 * options.processCwd is the hook process's own folder; exclude(text) rewrites the project's info/exclude; extraEnv is added last.
 */
function briefSession(mode = 'medium', projectPrefix = 'brief-project-', extraEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), 'brief-home-'));
  const project = realpathSync(mkdtempSync(join(tmpdir(), projectPrefix)));
  mkdirSync(join(home, '.claude', 'state', 'modes'), { recursive: true });
  writeFileSync(join(home, '.claude', 'state', 'modes', SESSION), `${mode}\n`);
  writeExclude(join(project, '.git'), 'STATUS.md\n');
  const env = hookEnv({ HOME: home, USERPROFILE: home, ...extraEnv });
  delete env.CLAUDE_MODE;
  const inputOf = (toolInput, options) => ({ session_id: SESSION, cwd: 'cwd' in options ? options.cwd : project, tool_name: 'Agent', tool_input: toolInput });
  return {
    project,
    status: join(project, 'STATUS.md'),
    exclude: (text) => writeExclude(join(project, '.git'), text),
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

test('the STATUS.md at the top counts only when the repository\'s own info/exclude lists it, from any depth below', () => {
  const s = briefSession();
  writeFileSync(s.status, RULES);
  const call = { prompt: PROMPT, subagent_type: 'implementer' };
  const withRules = allowed({ ...call, prompt: `${rulesLine(s.status)}\n${PROMPT}` });
  const deep = join(s.project, ...Array.from({ length: 12 }, (_, level) => `d${level}`));
  mkdirSync(deep, { recursive: true });
  assert.deepEqual(s.send(call), withRules, 'listed');
  assert.deepEqual(s.send(call, { cwd: deep }), withRules, 'cwd 12 levels down');
  const lists = [['', false], ['/STATUS.md\n', true], ['  STATUS.md \t\n', true], ['# local\n\nSTATUS.md\r\n', true],
    ['# STATUS.md\n#/STATUS.md\n\n \nSTATUS.md.bak\n!STATUS.md\n*.md\nstatus.md\ndocs/STATUS.md\n', false]];
  for (const [text, listed] of lists) {
    s.exclude(text);
    assert.deepEqual(s.send(call), listed ? withRules : null, JSON.stringify(text));
  }
  s.exclude('');
  writeFileSync(join(s.project, '.gitignore'), 'STATUS.md\n');
  assert.equal(s.send(call), null, 'a .gitignore entry does not count');
});

test('the file must be listed in its folder as exactly STATUS.md: a status.md is never named, even on a case-insensitive disk', () => {
  const s = briefSession();
  writeFileSync(join(s.project, 'status.md'), RULES);
  const call = { prompt: PROMPT, subagent_type: 'implementer' };
  assert.equal(s.send(call), null, 'in a repository');
  const loose = mkdtempSync(join(tmpdir(), 'brief-no-git-'));
  writeFileSync(join(loose, 'status.md'), RULES);
  assert.equal(s.send(call, { cwd: loose }), null, 'outside git');
});

test('a linked worktree reads the exclude list of its main repository through commondir', () => {
  const s = briefSession();
  const worktree = realpathSync(mkdtempSync(join(tmpdir(), 'brief-worktree-')));
  const admin = join(s.project, '.git', 'worktrees', 'wt'); // the layout `git worktree add` writes
  mkdirSync(admin, { recursive: true });
  writeFileSync(join(admin, 'commondir'), '../..\n');
  writeFileSync(join(worktree, '.git'), `gitdir: ${admin}\n`);
  writeFileSync(join(worktree, 'STATUS.md'), RULES);
  const call = { prompt: PROMPT, subagent_type: 'implementer' };
  assert.deepEqual(s.send(call, { cwd: worktree }), allowed({ ...call, prompt: `${rulesLine(join(worktree, 'STATUS.md'))}\n${PROMPT}` }));
  s.exclude('');
  assert.equal(s.send(call, { cwd: worktree }), null, 'the main repository no longer lists it');
});

test('a submodule with its own .git file and no exclude line: no line, and the parent\'s STATUS.md is never used', () => {
  const s = briefSession();
  writeFileSync(s.status, RULES);
  const ui = join(s.project, 'libs', 'ui');
  const moduleGit = join(s.project, '.git', 'modules', 'ui');
  mkdirSync(join(ui, 'src'), { recursive: true });
  writeExclude(moduleGit, '# git ls-files --others --exclude-from=.git/info/exclude\n');
  writeFileSync(join(ui, '.git'), 'gitdir: ../../.git/modules/ui\n'); // relative, as git writes it
  writeFileSync(join(ui, 'STATUS.md'), RULES);
  const call = { prompt: PROMPT, subagent_type: 'implementer' };
  assert.equal(s.send(call, { cwd: join(ui, 'src') }), null);
  writeExclude(moduleGit, 'STATUS.md\n');
  assert.deepEqual(s.send(call, { cwd: join(ui, 'src') }), allowed({ ...call, prompt: `${rulesLine(join(ui, 'STATUS.md'))}\n${PROMPT}` }), 'its own list');
});

test('a .git that is a FIFO or a link: no line, and nothing waits', posixOnly, () => {
  const s = briefSession();
  const call = { prompt: PROMPT, subagent_type: 'implementer' };
  const makers = { FIFO: (path) => spawnSync('mkfifo', [path]), link: (path) => symlinkSync(join(s.project, '.git'), path) };
  for (const [name, make] of Object.entries(makers)) {
    const repo = mkdtempSync(join(tmpdir(), 'brief-odd-git-'));
    make(join(repo, '.git'));
    writeFileSync(join(repo, 'STATUS.md'), RULES);
    assert.equal(s.send(call, { cwd: repo }), null, name);
  }
});

test('an info/exclude of 5 MB is read only from its start; a line cut at the read cap never counts', () => {
  const s = briefSession();
  writeFileSync(s.status, RULES);
  const call = { prompt: PROMPT, subagent_type: 'implementer' };
  const filler = '# filler line\n'.repeat(400_000);
  s.exclude(`STATUS.md\n${filler}`);
  assert.deepEqual(s.send(call), allowed({ ...call, prompt: `${rulesLine(s.status)}\n${PROMPT}` }), 'listed at the top');
  s.exclude(`${filler}STATUS.md\n`);
  assert.equal(s.send(call), null, 'listed after the part that is read');
  s.exclude(`${'#'.repeat(MAX_EXCLUDE_BYTES - 'STATUS.md'.length - 1)}\nSTATUS.md.bak\n`); // the cap ends right after "STATUS.md"
  assert.equal(s.send(call), null, 'STATUS.md.bak cut at the cap');
});

test('no program runs: a disguised git folder with core.fsmonitor and a fake git first on PATH leave no marker', posixOnly, () => {
  const bin = mkdtempSync(join(tmpdir(), 'brief-fake-bin-'));
  const markers = mkdtempSync(join(tmpdir(), 'brief-markers-'));
  const script = (marker) => `#!/bin/sh\ntouch '${join(markers, marker)}'\n`;
  writeFileSync(join(bin, 'git'), script('git-ran'), { mode: 0o755 });
  const s = briefSession('medium', 'brief-project-', { PATH: `${bin}${delimiter}${process.env.PATH}` });
  writeFileSync(s.status, RULES);
  const ui = join(s.project, 'packages', 'ui'); // looks like a bare git folder (HEAD, objects, refs, config) but is not named .git
  mkdirSync(join(ui, 'objects'), { recursive: true });
  mkdirSync(join(ui, 'refs'));
  writeFileSync(join(ui, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(ui, 'fsmonitor.sh'), script('fsmonitor-ran'), { mode: 0o755 });
  writeFileSync(join(ui, 'config'), `[core]\n\trepositoryformatversion = 0\n\tbare = true\n\tfsmonitor = ${join(ui, 'fsmonitor.sh')}\n`);
  const call = { prompt: PROMPT, subagent_type: 'implementer' };
  assert.deepEqual(s.send(call, { cwd: ui }), allowed({ ...call, prompt: `${rulesLine(s.status)}\n${PROMPT}` }), 'the folder holding .git decides');
  s.send({ prompt: PROMPT, subagent_type: 'Explore' }, { cwd: ui });
  s.send({ prompt: PROMPT, subagent_type: 'ui-implementer' }, { cwd: ui });
  assert.deepEqual(readdirSync(markers), [], 'neither the fake git nor the fsmonitor ran');
});

test('a STATUS.md in a subfolder never counts: the one at the top wins, and without it there is no line', () => {
  const s = briefSession();
  const app = join(s.project, 'packages', 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'STATUS.md'), RULES); // ignored too: an exclude pattern without a slash matches in every folder
  const call = { prompt: PROMPT, subagent_type: 'implementer' };
  assert.equal(s.send(call, { cwd: app }), null, 'only the package folder has one');
  writeFileSync(s.status, RULES);
  assert.deepEqual(s.send(call, { cwd: app }), allowed({ ...call, prompt: `${rulesLine(s.status)}\n${PROMPT}` }), 'the top one wins');
});

test('outside git only the STATUS.md in cwd itself counts', () => {
  const s = briefSession();
  const call = { prompt: PROMPT, subagent_type: 'implementer' };
  const loose = mkdtempSync(join(tmpdir(), 'brief-no-git-'));
  mkdirSync(join(loose, 'sub'));
  writeFileSync(join(loose, 'STATUS.md'), RULES);
  assert.equal(s.send(call, { cwd: join(loose, 'sub') }), null, 'a parent folder does not count');
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
    const model = type === 'Plan' ? { model: 'opus' } : {}; // Plan gets opus in every mode
    assert.deepEqual(s.send(call), allowed({ ...call, ...model, prompt: `${PROMPT}\n${DESIGN_LISTS}` }), type);
    const withWords = { ...call, prompt: `${PROMPT}\nList the Reuse inventory first.` };
    assert.deepEqual(s.send(withWords), type === 'Plan' ? allowed({ ...withWords, ...model }) : null, `${type} with the words: prompt unchanged`);
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
