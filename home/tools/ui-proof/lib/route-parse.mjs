// Purpose: route declarations read from the text of one router file: a bracket-nesting tokenizer (comments dropped, strings kept),
// route objects (`{ path, element|component|children... }`), `<Route path element>` elements, router calls that name a routes
// list, the names a file binds (imports, lazy imports, local declarations) and the routes a declared name holds. Exports:
// MAX_READ_BYTES, MAX_ROUTE_CHARS, MAX_TEXT_CHARS, SELF, compose, lineAt, bindingsOf, declaredRoutes, fileRoutes.
// A routes value is followed when it is a name (a link), an array literal (its `...name` spreads become links) or JSX `<Route>`;
// any other value (a call, a member, an expression) gives an `unresolved:` problem line, never a silent drop.
// Invariants (F4): project text is tokenised, never evaluated; the text read, the nesting depth and every kept string are capped.
export const MAX_READ_BYTES = 1 << 20;
export const MAX_ROUTE_CHARS = 300;
export const MAX_TEXT_CHARS = 120;
const MAX_DEPTH = 64;
const ROUTER_CALLS = new Set(['createBrowserRouter', 'createHashRouter', 'createMemoryRouter', 'useRoutes', 'forRoot', 'forChild', 'provideRouter']);
const MODULE_CALLS = new Set(['forRoot', 'forChild']); // Angular: only RouterModule's hold routes
const REF_KEYS = ['element', 'component', 'Component', 'lazy', 'loadComponent'];
const ROUTE_KEYS = new Set([...REF_KEYS, 'children', 'loadChildren', 'redirectTo', 'redirect', 'index']);
const LITERAL_WORDS = /^(?:true|false|null|undefined|\d[\w.]*)$/;
const DECLARE = new Set(['const', 'let', 'var']);
const STATEMENT = new Set(['const', 'let', 'var', 'export', 'import', 'function', 'class', 'return']);
const TOKEN = /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|(['"])((?:(?!\1)[^\\\n]|\\.)*)\1|`((?:[^`\\]|\\.)*)`|([\w$]+)|(\S)/g;
const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);
/** The binding of a name declared in the file itself. */
export const SELF = Symbol('declared in this file');

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
/**
 * Component references in value items: `import('x')` specs and capitalised names; `direct` marks a name that is the value itself
 * or a JSX tag (a component), not a word of JSX text or an argument.
 */
function refsIn(items, out = []) {
  items.forEach((item, i) => {
    if (item.items) { if (!(items[i - 1]?.v === 'import' && item.items[0]?.t === 'str')) refsIn(item.items, out); return; }
    if (item.t === 'id' && item.v === 'import' && items[i + 1]?.items?.[0]?.t === 'str') out.push({ spec: items[i + 1].items[0].v });
    else if (item.t === 'id' && /^[A-Z]/.test(item.v) && items[i - 1]?.v !== '.') out.push({ name: item.v, direct: items.length === 1 || items[i - 1]?.v === '<' });
  });
  return out;
}

export const compose = (prefix, own) => {
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
  const hasPath = Boolean(pathItems) || isIndex;
  const childCtx = { prefix: hasPath ? route : ctx.prefix, expr: hasPath ? expr : ctx.expr, wraps: [...ctx.wraps, ...refs] };
  const links = refsIn(props.get('loadChildren') ?? []).map((ref) => ({ ref, ctx: childCtx, at }));
  return { screen: hasPath && refs.length > 0 ? { route, expr, at, refs, wraps: ctx.wraps } : null, links, childCtx };
}

const isRouteProps = (props) => props !== null && (props.has('path') || props.has('index')) && [...props.keys()].some((key) => ROUTE_KEYS.has(key));
const isDots = (items, i) => items[i]?.v === '.' && items[i + 1]?.v === '.' && items[i + 2]?.v === '.' && items[i - 1]?.v !== '.';
const hasJsxRoute = (items) => items.some((item, i) => (item.items ? hasJsxRoute(item.items) : item.v === '<' && items[i + 1]?.v === 'Route'));

/** `...name` spreads of a routes array -> links (each array once); a spread of anything else cannot be followed. */
function spreadLinks(node, ctx, out) {
  if (out.seen.has(node)) return;
  out.seen.add(node);
  node.items.forEach((item, i) => {
    if (!isDots(node.items, i)) return;
    const [target, after] = [node.items[i + 3], node.items[i + 4]];
    if (target?.t === 'id' && (!after || after.v === ',')) out.links.push({ ref: { name: target.v }, ctx, at: item.at });
    else out.problems.push({ at: item.at, what: `a spread of routes (${textOf(node.items.slice(i, i + 6)).slice(0, MAX_TEXT_CHARS)})` });
  });
}

/**
 * A value that holds routes (a router call's argument, `routes:`, `children:`, a linked declaration): a name is linked, an array
 * literal has its spreads linked, JSX `<Route>` elements are read where they stand; anything else (a call, a member, an
 * expression) cannot be followed and gives a problem.
 */
function routeList(items, ctx, out, at, what) {
  const cut = items.findIndex((item) => item.t === 'id' && (item.v === 'as' || item.v === 'satisfies'));
  const value = cut > 0 ? items.slice(0, cut) : items;
  const only = value.length === 1 ? value[0] : null;
  if (value.length === 0 || only?.open === '{' || only?.t === 'str' || (only?.t === 'id' && LITERAL_WORDS.test(only.v))) return;
  if (only?.t === 'id') out.links.push({ ref: { name: only.v }, ctx, at });
  else if (only?.open === '[') spreadLinks(only, ctx, out);
  else if (!hasJsxRoute(value)) out.problems.push({ at, what: `${what} (${textOf(value).slice(0, MAX_TEXT_CHARS)})` });
}

/** Route objects anywhere in the tree (`{ path, element|component|children... }`), nested through `children`. */
function objectRoutes(node, ctx, out) {
  const objects = node.items.filter((item) => item.items).map((item) => ({ item, props: item.open === '{' ? propsOf(item) : null }));
  if (node.open === '[' && objects.some(({ props }) => isRouteProps(props))) spreadLinks(node, ctx, out);
  for (const { item, props } of objects) {
    if (!isRouteProps(props)) {
      if (props?.has('routes')) routeList(props.get('routes'), ctx, out, item.at, 'the routes list');
      objectRoutes(item, ctx, out);
      continue;
    }
    const record = routeRecord(props, ctx, item.at);
    if (record.screen) out.screens.push(record.screen);
    out.links.push(...record.links);
    const kids = props.get('children') ?? [];
    routeList(kids, record.childCtx, out, item.at, 'the children of a route');
    if (kids.length === 1 && kids[0].open === '[') objectRoutes(kids[0], record.childCtx, out);
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

/** Router calls (`createBrowserRouter(x)`, `useRoutes(x)`, `RouterModule.forRoot(x)`...): their first argument holds the routes. */
function callLinks(items, ctx, out) {
  items.forEach((item, i) => {
    if (item.items) { callLinks(item.items, ctx, out); return; }
    const args = items[i + 1];
    if (item.t !== 'id' || !ROUTER_CALLS.has(item.v) || args?.open !== '(') return;
    if (MODULE_CALLS.has(item.v) && items[i - 2]?.v !== 'RouterModule') return; // `StoreModule.forRoot(x)` names no routes
    const comma = args.items.findIndex((arg) => arg.t === 'p' && arg.v === ',');
    routeList(comma < 0 ? args.items : args.items.slice(0, comma), ctx, out, item.at, `the routes of ${item.v}`);
  });
}

/** Names bound in a file: imports (-> spec), `const X = lazy(() => import('x'))` (-> spec), local capitalised declarations (SELF). */
export function bindingsOf(text) {
  const names = new Map();
  for (const m of text.matchAll(/\b(?:function|class|const|let|var)\s+([A-Z][\w$]*)/g)) names.set(m[1], SELF);
  for (const m of text.matchAll(/\bimport\s+(?:type\s+)?([\w$]+)?\s*,?\s*(?:\{([^}]{0,4000})\}|\*\s+as\s+([\w$]+))?\s*from\s*(['"])([^'"\n]{1,500})\4/g)) {
    const named = (m[2] ?? '').split(',').map((part) => part.trim().split(/\s+as\s+/).at(-1).replace(/^type\s+/, '')).filter(Boolean);
    for (const name of [m[1], m[3], ...named].filter(Boolean)) names.set(name, m[5]);
  }
  for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Z][\w$]*)\s*(?::[^=\n]{0,200})?=\s*(?![[{])[^;]{0,300}?\bimport\s*\(\s*(['"])([^'"\n]{1,500})\2/g)) names.set(m[1], m[3]);
  return names;
}

/** The value items of `const|let|var <name> = ...` anywhere in the tree (to the `;` or the next statement), or null. */
function declaredValue(node, name) {
  for (let i = 0; i < node.items.length; i += 1) {
    const item = node.items[i];
    const inner = item.items ? declaredValue(item, name) : null;
    if (inner) return inner;
    if (!DECLARE.has(item.v) || node.items[i + 1]?.v !== name) continue;
    const end = node.items.findIndex((x, j) => j > i + 1 && ((x.t === 'p' && x.v === ';') || (x.t === 'id' && STATEMENT.has(x.v))));
    const stop = end < 0 ? node.items.length : end;
    const eq = node.items.findIndex((x, j) => j > i + 1 && j < stop && x.t === 'p' && x.v === '=' && node.items[j + 1]?.v !== '>');
    return eq < 0 ? null : node.items.slice(eq + 1, stop);
  }
  return null;
}

/**
 * The routes a name declared in this file holds (`const routes = [...]`): its spreads and the names it copies become links.
 * @param {{file: string, text: string, tree: object, name: string, ctx: object}} input tree: from fileRoutes of the same text
 * @returns {{links: object[], problems: string[]}|null} null when the file declares no such const (a parameter, an import)
 */
export function declaredRoutes({ file, text, tree, name, ctx }) {
  const value = declaredValue(tree, name);
  if (value === null) return null;
  const out = { screens: [], links: [], problems: [], seen: new WeakSet() };
  routeList(value, ctx, out, value[0]?.at ?? 0, `the routes ${JSON.stringify(name)}`);
  return { links: out.links, problems: out.problems.map((p) => problemLine(file, text, p)) };
}

/** The 1-based line of a character offset. */
export const lineAt = (text, at) => text.slice(0, at).split('\n').length;
const problemLine = (file, text, { at, what }) => `unresolved: ${what} at ${file}:${lineAt(text, at)} cannot be followed`;

/**
 * Route screens, links and problems of one router file.
 * @returns {{screens: object[], links: {ref: object, ctx: object, at: number}[], problems: string[], tree: object}} problems:
 *   `unresolved:` lines; tree: the token tree (for declaredRoutes)
 */
export function fileRoutes(file, text, ctx) {
  const tree = parse(text);
  const out = { screens: [], links: [], problems: [], seen: new WeakSet() };
  objectRoutes(tree, ctx, out);
  jsxRoutes(tree.items, ctx, out);
  callLinks(tree.items, ctx, out);
  return { screens: out.screens, links: out.links, problems: out.problems.map((p) => problemLine(file, text, p)), tree };
}
