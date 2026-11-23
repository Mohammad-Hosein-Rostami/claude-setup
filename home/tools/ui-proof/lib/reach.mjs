// Purpose: which inferred screens a set of changed files reaches: a full import walk (no hop cap) from every screen's files (component
// and wraps), at each rev, read with git plumbing (git-read.mjs) and resolved by resolve.mjs. Exports: TEST_FILE, importSpecs,
// fileEdges, reachedScreens.
// Edges: static, side-effect, re-export, dynamic `import()`, `require()`, `import.meta.glob`, template-literal imports (expanded as
// a glob), Angular templateUrl/styleUrls, `<script|style|link src|href>`, CSS/Sass @import/@use/@forward.
// A reached stylesheet that is no CSS module, or a reached global style block, applies to the whole bundle: it reaches every screen.
// Invariants (P1-P3, F1-F5): nothing is checked out, run or written in the project; walks and reads are bounded (files, bytes, time)
// and a bound that is hit, an unresolvable non-package import or a non-literal import gives `all: true` with one reason line, never
// "not reached" and never a throw; paths are repo paths with forward slashes; project text is only matched, never evaluated.
import path from 'node:path';
import { readBlobs, readTree } from './git-read.mjs';
import { STYLE, configFiles, inRoot, makeResolver } from './resolve.mjs';

const MAX_READ_BYTES = 8 << 20; // a source file bigger than this is not read (its imports are unknown: all); generated API types pass
const MAX_WALK_FILES = 60_000;
const WALK_BUDGET_MS = 45_000; // under git-tidy's 60 s UI check (spec section 7)
const MAX_GLOB_MATCHES = 2000;
const MAX_WHY_CHARS = 240;
const posix = path.posix;
const SCANNED = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|mdx|html?|s?css|sass|less)$/i;
/** Test, mock and e2e files: never a screen root, never a reason for `all`. */
export const TEST_FILE = /(?:^|\/)(?:test|tests|__tests__|__mocks__|e2e|cypress)\/|\.(?:test|spec|cy)\.[cm]?[jt]sx?$/i;
const CSS_MODULE = /\.module\.(?:s?css|sass|less)$/i;
const STYLE_TAG = /<style\b([^>]{0,500})>/gi;
// Global style in code or a module: styled-components, emotion, MUI, vanilla-extract, stitches/panda, Angular, styled-jsx,
// Svelte/Astro, CSS modules and Vue `:global`.
const GLOBAL_STYLE_CODE = /\b(?:createGlobalStyle|injectGlobal|globalStyle|globalCss)\s*[(`]|<Global(?:Styles)?\b|ViewEncapsulation\.None|<style\b[^>]{0,200}\b(?:jsx\s+global|global|is:global)\b|:global\b|::v-global\b/;
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

/**
 * The files one file imports and why some cannot be named (shared by the walk and the app-shell search in screen-sources.mjs).
 * @param {{file: string, text: string, tree: Map<string,object>, resolve: Function}} input resolve: from makeResolver
 * @returns {{targets: string[], problems: string[]}} targets: tree files; problems: one line per unresolvable or non-literal import
 */
export function fileEdges({ file, text, tree, resolve }) {
  const { specs, globs, dynamic } = importSpecs(file, text);
  const targets = [];
  const problems = dynamic.map((snippet) => `${file} imports a non-literal module (${JSON.stringify(snippet)})`);
  for (const spec of specs) {
    const target = resolve(file, spec);
    if (target.kind === 'file') targets.push(target.file);
    else if (target.kind === 'missing') problems.push(target.why);
  }
  for (const glob of globs) {
    const matches = globFiles(tree, file, glob);
    if (matches === null) problems.push(`${file} imports a glob that is not relative (${JSON.stringify(glob)})`);
    else targets.push(...matches);
  }
  return { targets, problems };
}

/**
 * The forward import walk of one rev from `roots`: reverse edges, visited files and the reasons it is incomplete. An edge from a
 * router file to a root (a route component or wrap) is not followed: the router renders it on its own route only.
 */
function walkRev({ repoDir, tree, roots, routers, deadline, maxFiles }) {
  const configs = configFiles(tree);
  const texts = readBlobs(repoDir, configs.map((f) => tree.get(f).blob));
  const resolve = makeResolver(tree, new Map(configs.map((f) => [f, texts.get(tree.get(f).blob) ?? ''])));
  const importers = new Map();
  const rootSet = new Set(roots);
  const visited = new Set(roots.filter((f) => tree.has(f)));
  const problems = [];
  let frontier = [...visited];
  while (frontier.length > 0) {
    if (visited.size > maxFiles || Date.now() > deadline) { problems.push(`the walk passed ${visited.size} files or its time budget`); break; }
    const scanned = frontier.filter((f) => SCANNED.test(f));
    const readable = scanned.filter((f) => tree.get(f).size <= MAX_READ_BYTES);
    problems.push(...scanned.filter((f) => !readable.includes(f)).map((f) => `${f} is over ${MAX_READ_BYTES} bytes, not read`));
    const sources = readBlobs(repoDir, readable.map((f) => tree.get(f).blob));
    const next = [];
    for (const file of readable) {
      const edges = fileEdges({ file, text: sources.get(tree.get(file).blob) ?? '', tree, resolve });
      problems.push(...edges.problems);
      for (const target of edges.targets.filter((t) => !(routers.has(file) && rootSet.has(t)))) {
        if (!importers.has(target)) importers.set(target, new Set());
        importers.get(target).add(file);
        if (!visited.has(target)) { visited.add(target); next.push(target); }
      }
    }
    frontier = next;
  }
  return { importers, visited, problems };
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
 * True when a change to `file` restyles the whole bundle: a stylesheet that is no CSS module (or a module with `:global`), a Vue
 * `<style>` block without `scoped`/`module`, or global style code (`createGlobalStyle`, `<GlobalStyles>`, `:global`, ...).
 */
function globalStyle(file, text) {
  if (STYLE.test(file)) return !CSS_MODULE.test(file) || GLOBAL_STYLE_CODE.test(text);
  if (/\.vue$/i.test(file) && [...text.matchAll(STYLE_TAG)].some((m) => !/\b(?:scoped|module)\b/.test(m[1]))) return true;
  return GLOBAL_STYLE_CODE.test(text);
}

/**
 * The screens a change reaches: a full import walk at every rev (base and tip, so a deleted file is reached at base); a reached
 * global stylesheet or style block reaches every screen.
 * @param {{repoDir: string, revs: string[], files: string[], screens: {id: string, component: string, wraps?: string[], router?: string|null}[],
 *   maxWalkFiles?: number, budgetMs?: number}} input `files`: the changed app files (repo paths); a test file is never a reason
 *   for `all`; maxWalkFiles and budgetMs bound the walk of each rev (defaults 60000 files, 45 s for all revs)
 * @returns {{reached: {id: string, via: string}[], all: boolean, why: string|null}} `all`: render every inferred screen; `why`: one line
 */
export function reachedScreens({ repoDir, revs, files, screens, maxWalkFiles = MAX_WALK_FILES, budgetMs = WALK_BUDGET_MS }) {
  const deadline = Date.now() + budgetMs;
  const changed = files.map((f) => inRoot(f.replace(/\\/g, '/')));
  const rootScreens = new Map();
  const routers = new Set(screens.map((s) => s.router).filter(Boolean));
  for (const screen of screens) for (const root of [screen.component, ...(screen.wraps ?? [])].filter((f) => f && !TEST_FILE.test(f))) rootScreens.set(root, [...(rootScreens.get(root) ?? []), screen.id]);
  const reached = new Map();
  const problems = screens.length === 0 ? ['no inferred screen'] : [];
  const touched = new Set();
  for (const rev of revs) {
    try {
      const tree = readTree(repoDir, rev);
      const walk = walkRev({ repoDir, tree, roots: [...rootScreens.keys()], routers, deadline, maxFiles: maxWalkFiles });
      problems.push(...walk.problems.map((p) => `${p} (at ${rev.slice(0, 12)})`));
      const hit = changed.filter((f) => walk.visited.has(f));
      const texts = readBlobs(repoDir, hit.filter((f) => SCANNED.test(f) && tree.get(f).size <= MAX_READ_BYTES).map((f) => tree.get(f).blob));
      for (const file of hit) {
        touched.add(file);
        const global = globalStyle(file, texts.get(tree.get(file).blob) ?? '');
        for (const id of global ? screens.map((s) => s.id) : screensOver(file, walk.importers, rootScreens)) if (!reached.has(id)) reached.set(id, file);
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
