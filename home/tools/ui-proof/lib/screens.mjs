// Purpose: the screens of a frontend project, inferred at a commit from the project itself, with no per-project setup (R22): Next
// `app/` and `pages/`, React Router (`createBrowserRouter` objects, `<Route path>`), Vue Router `routes`, Angular `Routes`,
// ui-coverage matrices (`mountedAt` files, Figma frames), Storybook stories and e2e specs (`page.goto`, `cy.visit`), which also give
// the values of dynamic segments. Exports: NO_VALUE, isComplete, inferScreens.
// A screen: {id, route (null: not a literal path), component, wraps (files rendered around it: layouts, parent routes), urls,
// frames, source}; `wraps` is an addition to the spec's interface (reach walks from it too). `unresolved` lines: a `no value: ` line
// is a screen with no known url (the plan gives it the visual plan); every other line (`unread:`, `capped:`, `unmatched:` (an e2e
// url that fits no route while every route has a value), `incomplete:`) means the list may miss screens: render every inferred route.
// Invariants (P1-P3, P8, P16, F3-F5): files are read at the commit with git plumbing (ls-tree, cat-file; `git grep` on the tree finds
// router candidates), nothing is checked out, run or written in the project; reads, lines and counts are capped; project text is
// tokenised, never evaluated. The cache is one JSON file per repository under ~/.claude/state/ui-screens (UI_SCREENS_STATE_DIR
// overrides), keyed by the real git common dir and the blob ids of every file read; a corrupt or foreign file is ignored and replaced
// atomically; an incomplete inference is not cached.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configFiles, gitRun, makeResolver, readBlobs, readTree } from './reach.mjs';

export const NO_VALUE = 'no value: ';
const CACHE_FORMAT = 'ui-screens/1';
const INFER_BUDGET_MS = 30_000;
const MAX_READ_BYTES = 1 << 20;
const MAX_CANDIDATES = 3000;
const MAX_SCREENS = 3000;
const MAX_URLS = 20;
const MAX_ROUTE_CHARS = 300;
const MAX_TEXT_CHARS = 120;
const MAX_DEPTH = 64;
const MAX_LINK_DEPTH = 6;
const MAX_CACHE_ENTRIES = 8;
const NAME_HASH_CHARS = 16;
const posix = path.posix;
const SOURCE_SPECS = ['*.js', '*.jsx', '*.ts', '*.tsx', '*.mjs', '*.cjs', '*.mts', '*.cts', '*.vue', ':(exclude)*.d.ts'];
const GREP_WORDS = ['createBrowserRouter', 'createHashRouter', 'createMemoryRouter', 'useRoutes', '<Route', 'Routes', 'createRouter',
  'VueRouter', 'RouterModule', 'provideRouter', 'page\\.goto', 'cy\\.visit'];
const ROUTER_LIB = /['"](react-router(?:-dom)?|@remix-run\/router|vue-router|@angular\/router)['"]/;
const ROOT_MARKER = /\b(?:BrowserRouter|HashRouter|MemoryRouter|StaticRouter|create(?:Browser|Hash|Memory)Router|RouterProvider|forRoot|provideRouter|createRouter|VueRouter)\b/;
const ROUTER_CALLS = new Set(['createBrowserRouter', 'createHashRouter', 'createMemoryRouter', 'useRoutes', 'forRoot', 'forChild', 'provideRouter']);
const REF_KEYS = ['element', 'component', 'Component', 'lazy', 'loadComponent'];
const ROUTE_KEYS = new Set([...REF_KEYS, 'children', 'loadChildren', 'redirectTo', 'redirect', 'index']);
const E2E_FILE = /(?:^|\/)(?:e2e|cypress|playwright|tests?|__tests__)\/|\.(?:spec|test|cy)\.[cm]?[jt]sx?$/;
const E2E_CONFIG = /(?:^|\/)(?:playwright|cypress)\.config\.[cm]?[jt]s$/;
const STORY = /\.stories\.(?:[cm]?[jt]sx?|mdx)$/;
const MATRIX = /(?:^|\/)[^/]*matrix[^/]*\.json$/i;
const NEXT_CONFIG = /(?:^|\/)next\.config\.[cm]?[jt]s$/;
const PAGE_EXT = /\.(?:[jt]sx?|mdx)$/;
const LOCAL_HOST = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?=\/|$)/;
const TOKEN = /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|(['"])((?:(?!\1)[^\\\n]|\\.)*)\1|`((?:[^`\\]|\\.)*)`|([\w$]+)|(\S)/g;
const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);
const SELF = Symbol('declared in this file');

const stateDirOf = (env) => env.UI_SCREENS_STATE_DIR ?? path.join(env.HOME || env.USERPROFILE || os.homedir(), '.claude', 'state', 'ui-screens');
const quote = (text) => JSON.stringify(String(text).slice(0, MAX_TEXT_CHARS));
const lineAt = (text, at) => text.slice(0, at).split('\n').length;

/** Tokens of JS/TS text, comments dropped; brackets nested into nodes {open, items, at} (depth capped). */
function parse(text) {
  const root = { open: '', items: [], at: 0 };
  const stack = [root];
  let flat = 0;
  for (const m of text.slice(0, MAX_READ_BYTES).matchAll(TOKEN)) {
    if (m[0].startsWith('//') || m[0].startsWith('/*')) continue;
    const token = m[2] !== undefined ? { t: 'str', v: m[2].replace(/\\(.)/g, '$1') } : m[3] !== undefined ? { t: m[3].includes('${') ? 'expr' : 'str', v: m[3] }
      : m[4] ? { t: 'id', v: m[4] } : { t: 'p', v: m[5] };
    token.at = m.index;
    if (token.t === 'p' && OPEN.has(token.v) && stack.length < MAX_DEPTH) { const node = { open: token.v, items: [], at: m.index }; stack.at(-1).items.push(node); stack.push(node); }
    else if (token.t === 'p' && OPEN.has(token.v)) flat += 1;
    else if (token.t === 'p' && CLOSE.has(token.v) && flat > 0) flat -= 1;
    else if (token.t === 'p' && CLOSE.has(token.v)) { if (stack.length > 1) stack.pop(); }
    else stack.at(-1).items.push(token);
  }
  return root;
}

const textOf = (items) => items.map((i) => (i.items ? `${i.open}${textOf(i.items)}` : i.t === 'str' ? JSON.stringify(i.v) : i.t === 'expr' ? `\`${i.v}\`` : i.v)).join(' ');
const literalOf = (items) => {
  const inner = items.length === 1 && items[0].items && items[0].open === '{' ? items[0].items : items;
  return inner.length === 1 && inner[0].t === 'str' ? inner[0].v : null;
};

/** Object properties: key -> value items (shorthand `{ routes }` -> the key itself). */
function propsOf(node) {
  const props = new Map();
  let part = [];
  for (const item of [...node.items, { t: 'p', v: ',' }]) {
    if (item.t !== 'p' || item.v !== ',') { part.push(item); continue; }
    if ((part[0]?.t === 'id' || part[0]?.t === 'str') && part[1]?.t === 'p' && part[1].v === ':') props.set(part[0].v, part.slice(2));
    else if (part.length === 1 && part[0].t === 'id') props.set(part[0].v, part);
    part = [];
  }
  return props;
}

/** Component references in value items: `import('x')` specs and capitalised names (JSX tags, identifiers). */
function refsIn(items, out = []) {
  items.forEach((item, i) => {
    if (item.items) { if (!(items[i - 1]?.v === 'import' && item.items[0]?.t === 'str')) refsIn(item.items, out); return; }
    if (item.t === 'id' && item.v === 'import' && items[i + 1]?.items?.[0]?.t === 'str') out.push({ spec: items[i + 1].items[0].v });
    else if (item.t === 'id' && /^[A-Z]/.test(item.v) && items[i - 1]?.v !== '.') out.push({ name: item.v });
  });
  return out;
}

const compose = (prefix, own) => {
  if (!own.startsWith('/') && prefix === null) return null;
  const joined = own.startsWith('/') ? own : `${prefix.replace(/\/?\*$/, '')}/${own}`;
  return `/${joined}`.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1').slice(0, MAX_ROUTE_CHARS);
};

/** One route (object props or JSX attributes) in its parent context -> its screen (if it has a path and a component), links, child context. */
function routeRecord(props, ctx, at) {
  const pathItems = props.get('path');
  const isIndex = !pathItems && props.has('index');
  const literal = pathItems ? literalOf(pathItems) : null;
  const known = !pathItems || literal !== null;
  const route = known ? compose(ctx.prefix, literal ?? '') : null;
  const expr = known ? (route === null ? ctx.expr : null) : `path ${textOf(pathItems).slice(0, MAX_TEXT_CHARS)}`;
  const refs = REF_KEYS.flatMap((key) => (props.has(key) ? refsIn(props.get(key)) : []));
  const children = props.get('children');
  const linkRefs = [...(children?.length === 1 && children[0].t === 'id' ? [{ name: children[0].v }] : []), ...refsIn(props.get('loadChildren') ?? [])];
  const hasPath = Boolean(pathItems) || isIndex;
  const childCtx = { prefix: hasPath ? route : ctx.prefix, expr: hasPath ? expr : ctx.expr, wraps: [...ctx.wraps, ...refs] };
  return { screen: hasPath && refs.length > 0 ? { route, expr, at, refs, wraps: ctx.wraps } : null, links: linkRefs.map((ref) => ({ ref, ctx: childCtx })), childCtx };
}

/** Route objects anywhere in the tree (`{ path, element|component|children... }`), nested through `children`. */
function objectRoutes(node, ctx, out) {
  for (const item of node.items) {
    if (!item.items) continue;
    const props = item.open === '{' ? propsOf(item) : null;
    const isRoute = props && (props.has('path') || props.has('index')) && [...props.keys()].some((key) => ROUTE_KEYS.has(key));
    if (!isRoute) {
      const routes = props?.get('routes');
      if (routes?.length === 1 && routes[0].t === 'id') out.links.push({ ref: { name: routes[0].v }, ctx });
      objectRoutes(item, ctx, out);
      continue;
    }
    const record = routeRecord(props, ctx, item.at);
    if (record.screen) out.screens.push(record.screen);
    out.links.push(...record.links);
    const kids = props.get('children');
    if (kids?.[0]?.items) objectRoutes({ items: kids }, record.childCtx, out);
  }
}

/** The attributes of a JSX tag from `from` to its `>`: name -> value items. */
function tagAttrs(items, from) {
  const attrs = new Map();
  for (let j = from; j < items.length; j += 1) {
    const item = items[j];
    if (item.t === 'p' && item.v === '>') return { attrs, end: j, selfClosing: items[j - 1]?.v === '/' };
    if (item.t !== 'id') continue;
    if (items[j + 1]?.v === '=' && items[j + 2]) { attrs.set(item.v, [items[j + 2]]); j += 2; } else attrs.set(item.v, [{ t: 'id', v: 'true' }]);
  }
  return { attrs, end: items.length, selfClosing: true };
}

/** `<Route path element>` elements, nested by their open and close tags (inside `{...}` and `(...)` too). */
function jsxRoutes(items, ctx, out) {
  const stack = [ctx];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.items) { jsxRoutes(item.items, stack.at(-1), out); continue; }
    if (item.t !== 'p' || item.v !== '<') continue;
    if (items[i + 1]?.v === '/' && items[i + 2]?.v === 'Route') { if (stack.length > 1) stack.pop(); i += 2; continue; }
    if (items[i + 1]?.t !== 'id' || items[i + 1].v !== 'Route') continue;
    const { attrs, end, selfClosing } = tagAttrs(items, i + 2);
    const record = routeRecord(attrs, stack.at(-1), item.at);
    if (record.screen) out.screens.push(record.screen);
    out.links.push(...record.links);
    if (!selfClosing) stack.push(record.childCtx);
    i = end;
  }
}

/** Router calls with a routes identifier (`createBrowserRouter(routes)`, `RouterModule.forRoot(routes)`...) -> links. */
function callLinks(items, ctx, out) {
  items.forEach((item, i) => {
    if (item.items) { callLinks(item.items, ctx, out); return; }
    const args = items[i + 1];
    if (item.t === 'id' && ROUTER_CALLS.has(item.v) && args?.open === '(' && args.items[0]?.t === 'id') out.links.push({ ref: { name: args.items[0].v }, ctx });
  });
}

/** Names bound in a file: imports (-> spec), `const X = lazy(() => import('x'))` (-> spec), local capitalised declarations (SELF). */
function bindingsOf(text) {
  const names = new Map();
  for (const m of text.matchAll(/\b(?:function|class|const|let|var)\s+([A-Z][\w$]*)/g)) names.set(m[1], SELF);
  for (const m of text.matchAll(/\bimport\s+(?:type\s+)?([\w$]+)?\s*,?\s*(?:\{([^}]{0,4000})\}|\*\s+as\s+([\w$]+))?\s*from\s*(['"])([^'"\n]{1,500})\4/g)) {
    const named = (m[2] ?? '').split(',').map((part) => part.trim().split(/\s+as\s+/).at(-1).replace(/^type\s+/, '')).filter(Boolean);
    for (const name of [m[1], m[3], ...named].filter(Boolean)) names.set(name, m[5]);
  }
  for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Z][\w$]*)\s*(?::[^=\n]{0,200})?=\s*(?![[{])[^;]{0,300}?\bimport\s*\(\s*(['"])([^'"\n]{1,500})\2/g)) names.set(m[1], m[3]);
  return names;
}

/** Route screens and links of one router file. */
function fileRoutes(file, text, ctx) {
  const tree = parse(text);
  const out = { screens: [], links: [] };
  objectRoutes(tree, ctx, out);
  jsxRoutes(tree.items, ctx, out);
  callLinks(tree.items, ctx, out);
  return out;
}

/** Router files (and the files they link with a prefix) -> route screens; unresolved lines for what cannot be named. */
function routerScreens({ candidates, texts, resolve, readMore }) {
  const parsed = new Map();
  const linked = new Map(); // target file -> contexts it is rendered under
  const resolveRef = (file, ref, bindings) => {
    const spec = ref.spec ?? bindings.get(ref.name);
    if (spec === SELF) return file;
    const target = typeof spec === 'string' ? resolve(file, spec) : null;
    return target?.kind === 'file' ? target.file : null;
  };
  const visit = (file, ctx, depth) => {
    const text = texts.get(file) ?? readMore(file);
    if (text === null || depth > MAX_LINK_DEPTH) return;
    const bindings = bindingsOf(text);
    const result = fileRoutes(file, text, ctx);
    parsed.set(`${file}\0${ctx.prefix}\0${JSON.stringify(ctx.wraps)}`, { file, text, bindings, screens: result.screens, source: sourceOf(text), asRoot: depth === 0 });
    for (const { ref, ctx: linkCtx } of result.links) {
      const target = resolveRef(file, ref, bindings);
      if (!target || target === file) continue;
      linked.set(target, true);
      visit(target, { ...linkCtx, wraps: linkCtx.wraps.map((w) => w.file ?? resolveRef(file, w, bindings)).filter(Boolean).map((f) => ({ file: f })) }, depth + 1);
    }
  };
  const roots = candidates.filter((file) => ROUTER_LIB.test(texts.get(file) ?? ''));
  for (const file of roots) {
    const root = ROOT_MARKER.test(texts.get(file));
    visit(file, { prefix: root ? '/' : null, expr: root ? null : 'a relative path under a parent route that is not known', wraps: [] }, 0);
  }
  return [...parsed.values()].filter((entry) => !(entry.asRoot && linked.has(entry.file))).flatMap((entry) => toScreens(entry, resolveRef));
}

const sourceOf = (text) => ({ 'vue-router': 'vue-router', '@angular/router': 'angular' })[ROUTER_LIB.exec(text)?.[1]] ?? 'react-router';

/** Raw routes of one parsed file -> screens with repo files (the last resolved reference is the component, the rest wrap it). */
function toScreens({ file, text, bindings, screens, source }, resolveRef) {
  return screens.flatMap((raw) => {
    const files = raw.refs.map((ref) => resolveRef(file, ref, bindings)).filter(Boolean);
    if (files.length === 0) return [];
    const wraps = raw.wraps.map((w) => w.file ?? resolveRef(file, w, bindings)).filter(Boolean);
    const where = `${file}:${lineAt(text, raw.at)}`;
    return [{ route: raw.route, expr: raw.expr, where, component: files.at(-1), wraps: [...new Set([...wraps, ...files.slice(0, -1)])], source }];
  });
}

const firstOf = (tree, base, names) => names.flatMap((name) => ['.tsx', '.ts', '.jsx', '.js'].map((ext) => `${base}${name}${ext}`)).filter((f) => tree.has(f));

/** Next.js folders (a next.config or a package.json naming `next`) -> page screens with their layouts (app) or _app/_document (pages). */
function nextScreens(tree, texts) {
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
function storyScreen(file, text) {
  const storyId = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const title = /\btitle\s*:\s*(['"`])([^'"`\n]{1,200})\1/.exec(text)?.[2];
  const names = [...text.matchAll(/\bexport\s+const\s+([A-Z][\w$]*)/g)].map((m) => m[1]);
  const urls = title ? names.slice(0, MAX_URLS).map((name) => `/iframe.html?id=${storyId(title)}--${storyId(name)}`) : [];
  return { id: `story:${file}`, route: null, component: file, wraps: [], urls, frames: [], source: 'story' };
}

/** A committed ui-coverage matrix -> one screen per surface with mountedAt files (component and wraps) and its Figma frames. */
function matrixScreens(file, text, tree) {
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
    return [{ id: `matrix:${surface.id}`, route: null, component: unique[0], wraps: unique.slice(1), urls: [], frames: nodes, source: 'matrix' }];
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
function e2eEntries(files, texts) {
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

/** A route -> {regex, statics, dynamic}: `:id`, `[id]` one segment; `:id?` optional; `*`, `**`, `[...x]`, `:x(.*)*` any rest. */
function routePattern(route) {
  let source = '';
  let statics = 0;
  const segments = route.split('/').filter(Boolean);
  for (const segment of segments) {
    if (/^(?:\*\*?|\[\[?\.\.\..*\]\]?|:[\w$]+(?:\(.*\))?[*+])$/.test(segment)) source += '(?:/.*)?';
    else if (/^:[\w$]+\?$/.test(segment)) source += '(?:/[^/]+)?';
    else if (/^:[\w$]+(?:\(.*\))?$|^\[[^\]]+\]$/.test(segment)) source += '/[^/]+';
    else { source += `/${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`; statics += 1; }
  }
  return { regex: new RegExp(`^${source}/?$`), statics, dynamic: statics !== segments.length };
}

/** The route screens with their urls (static path, e2e values), plus e2e-only screens and the `no value` lines. */
function withUrls(routes, e2e) {
  const patterns = routes.map((s) => (s.route === null ? null : routePattern(s.route)));
  const urls = routes.map((s, i) => new Set(patterns[i] && !patterns[i].dynamic ? [s.route] : []));
  const unmatched = new Map();
  for (const { url, spec } of e2e) {
    const pathname = url.split(/[?#]/)[0];
    const fits = patterns.map((p, i) => (p && !(p.statics === 0 && p.dynamic) && p.regex.test(pathname) ? i : -1)).filter((i) => i >= 0);
    const best = Math.max(-1, ...fits.map((i) => patterns[i].statics));
    if (fits.length > 0) for (const i of fits.filter((j) => patterns[j].statics === best)) urls[i].add(url);
    else unmatched.set(pathname, { spec: unmatched.get(pathname)?.spec ?? spec, urls: new Set([...(unmatched.get(pathname)?.urls ?? []), url]) });
  }
  const screens = routes.map((s, i) => ({ id: `${s.source}:${s.route ?? s.component}`, route: s.route, component: s.component, wraps: s.wraps, urls: [...urls[i]].slice(0, MAX_URLS), frames: [], source: s.source }));
  const noValue = routes.flatMap((s, i) => (urls[i].size > 0 ? [] : [`${NO_VALUE}${s.route === null ? s.expr : quote(s.route)} (${s.component}, ${s.where})`]));
  const e2eScreens = [...unmatched].map(([pathname, entry]) => ({ id: `e2e:${pathname}`, route: pathname, component: entry.spec, wraps: [], urls: [...entry.urls].slice(0, MAX_URLS), frames: [], source: 'e2e' }));
  const missed = noValue.length === 0 ? [...unmatched.keys()].map((p) => `unmatched: the e2e url ${quote(p)} fits no inferred route`) : [];
  return { screens: [...screens, ...e2eScreens], unresolved: [...noValue, ...missed] };
}

/** Unique ids; Figma frames of a matrix surface also on the route screens whose component it mounts; capped count. */
function finish(screens, unresolved) {
  const seen = new Map();
  for (const screen of screens) {
    const n = seen.get(screen.id) ?? 0;
    seen.set(screen.id, n + 1);
    if (n > 0) screen.id = `${screen.id} #${n + 1}`;
  }
  for (const surface of screens.filter((s) => s.source === 'matrix')) {
    const files = new Set([surface.component, ...surface.wraps]);
    for (const screen of screens.filter((s) => s.source !== 'matrix' && files.has(s.component))) screen.frames = [...new Set([...screen.frames, ...surface.frames])];
  }
  const capped = screens.length > MAX_SCREENS ? [`capped: ${screens.length} screens, the first ${MAX_SCREENS} kept`] : [];
  return { screens: screens.slice(0, MAX_SCREENS).sort((a, b) => (a.id < b.id ? -1 : 1)), unresolved: [...unresolved, ...capped] };
}

/** The files the inference reads at a commit (router candidates found by `git grep` on the tree, stories, matrices, configs). */
function inputFiles(repoDir, sha, tree) {
  const problems = [];
  let hits = [];
  try {
    const args = ['-c', 'grep.fallbackToNoIndex=false', 'grep', '-l', '-z', '-I', '-E', '--no-color', ...GREP_WORDS.flatMap((w) => ['-e', w]), sha, '--', ...SOURCE_SPECS];
    hits = gitRun(repoDir, args, undefined, [0, 1]).toString('utf8').split('\0').filter(Boolean).map((entry) => entry.slice(sha.length + 1));
  } catch (error) {
    problems.push(`unread: the router search failed: ${error.message}`);
  }
  const all = [...tree.keys()];
  const cap = (list, what) => { if (list.length > MAX_CANDIDATES) problems.push(`capped: ${list.length} ${what}, the first ${MAX_CANDIDATES} read`); return list.slice(0, MAX_CANDIDATES); };
  const big = (f) => tree.get(f).size > MAX_READ_BYTES;
  const pick = (list) => { problems.push(...list.filter(big).map((f) => `unread: ${f} is over ${MAX_READ_BYTES} bytes`)); return list.filter((f) => !big(f)); };
  const candidates = pick(cap(hits.filter((f) => tree.has(f)), 'router and e2e files'));
  const stories = pick(cap(all.filter((f) => STORY.test(f)), 'story files'));
  const matrices = pick(cap(all.filter((f) => MATRIX.test(f)), 'matrix files'));
  const configs = pick([...configFiles(tree), ...all.filter((f) => E2E_CONFIG.test(f))]);
  const listed = all.filter((f) => NEXT_CONFIG.test(f) || /(?:^|\/)(?:app|pages)\/.+\.(?:[jt]sx?|mdx)$/.test(f));
  return { candidates, stories, matrices, read: [...new Set([...candidates, ...stories, ...matrices, ...configs])], listed, problems };
}

/** Infer from the read inputs. @returns {{screens: object[], unresolved: string[], extra: Record<string,string>}} */
function inferAt({ repoDir, tree, inputs, started }) {
  const blobs = readBlobs(repoDir, inputs.read.map((f) => tree.get(f).blob));
  const texts = new Map(inputs.read.map((f) => [f, blobs.get(tree.get(f).blob) ?? '']));
  const resolve = makeResolver(tree, new Map(configFiles(tree).map((f) => [f, texts.get(f) ?? ''])));
  const extra = {};
  const readMore = (file) => {
    const entry = tree.get(file);
    if (!entry || entry.size > MAX_READ_BYTES || !/\.(?:[cm]?[jt]sx?|vue)$/.test(file)) return null;
    extra[file] = entry.blob;
    return readBlobs(repoDir, [entry.blob]).get(entry.blob) ?? null;
  };
  const routes = [...nextScreens(tree, texts), ...routerScreens({ candidates: inputs.candidates, texts, resolve, readMore })];
  const e2e = e2eEntries(inputs.candidates.filter((f) => /\b(?:page\.goto|cy\.visit)\s*\(/.test(texts.get(f))), texts);
  const routed = withUrls(routes, e2e);
  const others = [...inputs.stories.map((f) => storyScreen(f, texts.get(f))), ...inputs.matrices.flatMap((f) => matrixScreens(f, texts.get(f), tree))];
  const late = Date.now() - started > INFER_BUDGET_MS ? [`incomplete: the inference passed its ${INFER_BUDGET_MS / 1000} s budget`] : [];
  const { screens, unresolved } = finish([...routed.screens, ...others], [...inputs.problems, ...routed.unresolved, ...late]);
  return { screens, unresolved, extra };
}

const hashOf = (lines) => crypto.createHash('sha256').update(lines.join('\n')).digest('hex');

/** The cache file of the repository (worktrees of one clone share it: keyed by the real git common dir). */
function cacheFile(repoDir, stateDir) {
  const common = fs.realpathSync.native(gitRun(repoDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']).toString('utf8').trim());
  const repo = path.basename(path.dirname(common)).replace(/[^A-Za-z0-9_.-]/g, '-');
  return { file: path.join(stateDir, `${repo}-${hashOf([common]).slice(0, NAME_HASH_CHARS)}.json`), common };
}

/** The cache entries; a missing, corrupt or foreign file reads as none (it is rewritten on the next save). */
function readCache({ file, common }) {
  try {
    if (!fs.lstatSync(file).isFile()) return [];
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (json?.format !== CACHE_FORMAT || json.commonDir !== common || !Array.isArray(json.entries)) return [];
    return json.entries.filter((e) => typeof e?.key === 'string' && e.extra && typeof e.extra === 'object' && Array.isArray(e.screens) && Array.isArray(e.unresolved));
  } catch {
    return []; // no cache yet, or one that cannot be read: a miss, never a failure
  }
}

/** Save an entry (newest first, MAX_CACHE_ENTRIES kept) by an atomic replace with a temp name unique to this process. */
function writeCache(store, entry) {
  const entries = [entry, ...readCache(store).filter((e) => e.key !== entry.key)].slice(0, MAX_CACHE_ENTRIES);
  fs.mkdirSync(path.dirname(store.file), { recursive: true, mode: 0o700 });
  const temp = `${store.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ format: CACHE_FORMAT, commonDir: store.common, entries })}\n`, { mode: 0o600 });
  fs.renameSync(temp, store.file);
}

/** True when the screen list is complete: every unresolved line is a `no value` line (else render every inferred route). */
export const isComplete = (unresolved) => unresolved.every((line) => line.startsWith(NO_VALUE));

/**
 * The screens of the project at `rev`, from the cache when no file it read has changed.
 * @param {{repoDir: string, rev: string, stateDir?: string}} input stateDir default: UI_SCREENS_STATE_DIR or ~/.claude/state/ui-screens
 * @returns {{screens: {id: string, route: string|null, component: string, wraps: string[], urls: string[], frames: string[],
 *   source: 'next'|'react-router'|'vue-router'|'angular'|'matrix'|'story'|'e2e'}[], unresolved: string[], cached: boolean}}
 *   never throws: an unreadable repo or rev gives no screens and one `unread:` line
 */
export function inferScreens({ repoDir, rev, stateDir = stateDirOf(process.env) }) {
  const started = Date.now();
  try {
    if (typeof rev !== 'string' || rev === '' || rev.startsWith('-')) throw new Error(`bad rev ${quote(rev)}`);
    const sha = gitRun(repoDir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).toString('utf8').trim();
    const tree = readTree(repoDir, sha);
    const inputs = inputFiles(repoDir, sha, tree);
    const key = hashOf([CACHE_FORMAT, ...inputs.listed, ...inputs.read.map((f) => `${f}\0${tree.get(f).blob}`), ...inputs.problems]);
    const store = cacheFile(repoDir, stateDir);
    const hit = readCache(store).find((e) => e.key === key && Object.entries(e.extra).every(([f, blob]) => tree.get(f)?.blob === blob));
    if (hit) return { screens: hit.screens, unresolved: hit.unresolved, cached: true };
    const { screens, unresolved, extra } = inferAt({ repoDir, tree, inputs, started });
    if (unresolved.some((line) => line.startsWith('incomplete:'))) return { screens, unresolved, cached: false };
    try {
      writeCache(store, { key, extra, screens, unresolved, createdAt: new Date().toISOString() });
    } catch (error) {
      return { screens, unresolved: [...unresolved, `incomplete: the cache was not saved (${error.message})`], cached: false };
    }
    return { screens, unresolved, cached: false };
  } catch (error) {
    return { screens: [], unresolved: [`unread: ${error.message}`], cached: false };
  }
}
