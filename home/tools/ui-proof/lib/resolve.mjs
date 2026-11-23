// Purpose: the module resolver of one tree, for the import walk (reach.mjs) and the route references (screens.mjs).
// Exports: STYLE, configFiles, inRoot, makeResolver.
// Resolution: relative and root paths, tsconfig/jsconfig `paths` and `baseUrl` (extends and references followed), Vite/webpack
// `alias`, workspace package names (exports, main, src/index), TS `.js` -> `.ts`, Sass partials and `~pkg`; a bare name that no
// ancestor package.json declares is not a package (it counts as missing).
// Invariants: pure (the caller reads the config texts at the commit); config text is parsed as JSON or matched, never evaluated;
// paths are repo paths with forward slashes; a path that leaves the repo names no file.
import { builtinModules } from 'node:module';
import path from 'node:path';

const MAX_CONFIG_FILES = 2000;
const MAX_EXTENDS = 8;
const posix = path.posix;
/** Stylesheet files (their imports resolve with the Sass rules). */
export const STYLE = /\.(?:s?css|sass|less)$/i;
const CODE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.json', '.css', '.scss'];
const STYLE_EXTENSIONS = ['.scss', '.sass', '.css', '.less'];
const CONFIG = /(?:^|\/)(?:tsconfig[^/]*\.json|jsconfig\.json|package\.json|(?:vite|vitest|webpack)\.config\.[cm]?[jt]s)$/;
const PACKAGE_NAME = /^(?:@[a-z0-9~-][\w.~-]*\/)?[a-z0-9~-][\w.~-]*(?:\/.*)?$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const STRINGS = /(['"`])([^'"`\n]{1,500})\1/g;
const BUILTINS = new Set(builtinModules);
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const ENTRY_FIELDS = ['source', 'module', 'main', 'types', 'typings'];

/** The files the resolver reads: tsconfig/jsconfig, package.json, Vite/webpack configs. */
export const configFiles = (tree) => [...tree.keys()].filter((file) => CONFIG.test(file)).slice(0, MAX_CONFIG_FILES);

/** A path made relative to the repo root (`./a/` -> `a`). */
export const inRoot = (p) => posix.normalize(p).replace(/^\.\//, '').replace(/\/$/, '');

/** JSON with comments and trailing commas (tsconfig) -> value, or null when it does not parse. */
function parseJsonc(text) {
  const plain = text.replace(/("(?:[^"\\\n]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match, string) => string ?? ' ');
  try { return JSON.parse(plain.replace(/,(\s*[}\]])/g, '$1')); } catch { return null; }
}

/** `paths` patterns of one compilerOptions block -> rules with repo targets ({prefix, suffix, exact, targets}). */
function pathRules(paths, base) {
  return Object.entries(paths ?? {}).filter(([, targets]) => Array.isArray(targets)).map(([pattern, targets]) => {
    const [prefix, suffix = ''] = pattern.split('*');
    return { prefix, suffix, exact: !pattern.includes('*'), targets: targets.filter((t) => typeof t === 'string').map((t) => posix.join(base, t)) };
  });
}

/** The alias rules of one tsconfig/jsconfig (its extends chain and references folded in). */
function tsRules(file, texts, depth = 0) {
  const config = texts.has(file) ? parseJsonc(texts.get(file)) : null;
  if (!config || depth > MAX_EXTENDS) return { baseUrl: null, paths: [] };
  const dir = posix.dirname(file);
  const relative = (target) => (target.endsWith('.json') ? posix.join(dir, target) : posix.join(dir, target, 'tsconfig.json'));
  const parents = [config.extends ?? []].flat().filter((e) => typeof e === 'string' && e.startsWith('.')).map((e) => tsRules(relative(e), texts, depth + 1));
  const refs = (config.references ?? []).filter((r) => typeof r?.path === 'string').map((r) => tsRules(relative(r.path), texts, depth + 1));
  const options = config.compilerOptions ?? {};
  const baseUrl = typeof options.baseUrl === 'string' ? posix.join(dir, options.baseUrl) : parents.find((p) => p.baseUrl)?.baseUrl ?? null;
  const own = options.paths ? pathRules(options.paths, baseUrl ?? dir) : parents.flatMap((p) => p.paths);
  return { baseUrl, paths: [...own, ...refs.flatMap((r) => r.paths)] };
}

/** Vite/webpack `alias` entries of a config text -> rules (the last path-like string of each entry, relative to the config). */
function aliasRules(file, text) {
  const block = /\balias\s*:\s*([[{])/.exec(text);
  if (!block) return [];
  const body = text.slice(block.index, block.index + 10_000);
  const dir = posix.dirname(file);
  const entries = [...body.matchAll(/(?:find\s*:\s*)?(['"])([^'"\n]{1,200})\1\s*[:,]\s*(?:replacement\s*:\s*)?([^\n]{0,300})/g)];
  return entries.flatMap(([, , key, value]) => {
    const target = [...value.matchAll(STRINGS)].map((m) => m[2]).filter((s) => /^[\w@./-]+$/.test(s)).at(-1);
    return target ? [{ prefix: key, suffix: '', exact: false, alias: true, targets: [posix.join(dir, target.replace(/^\//, ''))] }] : [];
  });
}

/** Workspace packages: name -> {dir, entries}; and per package.json folder the names it declares as dependencies. */
function packageFacts(texts, files) {
  const workspaces = new Map();
  const declared = new Map();
  for (const file of files.filter((f) => f.endsWith('package.json'))) {
    const json = parseJsonc(texts.get(file) ?? '');
    if (!json || typeof json !== 'object') continue;
    const dir = posix.dirname(file);
    if (typeof json.name === 'string') workspaces.set(json.name, { dir, entries: entryPaths(json) });
    declared.set(dir, new Set(DEP_FIELDS.flatMap((field) => Object.keys(json[field] ?? {}))));
  }
  return { workspaces, declared };
}

const entryPaths = (json) => {
  const exported = typeof json.exports === 'string' ? json.exports : json.exports?.['.'];
  const fromExports = typeof exported === 'string' ? [exported] : Object.values(exported ?? {}).filter((v) => typeof v === 'string');
  return [...fromExports, ...ENTRY_FIELDS.map((field) => json[field]).filter((v) => typeof v === 'string'), 'src/index', 'index'];
};

const ancestors = (file) => {
  const dirs = [];
  for (let dir = posix.dirname(file); ; dir = posix.dirname(dir)) { dirs.push(dir); if (dir === '.' || dir === '/') return dirs; }
};

/**
 * The module resolver of one tree.
 * @param {Map<string,{blob:string}>} tree the files at the rev
 * @param {Map<string,string>} texts repo path -> text of the configFiles(tree)
 * @returns {(from: string, spec: string) => {kind:'file',file:string}|{kind:'package'}|{kind:'missing',why:string}}
 */
export function makeResolver(tree, texts) {
  const files = [...texts.keys()];
  const { workspaces, declared } = packageFacts(texts, files);
  const rulesByDir = new Map();
  for (const file of files) {
    const dir = posix.dirname(file);
    const rules = /(?:^|\/)(?:tsconfig|jsconfig)\.json$/.test(file) ? tsRules(file, texts) : { baseUrl: null, paths: [] };
    const aliases = /\.config\.[cm]?[jt]s$/.test(file) ? aliasRules(file, texts.get(file)) : [];
    const known = rulesByDir.get(dir) ?? { baseUrls: [], paths: [] };
    rulesByDir.set(dir, { baseUrls: [...known.baseUrls, ...(rules.baseUrl ? [rules.baseUrl] : [])], paths: [...known.paths, ...rules.paths, ...aliases] });
  }
  const tryFile = (base, style) => findFile(tree, inRoot(base), style);
  return (from, rawSpec) => resolveSpec({ from, spec: cleanSpec(rawSpec), tryFile, rulesByDir, workspaces, declared });
}

const cleanSpec = (spec) => spec.split('!').at(-1).replace(/\?.*$/, '').replace(/(?!^)#.*$/, '');

/** The tree file a module path names (extensions, index files, Sass partials, TS `.js` -> `.ts`), or null. */
function findFile(tree, base, style) {
  if (base.startsWith('..')) return null;
  const extensions = style ? STYLE_EXTENSIONS : CODE_EXTENSIONS;
  const partial = posix.join(posix.dirname(base), `_${posix.basename(base)}`);
  const candidates = [base, ...extensions.map((e) => base + e), ...extensions.map((e) => `${base}/index${e}`),
    ...(style ? [...extensions.map((e) => partial + e), `${base}/_index.scss`] : []),
    ...(/\.[cm]?jsx?$/.test(base) ? [base.replace(/\.([cm]?)js(x?)$/, '.$1ts$2')] : [])];
  return candidates.find((c) => tree.has(c)) ?? null;
}

function resolveSpec({ from, spec, tryFile, rulesByDir, workspaces, declared }) {
  const style = STYLE.test(from);
  const found = (file, why) => (file ? { kind: 'file', file } : { kind: 'missing', why });
  if (!spec || (SCHEME.test(spec) && !spec.startsWith('#'))) return { kind: 'package' };
  if (spec.startsWith('.')) return found(tryFile(posix.join(posix.dirname(from), spec), style), `${JSON.stringify(spec)} in ${from} names no file`);
  if (spec.startsWith('/')) return found(tryFile(spec.slice(1), style), `${JSON.stringify(spec)} in ${from} names no file`);
  if (style && spec.startsWith('~')) return resolveSpec({ from, spec: spec.slice(1), tryFile, rulesByDir, workspaces, declared }); // Sass `~pkg`
  if (style) { const near = tryFile(posix.join(posix.dirname(from), spec), true); if (near) return found(near); } // Sass: own folder first
  const chain = ancestors(from).map((dir) => rulesByDir.get(dir)).filter(Boolean);
  const viaAlias = aliasTarget(chain, spec, tryFile, style);
  if (viaAlias) return viaAlias;
  const viaBase = chain.flatMap((rules) => rules.baseUrls).map((base) => tryFile(posix.join(base, spec), style)).find(Boolean);
  if (viaBase) return found(viaBase);
  const workspace = workspaceTarget(workspaces, spec, tryFile);
  if (workspace) return workspace;
  const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
  const declaredHere = ancestors(from).filter((dir) => declared.has(dir));
  if (PACKAGE_NAME.test(spec) && (BUILTINS.has(name) || declaredHere.length === 0 || declaredHere.some((dir) => declared.get(dir).has(name)))) return { kind: 'package' };
  return { kind: 'missing', why: `${JSON.stringify(spec)} in ${from} is no file, alias or declared package` };
}

function aliasTarget(chain, spec, tryFile, style) {
  const rules = chain.flatMap((r) => r.paths).filter((r) => (r.exact && !r.alias ? spec === r.prefix : spec === r.prefix || spec.startsWith(r.alias ? `${r.prefix}/` : r.prefix)));
  if (rules.length === 0) return null;
  for (const rule of rules.sort((a, b) => b.prefix.length - a.prefix.length)) {
    const middle = rule.exact && !rule.alias ? '' : spec.slice(rule.prefix.length, rule.suffix ? -rule.suffix.length || undefined : undefined);
    for (const target of rule.targets) {
      const file = tryFile(rule.alias ? target + middle : target.replace('*', middle), style);
      if (file) return { kind: 'file', file };
    }
  }
  return null; // TypeScript falls back to packages when no paths target exists: the package rule below decides
}

function workspaceTarget(workspaces, spec, tryFile) {
  const name = [...workspaces.keys()].filter((n) => spec === n || spec.startsWith(`${n}/`)).sort((a, b) => b.length - a.length)[0];
  if (!name) return null;
  const { dir, entries } = workspaces.get(name);
  const sub = spec.slice(name.length + 1);
  const file = sub ? tryFile(posix.join(dir, sub)) ?? tryFile(posix.join(dir, 'src', sub)) : entries.map((e) => tryFile(posix.join(dir, e))).find(Boolean);
  return file ? { kind: 'file', file } : { kind: 'missing', why: `workspace package ${JSON.stringify(spec)} names no file` };
}
