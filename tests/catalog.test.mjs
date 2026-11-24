// Tests for docs/catalog.md: parallel lanes add and remove rows, so a careless merge can duplicate a row or keep one whose file is
// gone. The catalog merges as normal text (.gitattributes has no `merge=union` for it), so a deleted row never comes back unseen.
// Exports: readTables, duplicateKeys, missingFiles (the checks, so the fixture test can run them on a small catalog).
// Invariants: (1) the first cell of a row is unique within its table; (2) every file a row of a file table names exists;
// (3) a lane made before a row was deleted, that adds a row beside it, stops its rebase with a conflict instead of bringing the row back.
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

/** Runs git in `cwd` with a throwaway identity; returns the result so a test can expect a failure. */
function gitRun(cwd, ...args) {
  return spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}

function git(cwd, ...args) {
  const result = gitRun(cwd, ...args);
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}${result.stdout}`);
  return result.stdout;
}

test('a lane that adds a row beside one main deleted gets a rebase conflict, never the deleted row back', () => {
  const dir = makeTempDir('catalog-rebase-');
  git(dir, 'init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, '.gitattributes'), readFileSync(join(REPO, '.gitattributes')));
  const header = '| Skill | Description |\n| ----- | ----------- |\n| `base` | first |\n';
  const catalog = join(dir, 'docs', 'catalog.md');
  writeFileSync(catalog, `${header}| \`removed\` | deleted on main |\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'switch', '-q', '-c', 'lane/old', 'main');
  writeFileSync(catalog, `${header}| \`removed\` | deleted on main |\n| \`added\` | added by the lane |\n`);
  git(dir, 'commit', '-q', '-am', 'lane adds a row');
  git(dir, 'switch', '-q', 'main');
  writeFileSync(catalog, header);
  git(dir, 'commit', '-q', '-am', 'main deletes a row');
  git(dir, 'switch', '-q', 'lane/old');
  const rebase = gitRun(dir, 'rebase', 'main');
  assert.notEqual(rebase.status, 0, 'the rebase stops on the catalog instead of merging it silently');
  assert.match(git(dir, 'diff', '--name-only', '--diff-filter=U'), /^docs\/catalog\.md$/m);
  git(dir, 'rebase', '--abort');
});
