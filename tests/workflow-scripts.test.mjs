// Generic checks for every script in home/workflows (spec round 4, section 4 "Script rules" and lane W1 step 2): meta literal first, phase titles
// that match, `checkArgs(args)` as the statement after meta with its named error before any agent starts, no dynamic import(), a wf-* skill that
// names the script. The per-script behaviour is tested in workflow-review.test.mjs, workflow-land.test.mjs, workflow-build.test.mjs and
// workflow-step.test.mjs; the sandbox that runs them is workflow-sandbox.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMeta, runScript, scriptFiles } from './workflow-sandbox.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = join(REPO, 'home', 'skills');
const PROBE = /^probe/;
const LIVE_SCRIPTS = ['review', 'land', 'build', 'step'];
// The required keys of each script and the wrong value that must be refused (spec section 9, "Workflow args"). A script of another lane
// adds its own row here when it lands. (`depth` of research also has to be one of simple, compare, complex: tested in workflow-research.test.mjs.)
const REQUIRED_ARGS = {
  review: { row: 'string', repo: 'string', base: 'string', range: 'string', landing: 'boolean', fix: 'boolean', branch: 'string', worktree: 'string', suite: 'string' },
  land: { row: 'string', closeRow: 'string', statusFile: 'string', repo: 'string', base: 'string', branch: 'string', worktree: 'string', suite: 'string', tip: 'string' },
  build: { base: 'string', repo: 'string', suite: 'string', writers: 'number', statusFile: 'string', scriptsDir: 'string', lanes: 'array' },
  step: { row: 'string', agentType: 'string', prompt: 'string', model: 'string', effort: 'string' },
  bugfix: { repo: 'string', symptom: 'string', scriptsDir: 'string' },
  implement: { role: 'string', row: 'string', branch: 'string', base: 'string', spec: 'string', files: 'array', statusFile: 'string', acceptanceTests: 'boolean', model: 'string', effort: 'string' },
  join: { row: 'string', closeRow: 'string', branch: 'string', base: 'string', statusFile: 'string', files: 'array', worktree: 'string', sha: 'string' },
  'visual-qa': { row: 'string', repo: 'string', worktree: 'string', tip: 'string', base: 'string' },
  research: { row: 'string', question: 'string', out: 'string', depth: 'string' },
  'sync-machines': { row: 'string', repo: 'string', base: 'string' },
  'git-cleanup': { row: 'string', repos: 'array' },
};
const WRONG = { string: 42, boolean: 'yes', number: 'two', array: 'not-a-list' };
const GOOD = { string: 'x', boolean: true, number: 2, array: [] };
const goodArgs = (name) => Object.fromEntries(Object.entries(REQUIRED_ARGS[name]).map(([key, type]) => [key, GOOD[type]]));
const scripts = scriptFiles().filter((path) => !PROBE.test(basename(path)));

test('the four W1 scripts exist', () => {
  for (const name of LIVE_SCRIPTS) assert.ok(scripts.some((path) => basename(path) === `${name}.js`), `home/workflows/${name}.js`);
});

for (const path of scripts) {
  const file = basename(path, '.js');
  const source = readFileSync(path, 'utf8');

  test(`${file}.js: meta is a pure literal, the first statement, and names the file`, () => {
    const withoutComments = source.replace(/^(\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/))*\s*/, '');
    assert.match(withoutComments, /^export const meta = \{/, 'first statement');
    const { meta } = readMeta(source);
    assert.equal(meta.name, file);
    assert.ok(meta.description && meta.description.length > 10, 'description');
    assert.ok(Array.isArray(meta.phases) && meta.phases.length > 0, 'phases');
  });

  // (build.js lists the phases of its child workflows too, so a meta phase need not be used by the script itself)
  test(`${file}.js: phase titles in phase() and opts.phase are all in meta.phases`, () => {
    const titles = readMeta(source).meta.phases.map((phase) => phase.title);
    const used = [...source.matchAll(/\bphase\(\s*'([^']+)'/g), ...source.matchAll(/\bphase:\s*'([^']+)'/g)].map((found) => found[1]);
    assert.ok(used.length > 0, 'the script uses phases');
    for (const title of used) assert.ok(titles.includes(title), `phase "${title}" is not in meta.phases`);
  });

  test(`${file}.js: the statement after meta is checkArgs(args), and there is no dynamic import()`, () => {
    assert.match(readMeta(source).rest, /^\s*;?\s*checkArgs\(args\)/);
    assert.doesNotMatch(source, /\bimport\s*\(/);
    assert.doesNotMatch(source, /\b(require|process|fs)\b\s*[.(]/);
  });

  test(`${file}.js: a missing or wrong-typed required arg throws its named error before any agent starts`, async () => {
    const required = REQUIRED_ARGS[file];
    assert.ok(required, `REQUIRED_ARGS has a row for ${file}`);
    const none = await runScript(path, undefined);
    assert.match(String(none.error), new RegExp(`^Error: ${file}: args\\.${Object.keys(required)[0]} must be `));
    for (const [key, type] of Object.entries(required)) {
      const missing = goodArgs(file);
      delete missing[key];
      const wrong = { ...goodArgs(file), [key]: WRONG[type] };
      for (const bad of [missing, wrong]) {
        const run = await runScript(path, bad);
        assert.equal(run.error?.message, `${file}: args.${key} must be ${type === 'array' ? 'an array' : `a ${type}`}`);
        assert.equal(run.calls.length, 0, `${key}: no agent before the args check`);
      }
    }
  });

  test(`${file}.js: a wf-* skill names the script and the scripts folder`, () => {
    const skills = readdirSync(SKILLS).filter((name) => name.startsWith('wf-') && existsSync(join(SKILLS, name, 'SKILL.md')));
    const naming = skills.filter((name) => readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8').includes(`workflows/${file}.js`));
    assert.equal(naming.length, 1, `exactly one skill calls Workflow with workflows/${file}.js (found: ${naming.join(', ') || 'none'})`);
    const text = readFileSync(join(SKILLS, naming[0], 'SKILL.md'), 'utf8');
    assert.match(text, /\$\{CLAUDE_SKILL_DIR\}\/\.\.\/\.\.\/workflows\//);
    assert.match(text, /scriptsDir/);
    // build runs the child workflows review and land, which an inline script cannot run: its skill says so instead of offering the fallback
    // build's own children (implement, join, visual-qa) are named by the wf-build skill, which offers no inline fallback either
    if (['build', 'implement', 'join', 'visual-qa'].includes(file)) assert.match(text, /no inline fallback/);
    else assert.match(text, /script`? ?(input|parameter)|as `script`/i, 'keeps the inline-script sentence (F2)');
  });
}
