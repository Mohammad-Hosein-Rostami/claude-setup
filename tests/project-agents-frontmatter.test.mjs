// How the project-agents note reads a frontmatter (home/hooks/lib/agent-frontmatter.mjs): found by Claude Code's own rules (security
// review p0-0.1, S3: the CLI 2.1.328 drops a leading BOM, accepts any whitespace after the opening --- and ends the frontmatter at the
// first --- after it), then read exactly when it is in the plain subset and called "not plain" otherwise (fix round 2: the tolerant
// match over the whole text reported words in a description as facts and missed spellings that YAML decodes).
// The forms of whole agent files, with the note each must give, are rows of tests/project-agents-fixtures.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { frontmatterOf, plainFrontmatter } from '../home/hooks/lib/agent-frontmatter.mjs';
import { projectAgentNote } from '../home/hooks/lib/project-agents.mjs';
import { sandbox } from './project-agents-helpers.mjs';

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const NOT_PLAIN = { plain: false };
const plain = (name, turns = '') => ({ plain: true, name, turns });

test('text after the first closing --- is not frontmatter, and a longer token is not the personal name or the key', async () => {
  const { projectDir, personalDir, agentsDir } = await sandbox({ personal: { 'security-auditor': '' } });
  await writeFile(join(agentsDir, 'body.md'), `---\nname: body\ndescription: x\n---\nname: security-auditor\nmaxTurns: 5\n`);
  await writeFile(join(agentsDir, 'longer.md'), '---\nname: my-security-auditor-2\ndescription: security-auditor_old\nmaxTurnsNote: 5\nxmaxTurns: 5\n---\n');
  assert.equal(projectAgentNote(projectDir, personalDir), '');
});

test('frontmatterOf follows the CLI: BOM dropped, whitespace after the opening, ends at the first ---', () => {
  assert.deepEqual(frontmatterOf('---\na: 1\n---\nbody'), { kind: 'closed', text: 'a: 1\n' });
  assert.deepEqual(frontmatterOf(`${BYTE_ORDER_MARK}--- \t\r\n\na: 1---\nb: 2\n---\n`), { kind: 'closed', text: 'a: 1' });
  assert.deepEqual(frontmatterOf('---\n\n  a: 1\n  b: 2\n---\n'), { kind: 'closed', text: '  a: 1\n  b: 2\n' }, 'the indent of the first line belongs to the frontmatter');
  assert.deepEqual(frontmatterOf('---\n---\n'), { kind: 'closed', text: '' });
  assert.equal(frontmatterOf('a: 1\n---\n').kind, 'none', 'no opening --- at the very start');
  assert.equal(frontmatterOf('--- a: 1\n---\n').kind, 'none', 'the opening --- needs a line end after it');
  assert.equal(frontmatterOf('----\na: 1\n---\n').kind, 'none');
  assert.equal(frontmatterOf('---').kind, 'none');
  assert.equal(frontmatterOf('').kind, 'none');
  assert.deepEqual(frontmatterOf('---\nname: big\nmaxTurns: 9\n'), { kind: 'open', text: '' }, 'no --- after the opening: nothing is taken as frontmatter');
  assert.equal(frontmatterOf('---\nname: big\n--').kind, 'open', 'two dashes are no closing');
});

test('plainFrontmatter: the name and the maxTurns of plain key lines, exactly', () => {
  assert.deepEqual(plainFrontmatter('name: runner\ndescription: x\n'), plain('runner'));
  assert.deepEqual(plainFrontmatter('name: runner\nmaxTurns: 60\n'), plain('runner', 'maxTurns 60'));
  assert.deepEqual(plainFrontmatter('maxTurns: 999999'), plain('', 'maxTurns 999999'));
  assert.deepEqual(plainFrontmatter('maxTurns: 1000000\n'), plain('', 'maxTurns set'));
  assert.deepEqual(plainFrontmatter('maxTurns: 60;Owner-note\n'), plain('', 'maxTurns set'));
  assert.deepEqual(plainFrontmatter('maxTurns: -1\n'), plain('', 'maxTurns set'));
  assert.deepEqual(plainFrontmatter('maxTurns:\n'), plain('', 'maxTurns set'));
  assert.deepEqual(plainFrontmatter('maxTurns: "8" # a cap\n'), plain('', 'maxTurns 8'));
  assert.deepEqual(plainFrontmatter('maxTurns: 8#x\n'), plain('', 'maxTurns set'), 'a # without a space before it starts no comment');
  assert.deepEqual(plainFrontmatter('name: \t runner \t\n'), plain('runner'), 'spaces and tabs around a value are dropped');
  assert.deepEqual(plainFrontmatter(''), plain(''));
  assert.deepEqual(plainFrontmatter('# only a comment\n\n'), plain(''));
  assert.deepEqual(plainFrontmatter('name:\ndescription: x'), plain(''), 'a name key without a value: no name');
  assert.deepEqual(plainFrontmatter('name: # nothing\ndescription: x'), plain(''));
  assert.deepEqual(plainFrontmatter('name: ""\n'), plain(''));
  assert.deepEqual(plainFrontmatter('name: "my agent 2.0"\n'), plain('my agent 2.0'));
  assert.deepEqual(plainFrontmatter("name: 'runner '\n"), plain('runner '), 'spaces inside the quotes belong to the name');
  assert.deepEqual(plainFrontmatter('name: my agent\n'), plain('my agent'));
  assert.deepEqual(plainFrontmatter('  name: runner\n  maxTurns: 5\n'), plain('runner', 'maxTurns 5'), 'a mapping indented as a whole');
  assert.deepEqual(plainFrontmatter('name: runner\r\nmaxTurns: 5\r\n'), plain('runner', 'maxTurns 5'));
  assert.deepEqual(plainFrontmatter('name: runner\rmaxTurns: 5'), plain('runner', 'maxTurns 5'), 'a lone CR ends a line');
});

test('plainFrontmatter: what belongs to another key is not read', () => {
  assert.deepEqual(plainFrontmatter('description: |\n  name: reviewer\n  maxTurns: 5\nname: runner\n'), plain('runner'));
  assert.deepEqual(plainFrontmatter('description: never use maxTurns: 5 here, says the reviewer\nname: runner\n'), plain('runner'));
  assert.deepEqual(plainFrontmatter('description: "name: reviewer \\" maxTurns: 5" # c\nname: runner\n'), plain('runner'));
  assert.deepEqual(plainFrontmatter("description: 'it''s the reviewer'\nname: runner\n"), plain('runner'));
  assert.deepEqual(plainFrontmatter('tools:\n- Read\n- name: reviewer\n  maxTurns: 5\nname: runner\n'), plain('runner'), 'a list at the indent of its key');
  assert.deepEqual(plainFrontmatter('tools: # the usual ones\n- Read\nname: runner\n'), plain('runner'));
  assert.deepEqual(plainFrontmatter('hooks:\n  PreToolUse:\n    - maxTurns: 5\nname: runner\n'), plain('runner'));
  assert.deepEqual(plainFrontmatter('name: runner\n  # a comment below the name\nmaxTurnsNote: 5\nxmaxTurns: 5\nnamed: reviewer\n'), plain('runner'));
});

test('plainFrontmatter: anything YAML could read another way is not plain', () => {
  const notPlain = [
    '"name": runner', "'maxTurns': 5", 'name : runner', 'name:runner', 'name:\trunner', '{name: runner}', '[a, b]', '? name\n: runner', '*k : 5',
    '<<: *base', '- name: runner', 'description: x\n- name: runner', '\tname: runner', '  \tname: runner', '  name: runner\nmaxTurns: 5', 'a: 1\n b: 2\nname: x\n  y',
    'name: runner\n  two', 'name:\n  runner', 'name: >-\n  runner', 'name:\n- runner', 'maxTurns: 5\n  6', 'maxTurns:\n  5', 'name: a\nname: b', 'maxTurns: 1\nmaxTurns: 2',
    'Name: runner', 'NAME: runner', 'na_me: runner', 'max_turns: 5', 'max-turns: 5', 'MaxTurns: 5', 'maxturns: 5', 'name: runner # c', 'name: "run\\u006eer"', 'name: "runner" x',
    "name: 'run''ner'", 'name: "runner', 'name: &a runner', 'name: *a', 'name: !!str runner', 'name: |', 'name: [runner]', 'name: run:ner', 'name: runner:', 'name: -runner',
    'name: r\u00fcnner', 'name: "r\u00fcnner"', 'description: "open\nname: runner"', "description: 'open\nname: runner", 'description: "x" y\nname: runner',
    'description: x\u0000\nname: runner', 'description: x\u000cname: runner', `description: x${String.fromCharCode(0x85)}name: runner`, `description: x${String.fromCharCode(0x2029)}name: runner`,
    'plain text', 'key', '%YAML 1.2', '...', 'n\u00e4me: runner', '9name: runner',
    `name: ${String.fromCharCode(0xa0)}runner`, `name: runner${String.fromCharCode(0x3000)}`, `name: ${String.fromCharCode(0xfeff)}runner`, // blanks YAML keeps (round 3, R3-3)
  ];
  for (const text of notPlain) assert.deepEqual(plainFrontmatter(text), NOT_PLAIN, JSON.stringify(text));
});

test('a head full of one repeated piece is read without an error (the SessionStart hook has 5 s in all)', () => {
  const HOSTILE_CHARS = 8 * 1024; // the head the hook reads
  const texts = ['\n', ' ', '\r', '#', 'a: "\\', "a: '", 'a:\n-', '- '].map((piece) => piece.repeat(HOSTILE_CHARS / piece.length));
  for (const text of texts) assert.equal(typeof plainFrontmatter(text).plain, 'boolean');
  for (const text of texts) assert.ok(['none', 'open', 'closed'].includes(frontmatterOf(`---\n${text}`).kind));
});
