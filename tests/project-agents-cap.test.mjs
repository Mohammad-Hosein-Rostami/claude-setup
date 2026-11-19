// What the project-agents note keeps when its cap (NOTE_MAX_CHARS) or the read limit (MAX_AGENT_FILES) bites.
// Security review p0-0.1, S1: the cap kept the leading items in file-name order, which the repository chooses, so two long capped
// names hid the one file that shadowed a personal agent. Now the shadowed personal agents are named first, from the personal set
// (trusted and small), and are never cut; the files that shadow them are listed before the files that only set maxTurns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_AGENT_FILES, NOTE_MAX_CHARS, projectAgentNote } from '../home/hooks/lib/project-agents.mjs';
import { BOTH_ADVICE, agent, noteOf, sandbox } from './project-agents-helpers.mjs';

const REAL_PERSONAL_AGENTS_DIR = fileURLToPath(new URL('../home/agents', import.meta.url));
const LONG_NAME_CHARS = 80; // more than the note shows of a name
const ESCAPED_CHAR = 'Ø'; // outside printable ASCII, so the note shows it as the six characters Ø; valid in a Windows name too
const ESCAPES_SHOWN = 63; // the 64 characters shown of a name, less its one index digit
const longCappedName = (index) => `${index}${ESCAPED_CHAR.repeat(LONG_NAME_CHARS)}.md`;
const longCappedItem = (index) => `"${index}${'\\u00d8'.repeat(ESCAPES_SHOWN)}..." (maxTurns 1)`;
const indexed = (i) => `a${String(i).padStart(4, '0')}.md`;

test('two long capped names that sort first do not hide the file that shadows a personal agent', async () => {
  const { projectDir, personalDir, agentsDir } = await sandbox({ personal: { 'security-auditor': '' } });
  for (const index of [0, 1]) await writeFile(join(agentsDir, longCappedName(index)), agent('x', 'maxTurns: 1\n'));
  await writeFile(join(agentsDir, 'helper.md'), agent('security-auditor'));
  const note = projectAgentNote(projectDir, personalDir);
  const items = ['helper.md (shadows the personal agent)', longCappedItem(0)];
  assert.equal(note, noteOf({ advice: BOTH_ADVICE, shadowed: ['security-auditor'], items, more: 1 }));
  assert.ok(note.length <= NOTE_MAX_CHARS, `note is ${note.length} chars`);
});

test('a shadowing file behind many capped files is listed first, and every shadowed personal agent is named', async () => {
  const { projectDir, personalDir, agentsDir } = await sandbox({ personal: { runner: '', reviewer: '', scout: '' } });
  for (let i = 0; i < MAX_AGENT_FILES - 2; i += 1) await writeFile(join(agentsDir, indexed(i)), agent(`a${i}`, 'maxTurns: 3\n'));
  await writeFile(join(agentsDir, 'y-helper.md'), agent('scout'));
  await writeFile(join(agentsDir, 'z-helper.md'), agent('reviewer', 'maxTurns: 9\n'));
  const note = projectAgentNote(projectDir, personalDir);
  const start = noteOf({ advice: BOTH_ADVICE, shadowed: ['reviewer', 'scout'], items: ['y-helper.md (shadows the personal agent)', 'z-helper.md (maxTurns 9, shadows the personal agent)', `${indexed(0)} (maxTurns 3)`] });
  assert.ok(note.startsWith(start.slice(0, -1)), note);
  assert.ok(note.length <= NOTE_MAX_CHARS, `note is ${note.length} chars`);
});

// Fails the day the personal set outgrows the cap: the shadowed names are never cut, so they must fit together with all the advice.
test('with the real personal agents all shadowed, their names and the advice fit NOTE_MAX_CHARS', async () => {
  const personal = readdirSync(REAL_PERSONAL_AGENTS_DIR).filter((file) => file.endsWith('.md')).map((file) => file.slice(0, -'.md'.length)).sort();
  assert.ok(personal.length >= 10, `the real set has ${personal.length} agents`);
  const { projectDir, agentsDir } = await sandbox();
  // One worst file: the longest escaped name, the longest maxTurns number, and a frontmatter that names every personal agent.
  await writeFile(join(agentsDir, `${ESCAPED_CHAR.repeat(LONG_NAME_CHARS)}.md`), agent('x', `maxTurns: 999999\ntools: ${personal.join(', ')}\n`));
  const note = projectAgentNote(projectDir, REAL_PERSONAL_AGENTS_DIR);
  assert.ok(note.length <= NOTE_MAX_CHARS, `note is ${note.length} chars, cap ${NOTE_MAX_CHARS}`);
  assert.equal(note, noteOf({ advice: BOTH_ADVICE, shadowed: personal, more: 1 }), 'no room for the worst item: it is counted, the names stay');
  // The usual copy of the personal set: every file is named like its agent.
  const copied = await sandbox();
  for (const name of personal) await writeFile(join(copied.agentsDir, `${name}.md`), agent(name, 'maxTurns: 60\n'));
  const copiedNote = projectAgentNote(copied.projectDir, REAL_PERSONAL_AGENTS_DIR);
  assert.ok(copiedNote.length <= NOTE_MAX_CHARS, `note is ${copiedNote.length} chars`);
  assert.ok(copiedNote.startsWith(`${noteOf({ advice: BOTH_ADVICE, shadowed: personal }).slice(0, -1)}. Files: ${personal[0]}.md (maxTurns 60, shadows the personal agent), `), copiedNote);
});
