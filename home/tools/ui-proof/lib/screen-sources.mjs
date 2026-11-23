// Purpose: the screen sources of a project at a commit: router files and the files they link (React Router, Vue Router, Angular),
// the app shell around every route, Next `app/` and `pages/`, Storybook stories, ui-coverage matrices and the urls e2e specs open.
// Exports: E2E_CONFIG, MATRIX, MAX_URLS, NEXT_CONFIG, STORY, e2eEntries, matrixScreens, nextScreens, routerScreens, shellFiles,
// storyScreen.
// A router screen names the file that declares it (`router`): reach never walks from a router file into a route component, since
// that file renders the component on its own route only. Routes that cannot be followed or named give a line, never a silent drop.
// Invariants (F4): project text is tokenised or matched, never evaluated; link depth, url counts and kept strings are capped.
import path from 'node:path';
import { TEST_FILE } from './reach.mjs';
import { MAX_ROUTE_CHARS, SELF, bindingsOf, compose, declaredRoutes, fileRoutes, lineAt } from './route-parse.mjs';

export const MAX_URLS = 20;
export const E2E_CONFIG = /(?:^|\/)(?:playwright|cypress)\.config\.[cm]?[jt]s$/;
export const STORY = /\.stories\.(?:[cm]?[jt]sx?|mdx)$/;
export const MATRIX = /(?:^|\/)[^/]*matrix[^/]*\.json$/i;
export const NEXT_CONFIG = /(?:^|\/)next\.config\.[cm]?[jt]s$/;
const MAX_LINK_DEPTH = 6;
const posix = path.posix;
const ROUTER_LIB = /['"](react-router(?:-dom)?|@remix-run\/router|vue-router|@angular\/router)['"]/;
const ROOT_MARKER = /\b(?:BrowserRouter|HashRouter|MemoryRouter|StaticRouter|create(?:Browser|Hash|Memory)Router|RouterProvider|forRoot|provideRouter|createRouter|VueRouter)\b/;
const PAGE_EXT = /\.(?:[jt]sx?|mdx)$/;
const LOCAL_HOST = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?=\/|$)/;
// The app shell: a render entry (React, Vue, Angular) or a file that renders the router outlet.
const SHELL_MARKER = /\b(?:createRoot|hydrateRoot|ReactDOM\.render|createApp|createSSRApp|bootstrapApplication|bootstrapModule)\s*\(|<(?:router-view|RouterView|router-outlet|RouterProvider)\b|\bRouterOutlet\b/;

/**
 * Router files (and the files they link with a prefix) -> route screens ({route, expr, where, router, component, wraps, source}),
 * the root router files, and problem lines for routes that cannot be followed or named (`unresolved:`, `unread:`, `capped:`).
 * @param {{candidates: string[], texts: Map<string,string>, resolve: Function, readMore: (file: string) => string|null,
 *   late: () => boolean}} input late: true once the time budget is spent (no further file is visited)
 */
export function routerScreens({ candidates, texts, resolve, readMore, late }) {
  const parsed = new Map();
  const linked = new Set();
  const problems = [];
  const refTarget = (file, ref, bindings) => {
    const spec = ref.spec ?? bindings.get(ref.name);
    if (spec === SELF) return { kind: 'file', file };
    if (typeof spec === 'string') return resolve(file, spec);
    return ref.direct ? { kind: 'missing', why: `${ref.name} in ${file} is bound by no import or declaration` } : { kind: 'none' };
  };
  const wrapsOf = (file, wraps, bindings, where) => wraps.flatMap((wrap) => {
    const target = wrap.file ? { kind: 'file', file: wrap.file } : refTarget(file, wrap, bindings);
    if (target.kind === 'missing') problems.push(`unresolved: ${target.why} (a route wrap at ${where})`);
    return target.kind === 'file' ? [target.file] : [];
  });
  const visit = ({ file, ctx, depth, from, name }) => {
    const key = `${file}\0${ctx.prefix}\0${JSON.stringify(ctx.wraps)}`;
    if (parsed.has(key) || late()) return;
    if (depth > MAX_LINK_DEPTH) { problems.push(`capped: route links from ${from} pass ${MAX_LINK_DEPTH} files (${file} not read)`); return; }
    const text = texts.get(file) ?? readMore(file);
    if (text === null) { problems.push(`unread: ${file}, whose routes ${from} links, is not read`); return; }
    const bindings = bindingsOf(text);
    const result = fileRoutes(file, text, ctx);
    parsed.set(key, { file, text, bindings, screens: result.screens, source: sourceOf(text), asRoot: depth === 0 });
    const here = { file, text, bindings, tree: result.tree };
    const held = name ? declaredRoutes({ ...here, name, ctx }) : null; // the routes the linked name holds (`[...a, ...b]`)
    problems.push(...result.problems, ...(held?.problems ?? []));
    for (const link of [...result.links, ...(held?.links ?? [])]) follow(here, link, depth);
  };
  const follow = (here, link, depth) => {
    const { file, text, bindings } = here;
    const where = `${file}:${lineAt(text, link.at)}`;
    const ctx = { ...link.ctx, wraps: wrapsOf(file, link.ctx.wraps, bindings, where).map((f) => ({ file: f })) };
    const spec = link.ref.spec ?? bindings.get(link.ref.name);
    if (typeof spec === 'string') {
      const target = resolve(file, spec);
      if (target.kind !== 'file') problems.push(`unresolved: the routes ${JSON.stringify(spec)} linked at ${where} cannot be followed (${target.why ?? 'a package'})`);
      else if (target.file !== file) { linked.add(target.file); visit({ file: target.file, ctx, depth: depth + 1, from: where, name: link.ref.name }); }
      return;
    }
    if (depth >= MAX_LINK_DEPTH) { problems.push(`capped: route links from ${where} pass ${MAX_LINK_DEPTH} names`); return; }
    const held = declaredRoutes({ ...here, name: link.ref.name, ctx }); // a name of this file: what its declaration holds
    if (held === null && spec !== SELF) problems.push(`unresolved: the routes ${JSON.stringify(link.ref.name)} at ${where} are bound by no import or declaration`);
    problems.push(...(held?.problems ?? []));
    for (const next of held?.links ?? []) follow(here, next, depth + 1);
  };
  const rootFiles = [];
  for (const file of candidates.filter((f) => ROUTER_LIB.test(texts.get(f) ?? ''))) {
    const root = ROOT_MARKER.test(texts.get(file));
    if (root) rootFiles.push(file);
    visit({ file, ctx: { prefix: root ? '/' : null, expr: root ? null : 'a relative path under a parent route that is not known', wraps: [] }, depth: 0, from: file });
  }
  const screens = [...parsed.values()].filter((entry) => !(entry.asRoot && linked.has(entry.file))).flatMap((entry) => toScreens(entry, refTarget, wrapsOf, problems));
  return { screens, rootFiles, problems: [...new Set(problems)] };
}

const sourceOf = (text) => ({ 'vue-router': 'vue-router', '@angular/router': 'angular' })[ROUTER_LIB.exec(text)?.[1]] ?? 'react-router';

/**
 * Raw routes of one parsed file -> screens with repo files (the last resolved reference is the component, the rest wrap it). A
 * route whose component cannot be named keeps its screen with the router file as component (the walk from it meets the same
 * unresolvable import, so reach is `all`) and adds an `unresolved:` line; a route of package elements only (a redirect) is none.
 */
function toScreens({ file, text, bindings, screens, source }, refTarget, wrapsOf, problems) {
  return screens.flatMap((raw) => {
    const where = `${file}:${lineAt(text, raw.at)}`;
    const targets = raw.refs.map((ref) => refTarget(file, ref, bindings));
    const files = targets.filter((t) => t.kind === 'file').map((t) => t.file);
    const missing = targets.filter((t) => t.kind === 'missing');
    problems.push(...missing.map((t) => `unresolved: ${t.why} (the route at ${where})`));
    if (files.length === 0 && missing.length === 0) return [];
    const wraps = wrapsOf(file, raw.wraps, bindings, where);
    return [{ route: raw.route, expr: raw.expr, where, router: file, component: files.at(-1) ?? file, wraps: [...new Set([...wraps, ...files.slice(0, -1)])], source }];
  });
}

/**
 * The app shell: files rendered around every route (root router files, render entries such as `createRoot`/`createApp`/
 * `bootstrapApplication`, files that render the router outlet), less tests, stories and route files. They wrap every router screen.
 */
export function shellFiles({ candidates, texts, rootFiles, routeFiles }) {
  const marked = candidates.filter((f) => SHELL_MARKER.test(texts.get(f) ?? '') && !routeFiles.has(f) && !TEST_FILE.test(f) && !STORY.test(f));
  return [...new Set([...rootFiles, ...marked])].sort();
}
const firstOf = (tree, base, names) => names.flatMap((name) => ['.tsx', '.ts', '.jsx', '.js'].map((ext) => `${base}${name}${ext}`)).filter((f) => tree.has(f));

/** Next.js folders (a next.config or a package.json naming `next`) -> page screens with their layouts (app) or _app/_document (pages). */
export function nextScreens(tree, texts) {
  const roots = new Set([...tree.keys()].filter((f) => NEXT_CONFIG.test(f)).map((f) => posix.dirname(f)));
  for (const [file, text] of texts) if (file.endsWith('package.json') && /"next"\s*:/.test(text)) roots.add(posix.dirname(file));
  const files = [...tree.keys()];
  return [...roots].flatMap((root) => {
    const base = root === '.' ? '' : `${root}/`;
    return [...['app/', 'src/app/'].flatMap((dir) => appPages(tree, files, base + dir)), ...['pages/', 'src/pages/'].flatMap((dir) => pagesRoutes(tree, files, base + dir))];
  });
}

function appPages(tree, files, dir) {
  return files.filter((f) => f.startsWith(dir) && /(?:^|\/)page\.(?:[jt]sx?|mdx)$/.test(f.slice(dir.length))).flatMap((file) => {
    const segments = file.slice(dir.length).split('/').slice(0, -1);
    if (segments.some((s) => s.startsWith('_') || /^\(\.{1,3}\)/.test(s))) return []; // private folders, intercepting routes
    const route = compose(null, `/${segments.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@')).join('/')}`);
    const wraps = segments.map((_, i) => `${dir}${segments.slice(0, i).map((s) => `${s}/`).join('')}`).concat(`${dir}${segments.map((s) => `${s}/`).join('')}`)
      .flatMap((folder) => firstOf(tree, folder, ['layout', 'template'])).filter((f) => f !== file);
    return [{ route, expr: null, where: file, component: file, wraps: [...new Set(wraps)], source: 'next' }];
  });
}

function pagesRoutes(tree, files, dir) {
  const wraps = firstOf(tree, dir, ['_app', '_document']);
  return files.filter((f) => f.startsWith(dir) && PAGE_EXT.test(f)).flatMap((file) => {
    const rel = file.slice(dir.length);
    if (rel.startsWith('api/') || rel.split('/').some((s) => s.startsWith('_'))) return [];
    return [{ route: compose(null, `/${rel.replace(PAGE_EXT, '').replace(/(?:^|\/)index$/, '')}`), expr: null, where: file, component: file, wraps, source: 'next' }];
  });
}

/** A Storybook story file -> one screen; urls `iframe.html?id=<title>--<story>` when the title is a literal. */
export function storyScreen(file, text) {
  const storyId = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const title = /\btitle\s*:\s*(['"`])([^'"`\n]{1,200})\1/.exec(text)?.[2];
  const names = [...text.matchAll(/\bexport\s+const\s+([A-Z][\w$]*)/g)].map((m) => m[1]);
  const urls = title ? names.slice(0, MAX_URLS).map((name) => `/iframe.html?id=${storyId(title)}--${storyId(name)}`) : [];
  return { id: `story:${file}`, route: null, router: null, component: file, wraps: [], urls, frames: [], source: 'story' };
}

/** A committed ui-coverage matrix -> one screen per surface with mountedAt files (component and wraps) and its Figma frames. */
export function matrixScreens(file, text, tree) {
  let matrix = null;
  try { matrix = JSON.parse(text); } catch { return []; } // a JSON file named *matrix* that does not parse is not a matrix
  if (!Array.isArray(matrix?.surfaces) || !Array.isArray(matrix?.cells)) return [];
  const root = posix.join(posix.dirname(file), typeof matrix.root === 'string' ? matrix.root : '.');
  const frames = Array.isArray(matrix.frames) ? matrix.frames : [];
  return matrix.surfaces.filter((surface) => typeof surface?.id === 'string').flatMap((surface) => {
    const mounts = (Array.isArray(surface.controls) ? surface.controls : []).map((c) => /^(.+):\d+$/.exec(typeof c?.mountedAt === 'string' ? c.mountedAt : '')?.[1])
      .filter(Boolean).map((f) => posix.normalize(posix.join(root, f))).filter((f) => tree.has(f));
    const unique = [...new Set(mounts)];
    if (unique.length === 0) return [];
    const nodes = frames.filter((frame) => Array.isArray(frame?.cells) && frame.cells.some((c) => c?.surface === surface.id)).map((frame) => String(frame.node));
    return [{ id: `matrix:${surface.id}`, route: null, router: null, component: unique[0], wraps: unique.slice(1), urls: [], frames: nodes, source: 'matrix' }];
  });
}

/** The url path an e2e spec opens (`page.goto(x)`, `cy.visit(x)`): literals, a const of the file, `${base}path`; local hosts only. */
function urlOf(arg, consts, base) {
  const literal = /^(['"`])(.*)\1$/.exec(arg);
  let value = literal ? literal[2] : /^[\w$]+$/.test(arg) ? consts.get(arg) : undefined;
  if (value === undefined) return null;
  value = value.replace(/^\$\{[^}]*\}/, '');
  if (value.includes('${')) return null;
  if (/^https?:\/\//.test(value)) {
    const host = LOCAL_HOST.exec(value);
    if (!host) return null;
    value = value.slice(host[0].length) || '/';
  }
  try {
    const url = new URL(value, `http://screen.invalid${base}`);
    return `${url.pathname}${url.search}`.slice(0, MAX_ROUTE_CHARS);
  } catch {
    return null; // not a url: nothing to open
  }
}

/** Every url the e2e files open: [{url, spec}]; a relative url joins the nearest Playwright/Cypress baseURL path. */
export function e2eEntries(files, texts) {
  const bases = new Map();
  for (const [file, text] of texts) {
    const found = E2E_CONFIG.test(file) && /\bbase(?:URL|Url)\s*:[^\n]{0,200}?(['"`])(?:https?:\/\/[^'"`\n/]+)?(\/[^'"`\n]*)?\1/.exec(text);
    if (found) bases.set(posix.dirname(file), (found[2] ?? '/').replace(/\/?$/, '/'));
  }
  const baseOf = (file) => { for (let dir = posix.dirname(file); ; dir = posix.dirname(dir)) { if (bases.has(dir)) return bases.get(dir); if (dir === '.') return '/'; } };
  return files.flatMap((spec) => {
    const text = texts.get(spec) ?? '';
    const consts = new Map([...text.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*(['"`])([^'"`\n]{1,300})\2/g)].map((m) => [m[1], m[3]]));
    return [...text.matchAll(/\b(?:page\.goto|cy\.visit)\s*\(\s*([^,)\n]{1,300})/g)].map((m) => urlOf(m[1].trim(), consts, baseOf(spec))).filter(Boolean).map((url) => ({ url, spec }));
  });
}
