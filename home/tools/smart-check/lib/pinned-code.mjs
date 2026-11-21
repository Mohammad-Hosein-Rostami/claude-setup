// Purpose: the two pinned checks that read code relations (spec r9-smart-check 3; round 1, 7 "hallucinated packages and APIs"):
//   relative imports and the named imports of added lines resolve, and each new bare import is a dependency of its package (else
//   it must at least exist in the registry, looked up by name only: allowed by the owner).
// Exports: importFindings(plan), depFindings(plan), REGISTRY_TIMEOUT_MS.
// Invariants: read-only; one registry call per new package name, with a timeout; offline or a failed lookup is a note, never a
//   finding; workspace packages, path aliases (tsconfig `paths`, `@/`, `~/`, `#`) and installed packages count as present.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { readJsonFile } from '../../../hooks/lib/typecheck-plan.mjs';
import { bareName } from './facts.mjs';

export const REGISTRY_TIMEOUT_MS = 8_000;
const RESOLVE_EXTENSIONS = ['', '.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts', '.json', '.d.ts'];
const INDEX_FILES = ['index.mjs', 'index.js', 'index.ts', 'index.tsx', 'index.jsx'];
const NAMED_IMPORT = /^\s*import\s+(?:type\s+)?(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s*['"](\.{1,2}\/[^'"]+)['"]/;
const CODE = /\.(m?[jt]sx?|cjs)$/;
const MAX_REGISTRY_LOOKUPS = 5;
const NAME_SHAPE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;

const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };

/** The file a relative specifier names from `fromFile`, or null. A TS-style `.js` that names a `.ts` source counts. */
function resolveRelative(fromFile, spec) {
  const base = join(dirname(fromFile), spec);
  const stems = [base, base.replace(/\.(m|c)?js$/, '')];
  for (const stem of stems) {
    for (const ext of RESOLVE_EXTENSIONS) if (isFile(`${stem}${ext}`)) return `${stem}${ext}`;
    for (const index of INDEX_FILES) if (existsSync(join(stem, index))) return join(stem, index);
  }
  return null;
}

/** True when `text` exports `name` (or re-exports everything, which this line check cannot follow). */
function exportsName(text, name) {
  if (/export\s*\*\s*from/.test(text)) return true;
  const escaped = name.replace(/[$]/g, '\\$');
  return new RegExp(`export\\s+(declare\\s+)?(default\\s+)?(async\\s+)?(const|let|var|function\\*?|class|type|interface|enum|abstract\\s+class)\\s+${escaped}\\b`).test(text)
    || new RegExp(`export\\s*(type\\s*)?\\{[^}]*\\b${escaped}\\b[^}]*\\}`).test(text);
}

/**
 * P2: relative imports on added lines resolve, and each name a named import asks for is exported there.
 * @param {{top: string, files: object[]}} plan from buildPlan
 * @returns {string[]} findings `path:line: ...`
 */
export function importFindings(plan) {
  const findings = [];
  for (const file of plan.files.filter((f) => CODE.test(f.path) && existsSync(join(plan.top, f.path)))) {
    const full = join(plan.top, file.path);
    for (const { line, text } of file.added) {
      const spec = /(?:from\s*|import\s*\(?\s*|require\(\s*)['"](\.{1,2}\/[^'"]+)['"]/.exec(text)?.[1];
      if (!spec) continue;
      const target = resolveRelative(full, spec);
      if (target === null) { findings.push(`${file.path}:${line}: import '${spec.slice(0, 120)}' does not resolve`); continue; }
      const named = NAMED_IMPORT.exec(text);
      if (!named || !CODE.test(target)) continue;
      const targetText = readFileSync(target, 'utf8');
      const names = named[1].split(',').map((part) => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()).filter((n) => /^[\w$]+$/.test(n));
      for (const name of names) if (!exportsName(targetText, name)) findings.push(`${file.path}:${line}: '${name}' is not exported by ${relative(plan.top, target)}`);
    }
  }
  return findings;
}

/** The nearest package.json above `file` (inside the repo), parsed; {} when none. */
function nearestPackage(top, file) {
  for (let dir = dirname(join(top, file)); dir.startsWith(top); dir = dirname(dir)) {
    const pkg = readJsonFile(join(dir, 'package.json'));
    if (pkg) return { pkg, dir };
    if (dir === top) break;
  }
  return { pkg: {}, dir: top };
}

const declared = (pkg, name) => ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].some((field) => pkg[field] && name in pkg[field]);
const aliasPrefixes = (top) => Object.keys(readJsonFile(join(top, 'tsconfig.json'))?.compilerOptions?.paths ?? {}).map((key) => key.replace(/\*$/, ''));

/** The registry answer for one name: 'yes', 'no' or 'unknown' (offline, timeout, npm missing). */
function inRegistry(name) {
  const result = spawnSync('npm', ['view', name, 'name', '--json'], { encoding: 'utf8', timeout: REGISTRY_TIMEOUT_MS, windowsHide: true, shell: process.platform === 'win32' });
  if (result.error || result.status === null) return 'unknown';
  if (result.status === 0) return 'yes';
  return /E404|404 Not Found/.test(`${result.stdout}${result.stderr}`) ? 'no' : 'unknown';
}

/**
 * P3: each new bare import is declared in its package.json, installed, or (last) known to the registry.
 * @param {{top: string, files: object[]}} plan from buildPlan
 * @returns {string[]} findings
 */
export function depFindings(plan) {
  const findings = [];
  const aliases = aliasPrefixes(plan.top);
  const looked = new Map();
  for (const file of plan.files.filter((f) => CODE.test(f.path))) {
    const { pkg, dir } = nearestPackage(plan.top, file.path);
    const self = typeof pkg.name === 'string' ? pkg.name : '';
    for (const { line, text } of file.added) {
      const spec = /(?:from\s*|import\s*\(\s*|^\s*import\s*|require\(\s*)['"]([^'"]+)['"]/.exec(text)?.[1];
      const name = bareName(spec);
      if (!name || name.startsWith('@/') || aliases.some((prefix) => prefix && spec.startsWith(prefix)) || name === self || !NAME_SHAPE.test(name)) continue;
      if (declared(pkg, name) || existsSync(join(dir, 'node_modules', name)) || existsSync(join(plan.top, 'node_modules', name))) continue;
      if (!looked.has(name)) looked.set(name, looked.size < MAX_REGISTRY_LOOKUPS ? inRegistry(name) : 'unknown');
      const answer = looked.get(name);
      if (answer === 'no') findings.push(`${file.path}:${line}: package '${name}' does not exist in the registry`);
      else if (answer === 'yes') findings.push(`${file.path}:${line}: package '${name}' is not in package.json (it exists in the registry: add it with the package manager)`);
    }
  }
  return findings;
}
