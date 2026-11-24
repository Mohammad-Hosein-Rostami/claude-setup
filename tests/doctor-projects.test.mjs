// Tests for the project-setup rows of scripts/doctor-projects.mjs (doctor-project-overrides.mjs): project settings that switch
// off or weaken ours, CLAUDE.local.md note imports, notes no known project's key matches, and what doctor cannot read.
// Every case is a fixture in a cs-test-* temp folder: a temp HOME (its .claude and .claude.json), a fake setup repo and the
// projects; the script runs as a child with that HOME and no user git config (git-tidy-helpers.mjs CLEAN_ENV).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, git } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/doctor-projects.mjs', import.meta.url));
const DOCTOR = fileURLToPath(new URL('../scripts/doctor.sh', import.meta.url));
const POSIX = process.platform !== 'win32';
const asRoot = POSIX && process.getuid?.() === 0; // root reads a folder whatever its mode
const noChmod = (!POSIX || asRoot) && 'needs a file mode that denies reading';
const noJq = spawnSync('jq', ['--version']).status !== 0 && 'jq not installed';
const SECRET = 'sk-ant-fixture-value-never-shown';

/** Writes `files` (path to text, or an object written as JSON) under `dir`. */
function writeFiles(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof text === 'string' ? text : JSON.stringify(text));
  }
}

/**
 * A temp HOME, a setup repo and projects. `projects`: folder name to files; `listed`: extra global-config keys (gone folders).
 * @returns {{ root: string, home: string, claude: string, repo: string, config: string, project: (name: string) => string }}
 */
function fixture({ projects = {}, listed = [], notes = {}, ours = { model: 'opus' } } = {}) {
  const root = realpathSync(makeTempDir('doctor-projects-'));
  const home = join(root, 'home');
  const claude = join(home, '.claude');
  const repo = join(root, 'repo');
  writeFiles(claude, { 'settings.json': ours, 'CLAUDE.md': '# ours\n', ...Object.fromEntries(Object.entries(notes).map(([key, text]) => [`project-notes/${key}.md`, text])) });
  mkdirSync(join(claude, 'skills'), { recursive: true });
  writeFiles(repo, { 'settings/base.json': {}, 'home/project-notes/README.md': '# notes\n' });
  mkdirSync(join(repo, 'home', 'skills'), { recursive: true });
  const project = (name) => join(root, 'p', name);
  for (const [name, files] of Object.entries(projects)) writeFiles(project(name), files);
  const config = join(home, '.claude.json');
  writeFileSync(config, JSON.stringify({ projects: Object.fromEntries([...Object.keys(projects).map(project), ...listed].map((key) => [key, {}])) }));
  return { root, home, claude, repo, config, project };
}

const childEnv = (fx) => ({ ...CLEAN_ENV, HOME: fx.home, USERPROFILE: fx.home });

/** Runs the script in the fixture (doctor in its HOME, so the current folder adds no project); its exit and stdout lines. */
function run(fx) {
  const result = spawnSync(process.execPath, [SCRIPT, fx.config, fx.claude, fx.repo, fx.home], { env: childEnv(fx), encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr, lines: result.stdout.split('\n').filter(Boolean) };
}

const rowsOf = (out, fx, name) => out.lines.filter((row) => row.includes(`"${fx.project(name)}"`));
const team = (settings) => ({ '.claude/settings.json': settings });

test('disableAllHooks true: WARN that all hooks and the status line are off there', () => {
  const fx = fixture({ projects: { off: team({ disableAllHooks: true }) } });
  const out = run(fx);
  assert.equal(out.status, 0, out.stderr);
  assert.match(rowsOf(out, fx, 'off').join('\n'), /^WARN {2}".*": disableAllHooks "true" turns all hooks and the status line off there/m);
});

test('claudeMdExcludes matching ~/.claude/CLAUDE.md: WARN that it hides our rules', () => {
  const fx = fixture({ projects: { hide: {} } });
  writeFiles(fx.project('hide'), team({ claudeMdExcludes: [join(fx.claude, 'CLAUDE.md').replaceAll('\\', '/')] }));
  const rows = rowsOf(run(fx), fx, 'hide');
  assert.match(rows.join('\n'), /^WARN .*claudeMdExcludes hides our rules there/m);
});

test('a claudeMdExcludes that matches none of ours gives the ok row, not a warning', () => {
  const fx = fixture({ projects: { other: team({ claudeMdExcludes: ['/elsewhere/CLAUDE.md'] }) } });
  assert.deepEqual(rowsOf(run(fx), fx, 'other').map((row) => row.slice(0, 6)), ['ok    ']);
});

test('CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1: WARN, with its allowlisted value', () => {
  const fx = fixture({ projects: { force: team({ env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' } }) } });
  assert.match(rowsOf(run(fx), fx, 'force').join('\n'), /^WARN .*CLAUDE_CODE_SUBAGENT_MODEL_FORCE "1" overrides the model or effort every agent picks/m);
});

test('a weaker model than ours: WARN', () => {
  const fx = fixture({ projects: { weak: team({ model: 'haiku' }) } });
  assert.match(rowsOf(run(fx), fx, 'weak').join('\n'), /^WARN .*model "haiku" is weaker than ours/m);
});

test('DONE_CHECK_SKIP in the committed file: INFO ignored, stricter applies; never a WARN', () => {
  const fx = fixture({ projects: { skip: team({ env: { DONE_CHECK_SKIP: 'types' } }) } });
  const rows = rowsOf(run(fx), fx, 'skip');
  assert.match(rows.join('\n'), /^INFO .*DONE_CHECK_SKIP "types" set by a team file: ignored, stricter applies/m);
  assert.ok(!rows.some((row) => row.startsWith('WARN')), rows.join('\n'));
});

test('DONE_CHECK_SKIP in an untracked settings.local.json is honoured, so it is a WARN', () => {
  const fx = fixture({ projects: { mine: {} } });
  git(dirname(fx.project('mine')), 'init', '-q', fx.project('mine'));
  writeFiles(fx.project('mine'), { '.claude/settings.local.json': { env: { DONE_CHECK_SKIP: 'lint' } } });
  assert.match(rowsOf(run(fx), fx, 'mine').join('\n'), /^WARN .*DONE_CHECK_SKIP "lint" set in your own untracked .claude\/settings.local.json: our check is off there/m);
});

test('CLAUDE_POST_EDIT_TRUST_FORMAT in the committed file: INFO ignored, stricter applies; never a WARN', () => {
  const fx = fixture({ projects: { trust: team({ env: { CLAUDE_POST_EDIT_TRUST_FORMAT: '1' } }) } });
  const rows = rowsOf(run(fx), fx, 'trust');
  assert.match(rows.join('\n'), /^INFO .*CLAUDE_POST_EDIT_TRUST_FORMAT "1" set by a team file: ignored, stricter applies/m);
  assert.ok(!rows.some((row) => row.startsWith('WARN')), rows.join('\n'));
});

test('CLAUDE_POST_EDIT_TRUST_FORMAT in an untracked settings.local.json is honoured where it belongs: INFO naming what runs, never a WARN', () => {
  const fx = fixture({ projects: { mine: {} } });
  git(dirname(fx.project('mine')), 'init', '-q', fx.project('mine'));
  writeFiles(fx.project('mine'), { '.claude/settings.local.json': { env: { CLAUDE_POST_EDIT_TRUST_FORMAT: '1' } } });
  const rows = rowsOf(run(fx), fx, 'mine');
  assert.match(rows.join('\n'), /^INFO .*CLAUDE_POST_EDIT_TRUST_FORMAT "1" set in your own untracked .claude\/settings.local.json: you trust this project, so post-edit runs its own format script there/m);
  assert.ok(!rows.some((row) => row.startsWith('WARN')), rows.join('\n'));
});

test('CLAUDE.local.md importing its project note: INFO now automatic; the file is never edited', () => {
  const fx = fixture({ projects: { alpha: { 'CLAUDE.local.md': '@~/.claude/project-notes/alpha.md\n' } }, notes: { alpha: 'how we combine\n' } });
  const local = join(fx.project('alpha'), 'CLAUDE.local.md');
  const before = statSync(local).mtimeMs;
  const out = run(fx);
  assert.match(rowsOf(out, fx, 'alpha').join('\n'), /^INFO .*CLAUDE\.local\.md" imports "~\/\.claude\/project-notes\/alpha\.md": now automatic; you may delete it/m);
  assert.equal(readFileSync(local, 'utf8'), '@~/.claude/project-notes/alpha.md\n');
  assert.equal(statSync(local).mtimeMs, before);
  assert.ok(!out.lines.some((row) => row.includes('project note ~/.claude/project-notes/alpha.md')), 'a matched note is not listed as unmatched');
});

test('a CLAUDE.local.md import of another key: INFO that it is not this project\'s note (no delete advice)', () => {
  const fx = fixture({ projects: { beta: { 'CLAUDE.local.md': '@~/.claude/project-notes/old-name.md\n' } }, notes: { 'old-name': 'x\n' } });
  const rows = rowsOf(run(fx), fx, 'beta').join('\n');
  assert.match(rows, /^INFO .*imports "~\/\.claude\/project-notes\/old-name\.md", which is not this project's note \(keys: beta\)/m);
  assert.doesNotMatch(rows, /you may delete it/);
});

test('a note with no matching project key: one INFO row naming it', () => {
  const fx = fixture({ projects: { gamma: {} }, notes: { gamma: 'x\n', orphan: 'y\n' } });
  const out = run(fx);
  assert.deepEqual(out.lines.filter((row) => row.includes('project note ')), [
    'INFO  project note ~/.claude/project-notes/orphan.md: no project known on this machine has its key, so it loads in none of them (if it is meant for one, rename it to the key that project\'s session-start note shows)',
  ]);
});

test('an unreadable .claude folder: WARN not checked, never the ok row; exit 0', { skip: noChmod }, (t) => {
  const fx = fixture({ projects: { locked: team({ disableAllHooks: true }) } });
  const claudeDir = join(fx.project('locked'), '.claude');
  chmodSync(claudeDir, 0o000);
  t.after(() => chmodSync(claudeDir, 0o700));
  const out = run(fx);
  assert.equal(out.status, 0, out.stderr);
  const rows = rowsOf(out, fx, 'locked');
  assert.equal(rows.length, 1, rows.join('\n'));
  assert.match(rows[0], /^WARN .*: not checked: ".*\/\.claude" cannot be listed \(EACCES\)/);
});

test('an unreadable .claude/skills folder: WARN rows, exit 0 (one odd project never stops doctor)', { skip: noChmod }, (t) => {
  const fx = fixture({ projects: { skills: { '.claude/skills/one/SKILL.md': 'x' } } });
  const skillsDir = join(fx.project('skills'), '.claude', 'skills');
  chmodSync(skillsDir, 0o000);
  t.after(() => chmodSync(skillsDir, 0o700));
  const out = run(fx);
  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.lines.some((row) => /^WARN {2}".*\/\.claude\/skills": not checked for skills \(it cannot be listed: EACCES\)$/.test(row)), out.lines.join('\n'));
  assert.ok(!rowsOf(out, fx, 'skills').some((row) => row.startsWith('ok')), out.lines.join('\n'));
});

test('an unreadable settings.json: WARN not checked, never the ok row', { skip: noChmod }, (t) => {
  const fx = fixture({ projects: { secret: team({ disableAllHooks: true }) } });
  const file = join(fx.project('secret'), '.claude', 'settings.json');
  chmodSync(file, 0o000);
  t.after(() => chmodSync(file, 0o600));
  const rows = rowsOf(run(fx), fx, 'secret');
  assert.match(rows.join('\n'), /^WARN .*not checked: \.claude\/settings\.json \(unreadable or not JSON\)/m);
  assert.ok(!rows.some((row) => row.startsWith('ok')), rows.join('\n'));
});

test('listed folders that are gone, a Windows path among them: one INFO row with the count, no crash', () => {
  const fx = fixture({ projects: { here: {} }, listed: ['/no/such/folder', 'C:\\Users\\x\\gone-project'] });
  const out = run(fx);
  assert.equal(out.status, 0, out.stderr);
  const gone = out.lines.filter((row) => row.includes('missing (folder gone)'));
  assert.equal(gone.length, 1);
  assert.match(gone[0], /^INFO {2}2 projects the global config lists are missing \(folder gone\): not checked: "\/no\/such\/folder", "C:\\u005cUsers\\u005cx\\u005cgone-project"$/);
});

test('zero known projects: one INFO row saying none', () => {
  const out = run(fixture());
  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.lines.includes('INFO  no known projects: the global config lists no folder that is still there, and doctor runs outside a project'), out.lines.join('\n'));
});

test('a hostile project folder name is quoted, escaped to printable ASCII and capped', { skip: !POSIX && 'needs a newline in a folder name' }, () => {
  const name = `evil"\n\u202e<x>${'y'.repeat(200)}`; // under the 255-byte name limit, longer than the shown cap
  const fx = fixture({ projects: { [name]: team({ disableAllHooks: true }) } });
  const out = run(fx);
  const rows = out.lines.filter((row) => row.includes('disableAllHooks'));
  assert.equal(rows.length, 1, out.lines.join('\n'));
  assert.match(rows[0], /^[\x20-\x7e]+$/);
  assert.match(rows[0], /^WARN {2}"\.\.\.y+": disableAllHooks/);
  assert.ok(rows[0].length < 400, `${rows[0].length} characters`);
});

test('an env value outside the allowlist never reaches the output; its key does', () => {
  const fx = fixture({ projects: { keys: team({ env: { ANTHROPIC_API_KEY: SECRET } }) } });
  const out = run(fx);
  assert.ok(!out.lines.join('\n').includes(SECRET));
  assert.match(rowsOf(out, fx, 'keys').join('\n'), /^INFO .*ANTHROPIC_API_KEY replaces ours there$/m);
});

test('doctor.sh check_projects prints the INFO rows and counts the WARN rows', { skip: noJq }, () => {
  const fx = fixture({ projects: { skip: team({ env: { DONE_CHECK_SKIP: 'types' } }), off: team({ disableAllHooks: true }) } });
  const result = spawnSync('bash', [DOCTOR], { env: { ...childEnv(fx), DOCTOR_ONLY: 'check_projects', DOCTOR_PROJECT: fx.home }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^INFO {2}".*\/skip": DONE_CHECK_SKIP "types" set by a team file: ignored, stricter applies/m);
  assert.match(result.stdout, /^WARN {2}".*\/off": disableAllHooks "true" turns all hooks/m);
});
