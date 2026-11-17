// Static checks for the four workflow scripts and skills of lane W2 (bugfix, research, sync-machines, git-cleanup).
// Exports: none (node:test file).
// Invariants: each script starts with a pure-literal `meta`, calls `checkArgs(args)` as the next statement, uses only
// phase titles listed in meta, never calls `import(`, and has a `wf-*` skill whose text names its script path and the
// inline-script fallback; each agent label starts with the row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readScript } from './workflow-more-helpers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const SCRIPTS = { bugfix: 'wf-bugfix', research: 'wf-research', 'sync-machines': 'wf-sync', 'git-cleanup': 'wf-git-cleanup' };

for (const [script, skill] of Object.entries(SCRIPTS)) {
  test(`${script}.js: meta first, checkArgs next, phases listed, no import()`, () => {
    const text = readScript(script);
    const code = text.replace(/^\/\/.*$/gm, '').trimStart();
    assert.match(code, /^export const meta = \{/, 'meta is the first statement');
    const afterMeta = code.slice(code.indexOf('\n}\n') + 3).trimStart();
    assert.match(afterMeta, /^checkArgs\(args\)/, 'checkArgs(args) follows meta');
    const listed = [...text.matchAll(/\{ title: '([^']+)'/g)].map((m) => m[1]);
    const used = [...text.matchAll(/phase: '([^']+)'|phase\('([^']+)'\)|, '(Verify|Sync|Doctor|Review|Land|Apply|Plan)'/g)].map((m) => m[1] ?? m[2] ?? m[3]);
    for (const title of used) assert.ok(listed.includes(title), `phase ${title} is not in meta.phases`);
    assert.doesNotMatch(text, /\bimport\(|Date\.now|Math\.random|new Date\(\)/);
    assert.ok(text.split('\n').length <= 300, 'C4: at most 300 lines');
  });

  test(`${skill}: names ${script}.js through CLAUDE_SKILL_DIR and the inline fallback`, () => {
    const text = readFileSync(`${root}home/skills/${skill}/SKILL.md`, 'utf8');
    assert.match(text, /^name: wf-[a-z-]+$/m);
    assert.ok(text.includes(`\${CLAUDE_SKILL_DIR}/../../workflows/${script}.js`), 'script path');
    assert.match(text, /pass its text as `script`/);
    assert.match(text, /^argument-hint: /m);
  });
}
