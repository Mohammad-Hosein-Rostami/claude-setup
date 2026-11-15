// Purpose: walk the directory, hand each file to the readers that know its kind, and collect findings and hints.
// Exports: scanDirectory.
// Invariants: `.env*` files are never opened. A file that cannot be read or parsed becomes a hint `unreadable?` with the
//   reason (never an exception). A kind ending in `?` is a hint, every other kind is a finding. Results are sorted by
//   file, then line, then kind.
import { basename, dirname, join } from 'node:path';
import { readCodeowners, readWorkflow } from './ci.mjs';
import { Disk } from './disk.mjs';
import { readCompose, readDockerfile } from './docker.mjs';
import { readConfigPaths, readScriptPaths } from './hints.mjs';
import { readMarkdown } from './markdown.mjs';
import { readPackageJson, readPnpmWorkspace } from './package.mjs';
import { readTsconfig } from './tsconfig.mjs';
import { walkTree } from './walk.mjs';

const UNREADABLE = 'unreadable?';
const isEnvFile = (rel) => basename(rel).startsWith('.env');

/** Compose files are read first: Dockerfiles use the build contexts they name. */
function isComposeFile(rel) {
  return /^(docker-)?compose[^/]*\.ya?ml$/.test(basename(rel));
}

function isConfigFile(rel) {
  const name = basename(rel);
  return /\.config\.(js|cjs|mjs|ts|mts)$/.test(name) || name.startsWith('eslint.config.') || name.startsWith('.eslintrc');
}

const READERS = [
  { matches: (rel) => /^(tsconfig|jsconfig)[^/]*\.json$/.test(basename(rel)), read: readTsconfig },
  { matches: (rel) => basename(rel) === 'package.json', read: readPackageJson },
  { matches: (rel) => basename(rel) === 'package.json', read: readScriptPaths },
  { matches: isConfigFile, read: readConfigPaths },
  { matches: (rel) => basename(rel) === 'pnpm-workspace.yaml', read: readPnpmWorkspace },
  { matches: isComposeFile, read: readCompose },
  { matches: (rel) => /\.mdc?$/.test(rel), read: readMarkdown },
  { matches: (rel) => basename(rel).startsWith('Dockerfile'), read: readDockerfile },
  { matches: (rel) => /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(rel), read: readWorkflow },
  { matches: (rel) => basename(rel) === 'CODEOWNERS' && ['.', '.github', 'docs'].includes(dirname(rel)), read: readCodeowners },
];

const byFileThenLine = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));

function readOne(rel, readers, context) {
  const abs = join(context.disk.root, rel);
  try {
    const file = { rel, abs, text: context.disk.readText(abs) };
    return readers.flatMap((reader) => reader.read(file, context)).map((result) => ({ file: rel, ...result }));
  } catch (error) {
    return [{ file: rel, line: error.line ?? 1, kind: UNREADABLE, value: error.message }];
  }
}

/**
 * Scans a directory for references to paths that do not exist.
 * @param {string} root directory to scan
 * @returns {{findings: object[], hints: object[], scanned: number}} each item is {file, line, kind, value}
 * @throws when the root cannot be read
 */
export function scanDirectory(root) {
  const { files, folders, problems } = walkTree(root);
  const names = new Set([...files, ...folders].map((path) => basename(path)));
  const context = { disk: new Disk(root), files, folders, names, topFolders: new Set(folders.filter((path) => !path.includes('/'))), composeBuilds: [] };
  const results = problems.map((problem) => ({ file: problem.path, line: 1, kind: UNREADABLE, value: problem.reason }));
  let scanned = 0;
  const readable = files.filter((path) => !isEnvFile(path));
  for (const rel of [...readable.filter(isComposeFile), ...readable.filter((path) => !isComposeFile(path))]) {
    const readers = READERS.filter((reader) => reader.matches(rel));
    if (readers.length === 0) continue;
    scanned += 1;
    results.push(...readOne(rel, readers, context));
  }
  results.sort(byFileThenLine);
  return { findings: results.filter((r) => !r.kind.endsWith('?')), hints: results.filter((r) => r.kind.endsWith('?')), scanned };
}
