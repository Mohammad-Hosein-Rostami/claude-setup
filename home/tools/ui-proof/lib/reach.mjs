// Purpose: which inferred screens a set of changed files reaches: a full import walk (no hop cap) from every screen's files, at each
// rev, read with git plumbing; also the git reading and the module resolver that screens.mjs uses. Exports: gitRun, readTree,
// readBlobs, configFiles, makeResolver, importSpecs, reachedScreens.
// Edges: static, side-effect, re-export, dynamic `import()`, `require()`, `import.meta.glob`, template-literal imports (expanded as
// a glob), Angular templateUrl/styleUrls, `<script|style|link src|href>`, CSS/Sass @import/@use/@forward. Resolution: relative
// paths, tsconfig/jsconfig `paths` and `baseUrl` (extends and references followed), Vite/webpack `alias`, workspace package names,
// TS `.js` -> `.ts`; a bare name that no ancestor package.json declares is not a package (it counts as missing).
// Invariants (P1-P3, F1-F5): nothing is checked out, run or written in the project; git runs with fixed flags, GIT_SAFETY, no
// inherited GIT_* variables and a 5 s timeout per call; walks and reads are bounded (files, bytes, time) and a bound that is hit, an
// unresolvable non-package import or a non-literal import gives `all: true` with one reason line, never "not reached" and never a
// throw; paths are repo paths with forward slashes; project text is only matched, never evaluated.
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { GIT_SAFETY } from '../../board/lib/git-state.mjs';

const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 256 << 20;
const BLOBS_PER_CALL = 400;
const MAX_READ_BYTES = 8 << 20; // a source file bigger than this is not read (its imports are unknown: all); generated API types pass
const MAX_WALK_FILES = 60_000;
const WALK_BUDGET_MS = 45_000; // under git-tidy's 60 s UI check (spec section 7)
const MAX_GLOB_MATCHES = 2000;
const MAX_CONFIG_FILES = 2000;
const MAX_EXTENDS = 8;
const MAX_WHY_CHARS = 240;
const posix = path.posix;
const SCANNED = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|mdx|html?|s?css|sass|less)$/i;
const STYLE = /\.(?:s?css|sass|less)$/i;
const CODE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.json', '.css', '.scss'];
const STYLE_EXTENSIONS = ['.scss', '.sass', '.css', '.less'];
const CONFIG = /(?:^|\/)(?:tsconfig[^/]*\.json|jsconfig\.json|package\.json|(?:vite|vitest|webpack)\.config\.[cm]?[jt]s)$/;
const TEST_FILE = /(?:^|\/)(?:test|tests|__tests__|__mocks__|e2e|cypress)\/|\.(?:test|spec|cy)\.[cm]?[jt]sx?$/i;
const PACKAGE_NAME = /^(?:@[a-z0-9~-][\w.~-]*\/)?[a-z0-9~-][\w.~-]*(?:\/.*)?$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const BUILTINS = new Set(builtinModules);
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const ENTRY_FIELDS = ['source', 'module', 'main', 'types', 'typings'];
const PATTERNS = {
  from: /(?:^|[^\w$.])(?:import|export)\b[^'"`;]{0,4000}?\bfrom\s*(['"])([^'"\n]{1,500})\1/g,
  bare: /(?:^|[^\w$.])import\s*(['"])([^'"\n]{1,500})\1/g,
  call: /(?:^|[^\w$.])(?:import|require)\s*\(\s*([^)]{0,500}?)\s*[,)]/g,
  glob: /import\.meta\.glob(?:Eager)?\s*(?:<[^>]{0,200}>)?\s*\(\s*(\[[^\]]{0,2000}\]|(['"`])[^'"`\n]{1,500}\2)/g,
  angular: /\b(?:templateUrl|styleUrls?)\s*:\s*(\[[^\]]{0,2000}\]|(['"`])[^'"`\n]{1,500}\2)/g,
  tag: /<(?:script|style|template|link)\b[^>]{0,500}?\b(?:src|href)\s*=\s*(['"])([^'"\n]{1,500})\1/g,
  css: /@(?:import|use|forward)\s+(?:url\(\s*)?(['"])([^'"\n]{1,500})\1/g,
};
const LITERAL = /^(['"`])([^'"`\n]{1,500})\1$/;
const STRINGS = /(['"`])([^'"`\n]{1,500})\1/g;

const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));

/** Run read-only git in `repoDir` (fixed flags first). @returns {Buffer} stdout @throws {Error} naming the command on failure or timeout */
export function gitRun(repoDir, args, input = undefined, okStatuses = [0]) {
  const result = spawnSync('git', ['--no-optional-locks', ...GIT_SAFETY, '-C', repoDir, ...args],
    { input, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, env: gitEnv(), windowsHide: true });
  if (result.error || !okStatuses.includes(result.status)) {
    throw new Error(`git ${args[0]} failed: ${(result.error?.message ?? String(result.stderr ?? '')).trim().split('\n')[0]}`);
  }
  return result.stdout;
}

/** Every file at a commit. @returns {Map<string,{blob:string,size:number}>} repo path -> blob id and size (links and submodules left out) */
export function readTree(repoDir, sha) {
  const files = new Map();
  for (const entry of gitRun(repoDir, ['ls-tree', '-r', '-l', '-z', '--full-tree', sha]).toString('utf8').split('\0')) {
    const tab = entry.indexOf('\t');
    const [mode, type, blob, size] = entry.slice(0, tab).split(/ +/);
    if (tab > 0 && type === 'blob' && mode !== '120000') files.set(entry.slice(tab + 1), { blob, size: Number(size) });
  }
  return files;
}

/** The texts of blobs (one `cat-file --batch` per BLOBS_PER_CALL). @returns {Map<string,string>} blob id -> utf8 text */
export function readBlobs(repoDir, blobs) {
  const texts = new Map();
  const unique = [...new Set(blobs)];
  for (let start = 0; start < unique.length; start += BLOBS_PER_CALL) {
    const out = gitRun(repoDir, ['cat-file', '--batch'], `${unique.slice(start, start + BLOBS_PER_CALL).join('\n')}\n`);
    let at = 0;
    while (at < out.length) {
      const eol = out.indexOf(10, at);
      if (eol < 0) throw new Error('git cat-file gave a header without an end of line');
      const [blob, type, size] = out.subarray(at, eol).toString('utf8').split(' ');
      at = eol + 1;
      if (type === 'missing') continue; // `<id> missing`: no content follows
      if (!/^\d+$/.test(size ?? '')) throw new Error(`git cat-file gave a bad header for ${blob}`);
      if (type === 'blob') texts.set(blob, out.subarray(at, at + Number(size)).toString('utf8'));
      at += Number(size) + 1;
    }
  }
  return texts;
}

/** The files the resolver reads: tsconfig/jsconfig, package.json, Vite/webpack configs. */
export const configFiles = (tree) => [...tree.keys()].filter((file) => CONFIG.test(file)).slice(0, MAX_CONFIG_FILES);

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
const inRoot = (p) => posix.normalize(p).replace(/^\.\//, '').replace(/\/$/, '');

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

/** Text with JS/CSS comments blanked (strings kept; a quote string ends at its line), so commented-out code adds no edge. */
function withoutComments(text) {
  return text.replace(/(['"])(?:(?!\1)[^\\\n]|\\.)*\1|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g, (m) => (m[0] === '/' ? m.replace(/[^\n]/g, ' ') : m));
}

/**
 * The module specifiers one file names.
 * @returns {{specs: string[], globs: string[], dynamic: string[]}} literal specifiers, glob patterns (relative), non-literal snippets
 */
export function importSpecs(file, text) {
  const code = withoutComments(text);
  const take = (pattern, group) => [...code.matchAll(pattern)].map((m) => m[group]);
  const specs = [...take(PATTERNS.from, 2), ...take(PATTERNS.bare, 2), ...take(PATTERNS.tag, 2), ...(STYLE.test(file) ? take(PATTERNS.css, 2) : [])];
  const globs = take(PATTERNS.glob, 1).flatMap((arg) => [...arg.matchAll(STRINGS)].map((m) => m[2]));
  const dynamic = [];
  for (const arg of take(PATTERNS.call, 1)) {
    const literal = LITERAL.exec(arg.trim());
    if (literal && !literal[2].includes('${')) specs.push(literal[2]);
    else if (literal && /^\.\.?\//.test(literal[2])) globs.push(literal[2].replace(/\$\{[^}]*\}/g, '**'));
    else if (literal?.[1] === '`' && literal[2].startsWith('${')) continue; // `${origin}/x.mjs`: a url at run time, no bundler resolves it to a repo file
    else dynamic.push(arg.trim().slice(0, 80));
  }
  for (const arg of take(PATTERNS.angular, 1)) specs.push(...[...arg.matchAll(STRINGS)].map((m) => (m[2].startsWith('.') ? m[2] : `./${m[2]}`)));
  return { specs, globs, dynamic };
}

/** Tree files a relative glob (`*`, `**`, `{a,b}`) names from `file`'s folder. */
function globFiles(tree, file, glob) {
  if (!/^\.\.?\//.test(glob)) return null;
  const full = inRoot(posix.join(posix.dirname(file), glob));
  const source = full.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '\u0001').replace(/\?/g, '\u0002')
    .replace(/\{([^}]*)\}/g, (m, alts) => `(?:${alts.split(',').join('|')})`)
    .replace(/\u0000/g, '(?:.*/)?.*').replace(/\u0001/g, '[^/]*').replace(/\u0002/g, '[^/]');
  const pattern = new RegExp(`^${source}$`);
  return [...tree.keys()].filter((path) => pattern.test(path)).slice(0, MAX_GLOB_MATCHES);
}

/** The forward import walk of one rev from `roots`: reverse edges, visited files and the reasons it is incomplete. */
function walkRev({ repoDir, tree, roots, deadline }) {
  const configs = configFiles(tree);
  const texts = readBlobs(repoDir, configs.map((f) => tree.get(f).blob));
  const resolve = makeResolver(tree, new Map(configs.map((f) => [f, texts.get(tree.get(f).blob) ?? ''])));
  const importers = new Map();
  const visited = new Set(roots.filter((f) => tree.has(f)));
  const problems = [];
  const link = (target, from) => {
    if (!importers.has(target)) importers.set(target, new Set());
    importers.get(target).add(from);
    if (!visited.has(target)) { visited.add(target); next.push(target); }
  };
  let frontier = [...visited];
  let next = [];
  while (frontier.length > 0) {
    if (visited.size > MAX_WALK_FILES || Date.now() > deadline) { problems.push(`the walk passed ${visited.size} files or its time budget`); break; }
    const scanned = frontier.filter((f) => SCANNED.test(f));
    const readable = scanned.filter((f) => tree.get(f).size <= MAX_READ_BYTES);
    problems.push(...scanned.filter((f) => !readable.includes(f)).map((f) => `${f} is over ${MAX_READ_BYTES} bytes, not read`));
    const sources = readBlobs(repoDir, readable.map((f) => tree.get(f).blob));
    next = [];
    for (const file of readable) followFile({ file, text: sources.get(tree.get(file).blob) ?? '', tree, resolve, link, problems });
    frontier = next;
  }
  return { importers, visited, problems };
}

function followFile({ file, text, tree, resolve, link, problems }) {
  const { specs, globs, dynamic } = importSpecs(file, text);
  problems.push(...dynamic.map((snippet) => `${file} imports a non-literal module (${JSON.stringify(snippet)})`));
  for (const spec of specs) {
    const target = resolve(file, spec);
    if (target.kind === 'file') link(target.file, file);
    else if (target.kind === 'missing') problems.push(target.why);
  }
  for (const glob of globs) {
    const matches = globFiles(tree, file, glob);
    if (matches === null) problems.push(`${file} imports a glob that is not relative (${JSON.stringify(glob)})`);
    else for (const match of matches) link(match, file);
  }
}

/** The screens whose files reach `file` through the reverse edges (visited set: cycles end). */
function screensOver(file, importers, rootScreens) {
  const seen = new Set([file]);
  const queue = [file];
  const ids = new Set();
  while (queue.length > 0) {
    const current = queue.pop();
    for (const id of rootScreens.get(current) ?? []) ids.add(id);
    for (const parent of importers.get(current) ?? []) if (!seen.has(parent)) { seen.add(parent); queue.push(parent); }
  }
  return ids;
}

/**
 * The screens a change reaches: a full import walk at every rev (base and tip, so a deleted file is reached at base).
 * @param {{repoDir: string, revs: string[], files: string[], screens: {id: string, component: string, wraps?: string[]}[]}} input
 *   `files`: the changed app files (repo paths); a test file is never a reason for `all`
 * @returns {{reached: {id: string, via: string}[], all: boolean, why: string|null}} `all`: render every inferred screen; `why`: one line
 */
export function reachedScreens({ repoDir, revs, files, screens }) {
  const deadline = Date.now() + WALK_BUDGET_MS;
  const changed = files.map((f) => inRoot(f.replace(/\\/g, '/')));
  const rootScreens = new Map();
  for (const screen of screens) for (const root of [screen.component, ...(screen.wraps ?? [])].filter((f) => f && !TEST_FILE.test(f))) rootScreens.set(root, [...(rootScreens.get(root) ?? []), screen.id]);
  const reached = new Map();
  const problems = screens.length === 0 ? ['no inferred screen'] : [];
  const touched = new Set();
  for (const rev of revs) {
    try {
      const tree = readTree(repoDir, rev);
      const walk = walkRev({ repoDir, tree, roots: [...rootScreens.keys()], deadline });
      problems.push(...walk.problems.map((p) => `${p} (at ${rev.slice(0, 12)})`));
      for (const file of changed.filter((f) => walk.visited.has(f))) {
        touched.add(file);
        for (const id of screensOver(file, walk.importers, rootScreens)) if (!reached.has(id)) reached.set(id, file);
      }
    } catch (error) {
      problems.push(`cannot read ${rev.slice(0, 12)}: ${error.message}`);
    }
  }
  problems.push(...changed.filter((f) => !touched.has(f) && !TEST_FILE.test(f)).map((f) => `${f} is imported by no inferred screen`));
  const list = [...reached].map(([id, via]) => ({ id, via })).sort((a, b) => (a.id < b.id ? -1 : 1));
  return { reached: list, all: problems.length > 0, why: problems.length > 0 ? whyLine(problems) : null };
}

const whyLine = (problems) => {
  const first = problems[0].replace(/\s+/g, ' ').slice(0, MAX_WHY_CHARS);
  return `reach unresolved: ${first}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}: rendering every inferred route`;
};
