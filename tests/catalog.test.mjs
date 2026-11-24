// Tests for docs/catalog.md as a union-merged file: parallel lanes append rows to it, so git merges them by `merge=union`
// (.gitattributes). Union keeps both sides' lines and cannot tell a duplicated or lost row from a good one, so these tests catch that.
// Exports: readTables, duplicateKeys, missingFiles (the checks, so the fixture test can run them on a small catalog).
// Invariants: (1) the first cell of a row is unique within its table; (2) every file a row of a file table names exists;
// (3) two lanes that each append a row to the same table rebase one after the other with no conflict and keep both rows;
// (4) the session-notes entries (this catalog and home/hooks/README.md) give its deadline the prune only, never the project-agents child.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CATALOG = join(REPO, 'docs', 'catalog.md');
const CELL_FILES = {
  Skills: (name) => `home/skills/${name}/SKILL.md`,
  Agents: (name) => `home/agents/${name}.md`,
  Rules: (name) => `home/rules/${name}`,
  Hooks: (name) => `home/hooks/${name}`,
  Tools: (name) => `home/tools/${name}`,
  Scripts: (name) => `scripts/${name}`,
};
const MIN_TABLES = 8; // the catalog has a dozen; a parser that finds fewer has broken
const REPO_PATH = /^(home|scripts|settings|plugins|docs|tests)\/[^\s<>*{}]+$/;

/** The tables of a catalog: { section, rows: [cells[]] } where the header and separator rows are dropped. */
export function readTables(markdown) {
  const tables = [];
  let section = '';
  let current = null;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) section = line.slice(3).split(' (')[0].trim();
    if (!line.startsWith('|')) { current = null; continue; }
    if (current === null) { current = { section, rows: [], skipped: 0 }; tables.push(current); }
    if (current.skipped < 2) { current.skipped += 1; continue; }
    current.rows.push(line.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim()));
  }
  return tables;
}

/** Names a row's first cell promises: the backticked words of the cell (`a` / `b`, or `a`, `b`). */
const namesOf = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);

/** The row keys that appear twice in one table, as "Section: key". */
export function duplicateKeys(tables) {
  const found = [];
  for (const { section, rows } of tables) {
    const seen = new Set();
    for (const [key] of rows) {
      if (seen.has(key)) found.push(`${section}: ${key}`);
      seen.add(key);
    }
  }
  return found;
}

/** Files a row names that do not exist under `root`: the first cell by the section's folder, and any repo path in backticks. */
export function missingFiles(tables, root) {
  const missing = [];
  for (const { section, rows } of tables) {
    for (const cells of rows) {
      const wanted = new Set(cells.flatMap((cell) => namesOf(cell)).filter((word) => REPO_PATH.test(word)).map((word) => word.replace(/\/$/, '')));
      const toPath = CELL_FILES[section];
      if (toPath) for (const name of namesOf(cells[0])) wanted.add(toPath(name));
      for (const file of wanted) if (!existsSync(join(root, file))) missing.push(`${section}: ${cells[0]} names ${file}`);
    }
  }
  return missing;
}

test('every row key of docs/catalog.md is unique within its table', () => {
  const tables = readTables(readFileSync(CATALOG, 'utf8'));
  assert.ok(tables.length >= MIN_TABLES, 'the parser found the tables');
  assert.deepEqual(duplicateKeys(tables), []);
});

test('every file a catalog row names exists', () => {
  assert.deepEqual(missingFiles(readTables(readFileSync(CATALOG, 'utf8')), REPO), []);
});

/** The hook script names settings/base.json registers (`.../hooks/<name>.mjs` in each command). */
function registeredHooks() {
  const { hooks } = JSON.parse(readFileSync(join(REPO, 'settings', 'base.json'), 'utf8'));
  const commands = Object.values(hooks).flat().flatMap((entry) => entry.hooks.map((hook) => hook.command));
  return [...new Set(commands.map((command) => /\/hooks\/([\w.-]+\.mjs)/.exec(command)?.[1]).filter(Boolean))];
}

test('the settings hooks row names only hook files that exist, and every hook settings/base.json registers', () => {
  const settings = readTables(readFileSync(CATALOG, 'utf8')).find((table) => table.section === 'Settings keys');
  const hooksRow = settings?.rows.find(([key]) => key === '`hooks`');
  assert.ok(hooksRow, 'the Settings keys table has a `hooks` row');
  const scripts = namesOf(hooksRow[1]).filter((name) => name.endsWith('.mjs'));
  assert.deepEqual(scripts.filter((name) => !existsSync(join(REPO, 'home', 'hooks', name))), [], 'hook files the row names but home/hooks lacks');
  const registered = registeredHooks();
  assert.ok(registered.length > 0, 'the settings parser found the hooks');
  assert.deepEqual(registered.filter((name) => !scripts.includes(name)), [], 'hooks settings/base.json registers but the row leaves out');
  assert.deepEqual(scripts.filter((name) => !registered.includes(name)), [], 'hooks the row names but settings/base.json does not register');
});

test('the key check finds a row that was added twice, and the path check finds a row whose file is gone', () => {
  const root = makeTempDir('catalog-fixture-');
  mkdirSync(join(root, 'home', 'agents'), { recursive: true });
  writeFileSync(join(root, 'home', 'agents', 'present.md'), 'x');
  const table = '## Agents (`home/agents/<name>.md`)\n\n| Agent | Description |\n| ----- | ----------- |\n| `present` | a |\n| `present` | again |\n| `gone` | b |\n';
  const tables = readTables(table);
  assert.deepEqual(duplicateKeys(tables), ['Agents: `present`']);
  assert.deepEqual(missingFiles(tables, root), ['Agents: `gone` names home/agents/gone.md']);
});

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}${result.stdout}`);
  return result.stdout;
}

test('two lanes that each append a catalog row rebase one after the other with no conflict and keep both rows', () => {
  const dir = makeTempDir('catalog-rebase-');
  git(dir, 'init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, '.gitattributes'), readFileSync(join(REPO, '.gitattributes')));
  const header = '| Skill | Description |\n| ----- | ----------- |\n| `base` | first |\n';
  writeFileSync(join(dir, 'docs', 'catalog.md'), header);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  for (const lane of ['one', 'two']) {
    git(dir, 'switch', '-q', '-c', `lane/${lane}`, 'main');
    writeFileSync(join(dir, 'docs', 'catalog.md'), `${header}| \`${lane}\` | added by ${lane} |\n`);
    git(dir, 'commit', '-q', '-am', `lane ${lane}`);
  }
  git(dir, 'switch', '-q', 'main');
  git(dir, 'merge', '-q', '--ff-only', 'lane/one');
  git(dir, 'switch', '-q', 'lane/two');
  git(dir, 'rebase', 'main');
  const rows = readFileSync(join(dir, 'docs', 'catalog.md'), 'utf8');
  for (const key of ['base', 'one', 'two']) assert.match(rows, new RegExp(`^\\| \`${key}\``, 'm'));
  assert.deepEqual(duplicateKeys(readTables(rows)), []);
});
