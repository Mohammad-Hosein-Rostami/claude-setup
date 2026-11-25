#!/usr/bin/env node
// Purpose: build docs/catalog.md, the list of everything this setup ships, from the files it lists (install writes it).
//   The catalog is generated and git-ignored (docs/adr/0009-generated-catalog.md), so branches never conflict on it. Each
//   row's text lives in its own file: skill and agent frontmatter, a rule's `paths` and ids, a standard's first line, a hook's
//   first header line, a tool README's first line after its heading, a script's `Purpose:` line, plugins/plugins.json and
//   settings/base.json (their reasons: plugins/README.md, settings/README.md).
// Usage: node scripts/catalog.mjs check|write [--repo <dir>]   (--repo: the repo folder, default the one this script is in)
//   check prints each problem and changes nothing; write also writes docs/catalog.md when its text changed.
// Output: one `catalog: problem: <what>` line per problem, then a summary line.
// Exit: 0 no problem; 1 a problem; 2 usage or a file that cannot be read.
// Problems (a person fixes them in the file named): a line over MAX_ROW_CHARS characters, a skill or agent whose frontmatter
//   has no description or names another name, a hook, tool or script with no summary line, a hook file no settings file wires
//   or a wired hook with no file, a settings/base.json key with no settings/README.md row.
// Exports: buildCatalog(repo) -> { text, problems }, readFrontmatter(text) -> { fields, lists }, main(argv) -> exit code.
// Invariants: the text depends on the files only (every list sorted by name); read-only except `write`.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const EXIT = { clean: 0, problem: 1, usage: 2, error: 2 };
const USAGE = 'usage: node scripts/catalog.mjs check|write [--repo <dir>]';
const MAX_ROW_CHARS = 2000; // a longer row is unreadable in a diff (audit I11)
const CATALOG = join('docs', 'catalog.md');
// The settings files whose `hooks` the installer merges into settings.json (base first, then the OS layers).
const SETTINGS_FILES = ['base.json', 'macos.json', 'linux.json', 'windows.json'];
// settings/base.json keys whose inner keys are separate settings, one row each (`env.<NAME>`, `permissions.<key>`).
const SPLIT_SETTINGS = ['env', 'permissions'];
const HOOK_IN_COMMAND = /hooks\/([\w.-]+\.mjs)/;
const PURPOSE_LINE = /^(?:\/\/|#)\s*Purpose:\s*(.+)$/;
const RULE_ID = /^([A-Z]+)(\d+) \|/;
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
const code = (text) => `\`${text}\``;
const read = (repo, ...parts) => readFileSync(join(repo, ...parts), 'utf8');
// Hidden entries (`.DS_Store`) are never part of the catalog.
const sortedNames = (folder, keep) => readdirSync(folder).filter((name) => !name.startsWith('.') && keep(name)).sort();

/** A markdown table: the header cells, then one row per cell list. */
const table = (header, rows) => [
  `| ${header.join(' | ')} |`,
  `| ${header.map(() => '---').join(' | ')} |`,
  ...rows.map((cells) => `| ${cells.map(cell).join(' | ')} |`),
];

/** The model cell: the pinned model (or the default) and the effort in brackets when one is pinned. */
const modelCell = (fields, fallback) => `${fields.model ?? fallback}${fields.effort ? ` (${fields.effort})` : ''}`;

/** Rows of the Skills (home/skills/<name>/SKILL.md) or Agents (home/agents/<name>.md) table, from frontmatter. */
function entryRows(repo, kind, problems) {
  const folder = join(repo, 'home', kind);
  const names = kind === 'skills'
    ? sortedNames(folder, (name) => existsSync(join(folder, name, 'SKILL.md')))
    : sortedNames(folder, (file) => file.endsWith('.md')).map((file) => file.slice(0, -'.md'.length));
  return names.map((name) => {
    const path = kind === 'skills' ? `home/skills/${name}/SKILL.md` : `home/agents/${name}.md`;
    const { fields, lists } = readFrontmatter(read(repo, path));
    if (!fields.description) problems.push(`${path} has no description`);
    if (fields.name !== name) problems.push(`${path} names itself ${fields.name ?? 'nothing'}, not ${name}`);
    const preloads = lists.skills?.length ? ` Preloads ${lists.skills.join(', ')}.` : '';
    const model = modelCell(fields, kind === 'skills' ? SKILL_MODEL_DEFAULT : 'inherit');
    return [code(name), `${fields.description ?? ''}${preloads}`, model];
  });
}

/** The ids of a rules file as ranges per letter: `S1-S11, B1-B10`, with missing numbers named (`P1-P16 without P4`). */
function idRanges(text) {
  const numbers = new Map();
  for (const line of text.split('\n')) {
    const id = RULE_ID.exec(line);
    if (id) numbers.set(id[1], [...(numbers.get(id[1]) ?? []), Number(id[2])]);
  }
  return [...numbers].map(([letter, found]) => {
    const [low, high] = [Math.min(...found), Math.max(...found)];
    const gaps = [];
    for (let n = low; n <= high; n += 1) if (!found.includes(n)) gaps.push(`${letter}${n}`);
    return `${letter}${low}-${letter}${high}${gaps.length ? ` without ${gaps.join(', ')}` : ''}`;
  }).join(', ');
}

/** Rows of the Rules table: file, its `paths` globs (a flow list such as `["Dockerfile*","*.tf"]`) and its id ranges. */
function ruleRows(repo) {
  return sortedNames(join(repo, 'home', 'rules'), (file) => file.endsWith('.md')).map((file) => {
    const text = read(repo, 'home', 'rules', file);
    const globs = [...(readFrontmatter(text).fields.paths ?? '').matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    return [code(file), globs.map(code).join(', ') || 'every file', idRanges(text)];
  });
}

/** Rows of the Standards table: file and its first line, the title. */
function standardRows(repo) {
  return sortedNames(join(repo, 'home', 'standards'), (file) => file.endsWith('.md'))
    .map((file) => [code(file), read(repo, 'home', 'standards', file).split('\n')[0].replace(/^#\s*/, '')]);
}

/** Each hook file the settings files wire -> its events in wiring order, as `Event(matcher)` (or `Event` with no matcher). */
function wiredHooks(repo) {
  const events = new Map();
  for (const file of SETTINGS_FILES.filter((name) => existsSync(join(repo, 'settings', name)))) {
    for (const [event, groups] of Object.entries(JSON.parse(read(repo, 'settings', file)).hooks ?? {})) {
      for (const group of groups) {
        const label = group.matcher ? `${event}(${group.matcher})` : event;
        for (const hook of group.hooks ?? []) {
          const name = HOOK_IN_COMMAND.exec(hook.command ?? '')?.[1];
          const labels = name ? events.get(name) ?? [] : null;
          if (labels && !labels.includes(label)) events.set(name, [...labels, label]);
        }
      }
    }
  }
  return events;
}

/** The first line of a code file's header comment (`// text`), or '' when line 1 is not a comment. */
const headerLine = (text) => (/^\/\/\s*(.+)/.exec(text.split('\n')[0])?.[1] ?? '').trim();

/** Rows of the Hooks table: each top-level hook file, the events that wire it and its first header line. */
function hookRows(repo, problems) {
  const wired = wiredHooks(repo);
  const files = sortedNames(join(repo, 'home', 'hooks'), (file) => file.endsWith('.mjs'));
  for (const name of wired.keys()) if (!files.includes(name)) problems.push(`settings wire home/hooks/${name}, which does not exist`);
  return files.map((file) => {
    const summary = headerLine(read(repo, 'home', 'hooks', file));
    if (!summary) problems.push(`home/hooks/${file} has no header line`);
    if (!wired.has(file)) problems.push(`home/hooks/${file} is wired by no settings file`);
    return [code(file), (wired.get(file) ?? ['not wired']).join('; '), summary];
  });
}

/** The first line after a README's `# ` heading that is not empty and not a heading: its one-line summary. */
const readmeSummary = (text) => text.split('\n').slice(1).find((line) => line.trim() && !line.startsWith('#'))?.trim() ?? '';

/** Rows of the Tools table: each home/tools/<name> folder, its README's summary line and a link to the README. */
function toolRows(repo, problems) {
  const folder = join(repo, 'home', 'tools');
  return sortedNames(folder, (name) => statSync(join(folder, name)).isDirectory()).map((name) => {
    const readme = join(folder, name, 'README.md');
    const summary = existsSync(readme) ? readmeSummary(readFileSync(readme, 'utf8')) : '';
    if (!summary) problems.push(`home/tools/${name} has no README.md summary line`);
    return [code(name), `${summary} [README](../home/tools/${name}/README.md)`];
  });
}

/** Rows of the Scripts table: each file directly in scripts/ and its `Purpose:` line. */
function scriptRows(repo, problems) {
  const folder = join(repo, 'scripts');
  return sortedNames(folder, (name) => statSync(join(folder, name)).isFile()).map((name) => {
    const purpose = read(repo, 'scripts', name).split('\n').map((line) => PURPOSE_LINE.exec(line)?.[1]).find(Boolean) ?? '';
    if (!purpose) problems.push(`scripts/${name} has no Purpose: line`);
    return [code(name), purpose.trim()];
  });
}

/** A settings value in one cell: a scalar as JSON, a list item by item, an object by its keys. */
function valueCell(value) {
  if (Array.isArray(value)) return value.map((item) => code(JSON.stringify(item))).join(', ');
  if (value !== null && typeof value === 'object') return `keys: ${Object.keys(value).map(code).join(', ')}`;
  return code(JSON.stringify(value));
}

/** Rows of the Settings keys table: each key of settings/base.json (SPLIT_SETTINGS one level down) and its value. */
function settingRows(repo, problems) {
  const settings = JSON.parse(read(repo, 'settings', 'base.json'));
  const pairs = Object.entries(settings).flatMap(([key, value]) => (SPLIT_SETTINGS.includes(key)
    ? Object.entries(value).map(([inner, innerValue]) => [`${key}.${inner}`, innerValue])
    : [[key, value]]));
  const readme = join(repo, 'settings', 'README.md');
  const explained = existsSync(readme) ? readFileSync(readme, 'utf8') : '';
  for (const [key] of pairs) if (!explained.includes(`| ${code(key)} |`)) problems.push(`settings/README.md has no row for ${key}`);
  return pairs.sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [code(key), valueCell(value)]);
}

/** The Plugins section's lines, from plugins/plugins.json. */
function pluginLines(repo) {
  const plugins = JSON.parse(read(repo, 'plugins', 'plugins.json'));
  const list = (ids) => [...ids].sort().map(code).join(', ') || 'none';
  const perProject = Object.keys(plugins.perProject ?? {}).filter((key) => key.includes('@'));
  return [
    `- Enabled: ${list(plugins.enabled)}.`,
    `- Off, enabled per project in its \`.claude/settings.local.json\`: ${list(perProject)}.`,
    `- Disabled: ${list(plugins.disabled.filter((id) => !perProject.includes(id)))}.`,
    `- Marketplaces: ${list(plugins.marketplaces.map((market) => market.name))}.`,
  ];
}

/** One `## ` section: its heading, an optional intro line and its body lines. */
const section = (heading, intro, body) => [`## ${heading}`, '', ...(intro ? [intro, ''] : []), ...body, ''];

/**
 * Builds the catalog text from the repo's files.
 * @param {string} repo the repo folder
 * @returns {{ text: string, problems: string[] }} the catalog and what a person must fix
 * @throws {Error} when a listed file or folder cannot be read or a JSON file does not parse
 */
export function buildCatalog(repo) {
  const problems = [];
  const statusLine = `\`home/statusline.mjs\`: ${headerLine(read(repo, 'home', 'statusline.mjs'))} Rows and colours: "Status line" in`;
  const lines = [
    '# Catalog',
    '',
    'Everything this setup ships, built by `scripts/catalog.mjs` from the files it lists; install writes this file and git',
    'ignores it, so never edit it by hand: change the file a row comes from. Skill and agent descriptions are quoted from',
    'their frontmatter; those descriptions are what make them trigger.',
    '',
    ...section('Skills (`home/skills/<name>/SKILL.md`)', null,
      table(['Skill', 'Description (trigger)', 'Model'], entryRows(repo, 'skills', problems))),
    ...section('Agents (`home/agents/<name>.md`)',
      'Who starts whom, how many run at once and how they report: "The boss and the agents" in `home/CLAUDE.md`.',
      table(['Agent', 'Description (trigger)', 'Model'], entryRows(repo, 'agents', problems))),
    ...section('Rules (`home/rules/`, ids)', 'Rules are one line each and load when a matching file is in play.',
      table(['File', 'Applies to', 'Ids'], ruleRows(repo))),
    ...section('Standards (`home/standards/`, the longer reference the rules point to)', null,
      table(['File', 'Title (first line)'], standardRows(repo))),
    ...section('Hooks (`home/hooks/`, wired in `settings/*.json`)',
      'What each hook does in detail: [home/hooks/README.md](../home/hooks/README.md).',
      table(['File', 'Event', 'What it does'], hookRows(repo, problems))),
    ...section('Project notes (`home/project-notes/`)', null,
      ['Notes per project, one `<key>.md` each: [home/project-notes/README.md](../home/project-notes/README.md).']),
    ...section('Status line', null,
      [statusLine, '[docs/how-it-works.md](how-it-works.md) and [home/tools/board/README.md](../home/tools/board/README.md).']),
    ...section('Tools (`home/tools/`)', 'System programs to install: `tools/Brewfile` (macOS) and `tools/windows-tools.ps1` (Windows).',
      table(['Tool', 'What it does'], toolRows(repo, problems))),
    ...section('Plugins (`plugins/plugins.json`)',
      'Why each is on, off or on per project: [plugins/README.md](../plugins/README.md).', pluginLines(repo)),
    ...section('Settings keys (`settings/base.json`)', 'Why each key has its value: [settings/README.md](../settings/README.md).',
      table(['Key', 'Value'], settingRows(repo, problems))),
    ...section('Scripts (`scripts/`)', null, table(['Script', 'Purpose'], scriptRows(repo, problems))),
  ];
  lines.forEach((line, index) => {
    if (line.length > MAX_ROW_CHARS) problems.push(`line ${index + 1} has ${line.length} characters (at most ${MAX_ROW_CHARS})`);
  });
  return { text: lines.join('\n'), problems };
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
  let problems;
  let changed = false;
  try {
    const built = buildCatalog(repo);
    problems = built.problems;
    changed = mode === 'write' && (!existsSync(path) || readFileSync(path, 'utf8') !== built.text);
    if (changed) writeFileSync(path, built.text);
  } catch (error) {
    console.error(`catalog: error: ${error.message}`);
    return EXIT.error;
  }
  for (const line of problems) console.log(`catalog: problem: ${line}`);
  const action = mode === 'write' ? `${changed ? 'written' : 'unchanged'}, ` : '';
  console.log(`catalog: ${action}${problems.length} problem(s)`);
  return problems.length > 0 ? EXIT.problem : EXIT.clean;
}

if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) process.exitCode = main(process.argv.slice(2));
