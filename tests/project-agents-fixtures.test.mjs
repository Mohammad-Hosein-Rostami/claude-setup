// One table for every fixture of the review rounds of the project-agents note (p0-0.1 security reviews 1 and 2, review 2, and this
// round's CLI probe): each row builds one project and names the class the note must put it in.
// The classes (design of fix round 2): the note is exact where it can be ("exact shadow", "exact maxTurns"), says "check by hand"
// or "not read" for everything else Claude Code could load ("not plain", "check by hand", "link not read", "not checked"), and is
// "silent" only for a file Claude Code itself does not load. A row passes when the whole note is the expected text and the note
// keeps what its classes promise: no delete advice without an exact maxTurns, no "Shadowed" sentence without an exact name.
// The rows are in tests/project-agents-frontmatter-rows.mjs (the form of a frontmatter) and tests/project-agents-place-rows.mjs
// (where a file stands and what it is). The noise check at the end is the other side: ordinary agent files give no note at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectAgentNote } from '../home/hooks/lib/project-agents.mjs';
import { FRONTMATTER_ROWS } from './project-agents-frontmatter-rows.mjs';
import { DISK_IGNORES_CASE, POSIX, noteOf, sandbox } from './project-agents-helpers.mjs';
import { PLACE_ROWS } from './project-agents-place-rows.mjs';

const REAL_PERSONAL_AGENTS_DIR = fileURLToPath(new URL('../home/agents', import.meta.url));
const PERSONAL = { 'security-auditor': '', reviewer: '' };
const DELETE_ADVICE = /no need to ask/;
const SHADOWED_SENTENCE = /Shadowed (?:personal|built-in) agents: /;
const BY_HAND_COUNT = /\d+ agent files to check by hand: tell the owner/;
const EXACT_CLASSES = ['exact shadow', 'exact maxTurns'];
// What a note of each class must hold. A class that is not exact must also hold neither exact claim (checked for every row below).
const CLASS_MARKS = {
  'exact shadow': [SHADOWED_SENTENCE, /\(.*shadows the (?:personal|built-in) agent\)/],
  'exact maxTurns': [DELETE_ADVICE, /\(maxTurns (?:\d{1,6}|set)[,)]/],
  'not plain': [BY_HAND_COUNT, /\(frontmatter not plain: check by hand\)/],
  'check by hand': [BY_HAND_COUNT, /: check by hand\)/],
  'link not read': [/tell the owner about each link/, /\((?:a link|a hard link|a linked folder|a link to outside): not read/],
  'not checked': [/(?:not checked|not read|to check by hand): tell the owner/],
  silent: [/^$/],
};

/** Builds the project of one row and returns the note of its session. */
async function noteForRow(row) {
  const box = await sandbox({ personal: PERSONAL });
  for (const [path, text] of Object.entries(row.files ?? {})) {
    await mkdir(dirname(join(box.agentsDir, path)), { recursive: true });
    await writeFile(join(box.agentsDir, path), text);
  }
  const built = await row.build?.(box);
  return projectAgentNote(built?.cwd ?? box.projectDir, built?.personalDir ?? box.personalDir);
}

test('every fixture of the review rounds lands in its class, with the exact note', async (t) => {
  const rows = [...FRONTMATTER_ROWS, ...PLACE_ROWS];
  assert.ok(Object.keys(CLASS_MARKS).every((name) => rows.some((row) => row.classes.includes(name))), 'every class has a row');
  for (const row of rows) {
    const skip = (row.posix && !POSIX && 'needs links or names Windows lacks') || (row.ignoresCase && !DISK_IGNORES_CASE && 'this disk is case-sensitive: a folder has no second spelling here');
    await t.test(`${row.classes.join(' + ')}: ${row.what} (${row.id})`, { skip }, async () => {
      const note = await noteForRow(row);
      assert.equal(note, row.note === '' ? '' : noteOf(row.note), 'the whole note');
      for (const name of row.classes) for (const mark of CLASS_MARKS[name]) assert.match(note, mark, `class ${name}`);
      if (!row.classes.includes('exact maxTurns')) assert.doesNotMatch(note, DELETE_ADVICE, 'no delete advice without an exact maxTurns key line');
      if (!row.classes.includes('exact shadow')) assert.doesNotMatch(note, SHADOWED_SENTENCE, 'no shadow stated without an exact name');
      if (!row.classes.some((name) => EXACT_CLASSES.includes(name))) assert.doesNotMatch(note, /\(maxTurns \d+\)|shadows the/, 'no exact item');
    });
  }
});

// Ten typical agent files, written by hand in the styles real projects use. None caps turns or carries one of the owner's agent names
// as its own, but their descriptions mention those names and maxTurns, which the earlier token match reported as facts (review 2, R3).
const TYPICAL_AGENTS = {
  'code-reviewer.md': '---\nname: code-reviewer\ndescription: Expert code reviewer. Use after the implementer; hands findings to the reviewer or the runner.\ntools: Read, Grep, Glob, Bash\nmodel: sonnet\n---\nYou review code.\n',
  'test-runner.md': '---\nname: test-runner\ndescription: "Runs the project test runner and reports failures only.\\n\\n<example>user: run the tests\\nassistant: I use the test-runner agent</example>"\ntools:\n  - Bash\n  - Read\n---\nRun tests.\n',
  'planner.md': '---\nname: planner\ndescription: |\n  Senior software architect for plans.\n  name: architect is another agent; maxTurns: 5 is not set here.\nmodel: opus\ncolor: blue\n---\nPlan.\n',
  'docs-writer.md': "---\nname: docs-writer\ndescription: 'Writes docs; it''s careful with names like scout: and Explore.'\ntools: [Read, Write, Edit]\n---\nWrite docs.\n",
  'db-migrator.md': '---\n# database work only\nname: db-migrator\ndescription: >-\n  Writes and checks migrations.\n  Never caps itself: no maxTurns.\ntools:\n- Read\n- Bash\npermissionMode: default\n---\nMigrate.\n',
  'api designer.md': '---\nname: api-designer\ndescription: Designs HTTP APIs (REST, gRPC) - asks the security-auditor for a second look. # not a comment for YAML rules here\nmodel: inherit\n---\nDesign.\n',
  'release-helper.md': '---\r\nname: release-helper\r\ndescription: Prepares a release.\r\ntools: Bash, Read\r\n---\r\nRelease.\r\n',
  'i18n.md': '---\nname: i18n-checker\ndescription: "Checks translations (\\u0641\\u0627\\u0631\\u0633\\u06cc, Deutsch) and RTL layout."\nskills:\n  - responsive-ui\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: "echo name: reviewer"\n---\nCheck.\n',
  'notes.md': '# Team notes\n\nNot an agent: no frontmatter. The reviewer agent has maxTurns: 5 in another repo.\n',
  'perf.md': '---\n  name: perf-profiler\n  description: Profiles slow pages; reports like the runner does.\n  background: true\n---\nProfile.\n',
};

test('noise check: ordinary agent files give no note: the setup\'s own agents under other owners, and ten typical files', async () => {
  // The repository's own agent files, in a project of an owner whose personal agents have other names.
  const own = await sandbox({ personal: { helper: '' } });
  await cp(REAL_PERSONAL_AGENTS_DIR, own.agentsDir, { recursive: true });
  assert.ok(readdirSync(own.agentsDir).filter((file) => file.endsWith('.md')).length >= 10, 'the real agent files were copied');
  assert.equal(projectAgentNote(own.projectDir, own.personalDir), '');
  // Typical files beside the real personal set: every personal name is mentioned in a description, none is an agent's own name.
  const typical = await sandbox();
  for (const [file, text] of Object.entries(TYPICAL_AGENTS)) await writeFile(join(typical.agentsDir, file), text);
  assert.equal(projectAgentNote(typical.projectDir, REAL_PERSONAL_AGENTS_DIR), '');
});
