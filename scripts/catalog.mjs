#!/usr/bin/env node
// Purpose: keep docs/catalog.md in step with the files it lists. The Skills and Agents rows are built from frontmatter (name,
//   description, model, effort, preloaded skills), and the Event cell of each hook row from the hooks the settings files wire.
//   Everything else in the catalog is hand text and is never rewritten.
// Usage: node scripts/catalog.mjs check|write [--repo <dir>]   (--repo: the repo folder, default the one this script is in)
//   check  prints each drift and problem; changes nothing.
//   write  writes the generated parts into docs/catalog.md, then prints the problems it cannot fix by itself.
// Output: one `catalog: <section>: <added|removed|changed> <key>` line per drifted row, one `catalog: problem: <what>` line per
//   problem, then a summary line.
// Exit: 0 clean (check) or written with no problem left (write); 1 drift or a problem; 2 usage or a file that cannot be read.
// Problems (write cannot fix them, a person does): a catalog line over MAX_ROW_CHARS characters, a skill or agent whose
//   frontmatter has no description or names another name, a hook row whose file no settings file wires, a missing table.
// Exports: buildCatalog(repo, text) -> { text, drift, problems }, readFrontmatter(text) -> { fields, lists }, main(argv) -> exit code.
// Invariants:
// - Only the rows of the Skills and Agents tables and the Event cell of a top-level hook row are generated; a hook row for a
//   `lib/` file, its "What it does" cell and every other line keep their text byte for byte.
// - A wired hook with no row gets one, its text the first line of the hook file's header comment.
// - Generated rows are sorted by name, so the output depends on the files only, never on the order of the old rows.
// - Read-only except `write`, which writes docs/catalog.md once, and only when its text changed.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const EXIT = { clean: 0, drift: 1, usage: 2, error: 2 };
const USAGE = 'usage: node scripts/catalog.mjs check|write [--repo <dir>]';
const MAX_ROW_CHARS = 2000; // a longer row is a merge-conflict magnet and unreadable in a diff (audit I11)
const CATALOG = join('docs', 'catalog.md');
// The settings files whose `hooks` the installer merges into settings.json (base first, then the OS layers).
const SETTINGS_FILES = ['base.json', 'macos.json', 'linux.json', 'windows.json'];
const HOOK_IN_COMMAND = /hooks\/([\w.-]+\.mjs)/;
const SKILL_MODEL_DEFAULT = 'session model';

/**
 * Reads the frontmatter between the first two `---` lines: top-level `key: value` scalars (outer quotes dropped) and top-level
 * `key:` lists of `  - item` lines. Nested maps (such as `mcpServers`) are skipped.
 * @param {string} text the whole file
 * @returns {{ fields: Record<string, string>, lists: Record<string, string[]> }} empty when the file has no frontmatter
 */
export function readFrontmatter(text) {
  const fields = {};
  const lists = {};
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return { fields, lists };
  let listKey = null;
  for (const line of match[1].split(/\r?\n/)) {
    const top = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (top) {
      listKey = top[2] === '' ? top[1] : null;
      if (listKey) lists[listKey] = [];
      else fields[top[1]] = top[2].replace(/^(["'])(.*)\1$/, '$2');
      continue;
    }
    const item = /^\s+- (.+)$/.exec(line);
    if (listKey && item) lists[listKey].push(item[1].trim());
  }
  return { fields, lists };
}

/** A table cell: a `|` inside the text is escaped so it stays one cell. */
const cell = (text) => text.replace(/(?<!\\)\|/g, '\\|');

/** The model cell: the pinned model (or the skills' default) and the effort in brackets when one is pinned. */
const modelCell = (fields, fallback) => `${fields.model ?? fallback}${fields.effort ? ` (${fields.effort})` : ''}`;

/** Frontmatter of each skill (home/skills/<name>/SKILL.md) or agent (home/agents/<name>.md), sorted by name. */
function readEntries(repo, kind) {
  const folder = join(repo, 'home', kind);
  const names = kind === 'skills'
    ? readdirSync(folder).filter((name) => existsSync(join(folder, name, 'SKILL.md')))
    : readdirSync(folder).filter((file) => file.endsWith('.md')).map((file) => file.slice(0, -'.md'.length));
  return names.sort().map((name) => {
    const path = kind === 'skills' ? join(folder, name, 'SKILL.md') : join(folder, `${name}.md`);
    return { name, path: `home/${kind}/${kind === 'skills' ? `${name}/SKILL.md` : `${name}.md`}`, ...readFrontmatter(readFileSync(path, 'utf8')) };
  });
}

/**
 * The generated rows of one table, and the problems of its files.
 * @returns {{ rows: string[], problems: string[] }}
 */
function entryRows(repo, kind) {
  const problems = [];
  const rows = readEntries(repo, kind).map(({ name, path, fields, lists }) => {
    if (!fields.description) problems.push(`${path} has no description`);
    if (fields.name !== name) problems.push(`${path} names itself ${fields.name ?? 'nothing'}, not ${name}`);
    const preloads = lists.skills?.length ? ` Preloads ${lists.skills.join(', ')}.` : '';
    const model = kind === 'skills' ? modelCell(fields, SKILL_MODEL_DEFAULT) : modelCell(fields, 'inherit');
    return `| \`${name}\` | ${cell(`${fields.description ?? ''}${preloads}`)} | ${model} |`;
  });
  return { rows, problems };
}

/** Each hook file the settings files wire -> its events in wiring order, as `Event(matcher)` (or `Event` with no matcher). */
function wiredHooks(repo) {
  const events = new Map();
  for (const file of SETTINGS_FILES) {
    const path = join(repo, 'settings', file);
    if (!existsSync(path)) continue;
    for (const [event, groups] of Object.entries(JSON.parse(readFileSync(path, 'utf8')).hooks ?? {})) {
      for (const group of groups) {
        const label = group.matcher ? `${event}(${group.matcher})` : event;
        for (const hook of group.hooks ?? []) {
          const name = HOOK_IN_COMMAND.exec(hook.command ?? '')?.[1];
          if (!name) continue;
          const labels = events.get(name) ?? [];
          if (!labels.includes(label)) labels.push(label);
          events.set(name, labels);
        }
      }
    }
  }
  return events;
}

/** The first line of a hook file's header comment, the text of a new hook row. */
function headerLine(repo, name) {
  const first = readFileSync(join(repo, 'home', 'hooks', name), 'utf8').split('\n').find((line) => line.startsWith('//'));
  return first ? first.replace(/^\/\/\s*/, '') : '';
}

/** The table under the `## <section>` heading: index of its first row and of the line after its last, or null. */
function tableSpan(lines, section) {
  const heading = lines.findIndex((line) => line.startsWith(`## ${section}`));
  if (heading === -1) return null;
  const header = lines.findIndex((line, index) => index > heading && line.startsWith('|'));
  if (header === -1 || lines.slice(heading + 1, header).some((line) => line.startsWith('## '))) return null;
  let end = header + 2;
  while (end < lines.length && lines[end].startsWith('|')) end += 1;
  return { start: header + 2, end };
}

/** The key of a row: its first cell. */
const rowKey = (row) => row.split(/(?<!\\)\|/)[1]?.trim() ?? '';

/** Drift lines between the old and new rows of one table, by row key. */
function rowDrift(section, oldRows, newRows) {
  const before = new Map(oldRows.map((row) => [rowKey(row), row]));
  const after = new Map(newRows.map((row) => [rowKey(row), row]));
  const drift = [];
  for (const [key, row] of after) {
    if (!before.has(key)) drift.push(`${section}: added ${key}`);
    else if (before.get(key) !== row) drift.push(`${section}: changed ${key}`);
  }
  for (const key of before.keys()) if (!after.has(key)) drift.push(`${section}: removed ${key}`);
  if (drift.length === 0 && oldRows.join('\n') !== newRows.join('\n')) drift.push(`${section}: row order`);
  return drift;
}

/**
 * The row with its second cell (the Event) replaced. Old hand rows hold matchers with an unescaped `|` (`Bash|PowerShell`), so the
 * old cell runs over split pieces until its brackets are balanced; the "What it does" cell after it is kept byte for byte.
 */
function replaceEventCell(row, events) {
  const pieces = row.split(/(?<!\\)\|/); // ['', key, event..., what..., '']
  let end = 2;
  const depth = (text) => (text.match(/\(/g) ?? []).length - (text.match(/\)/g) ?? []).length;
  let open = depth(pieces[end]);
  while (open > 0 && end + 1 < pieces.length - 1) {
    end += 1;
    open += depth(pieces[end]);
  }
  return [...pieces.slice(0, 2), ` ${events} `, ...pieces.slice(end + 1)].join('|');
}

/** The hook rows with each top-level row's Event cell generated, plus a new row for each wired hook that has none. */
function hookRows(repo, oldRows, problems) {
  const wired = wiredHooks(repo);
  const seen = new Set();
  const rows = oldRows.map((row) => {
    const name = /^`([\w.-]+\.mjs)`$/.exec(rowKey(row))?.[1];
    if (!name) return row; // a lib/ row or a hand row: kept as it is
    seen.add(name);
    if (!wired.has(name)) {
      problems.push(`the Hooks row of ${name} names a hook no settings file wires`);
      return row;
    }
    return replaceEventCell(row, cell(wired.get(name).join('; ')));
  });
  for (const [name, labels] of wired) {
    if (!seen.has(name)) rows.push(`| \`${name}\` | ${cell(labels.join('; '))} | ${cell(headerLine(repo, name))} |`);
  }
  return rows;
}

/**
 * Builds the catalog text with its generated parts brought up to date.
 * @param {string} repo the repo folder
 * @param {string} text the current docs/catalog.md
 * @returns {{ text: string, drift: string[], problems: string[] }} the new text, the drifted rows and what a person must fix
 */
export function buildCatalog(repo, text) {
  const lines = text.split('\n');
  const drift = [];
  const problems = [];
  const sections = [
    ['Skills', () => entryRows(repo, 'skills')],
    ['Agents', () => entryRows(repo, 'agents')],
    ['Hooks', (oldRows) => ({ rows: hookRows(repo, oldRows, problems), problems: [] })],
  ];
  for (const [section, build] of sections) {
    const span = tableSpan(lines, section);
    if (!span) {
      problems.push(`no ${section} table under a "## ${section}" heading`);
      continue;
    }
    const oldRows = lines.slice(span.start, span.end);
    const { rows, problems: found } = build(oldRows);
    problems.push(...found);
    drift.push(...rowDrift(section, oldRows, rows));
    lines.splice(span.start, oldRows.length, ...rows);
  }
  lines.forEach((line, index) => {
    if (line.length > MAX_ROW_CHARS) problems.push(`line ${index + 1} has ${line.length} characters (at most ${MAX_ROW_CHARS})`);
  });
  return { text: lines.join('\n'), drift, problems };
}

/**
 * The command line: check or write.
 * @param {string[]} argv the arguments after the script
 * @returns {number} the exit code
 */
export function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { repo: { type: 'string' } } });
  } catch (error) {
    console.error(`catalog: ${error.message}\n${USAGE}`);
    return EXIT.usage;
  }
  const [mode, ...rest] = parsed.positionals;
  if (!['check', 'write'].includes(mode) || rest.length > 0) {
    console.error(USAGE);
    return EXIT.usage;
  }
  const repo = parsed.values.repo ?? fileURLToPath(new URL('..', import.meta.url));
  const path = join(repo, CATALOG);
  let result;
  let before;
  try {
    before = readFileSync(path, 'utf8');
    result = buildCatalog(repo, before);
  } catch (error) {
    console.error(`catalog: error: ${error.message}`);
    return EXIT.error;
  }
  const { text, drift, problems } = result;
  for (const line of drift) console.log(`catalog: ${line}`);
  for (const line of problems) console.log(`catalog: problem: ${line}`);
  if (mode === 'write' && text !== before) writeFileSync(path, text);
  console.log(`catalog: ${drift.length} row(s) ${mode === 'write' ? 'written' : 'drifted'}, ${problems.length} problem(s)`);
  const failed = problems.length > 0 || (mode === 'check' && drift.length > 0);
  return failed ? EXIT.drift : EXIT.clean;
}

if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) process.exitCode = main(process.argv.slice(2));
