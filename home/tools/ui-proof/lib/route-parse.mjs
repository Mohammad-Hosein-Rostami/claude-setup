// Purpose: route declarations read from the text of one router file: a bracket-nesting tokenizer (comments dropped, strings kept),
// route objects (`{ path, element|component|children... }`), `<Route path element>` elements, router calls that name a routes
// list, and the names a file binds (imports, lazy imports, local declarations). Exports: MAX_READ_BYTES, MAX_ROUTE_CHARS,
// MAX_TEXT_CHARS, SELF, compose, bindingsOf, fileRoutes.
// Invariants (F4): project text is tokenised, never evaluated; the text read, the nesting depth and every kept string are capped.
export const MAX_READ_BYTES = 1 << 20;
export const MAX_ROUTE_CHARS = 300;
export const MAX_TEXT_CHARS = 120;
const MAX_DEPTH = 64;
const ROUTER_CALLS = new Set(['createBrowserRouter', 'createHashRouter', 'createMemoryRouter', 'useRoutes', 'forRoot', 'forChild', 'provideRouter']);
const REF_KEYS = ['element', 'component', 'Component', 'lazy', 'loadComponent'];
const ROUTE_KEYS = new Set([...REF_KEYS, 'children', 'loadChildren', 'redirectTo', 'redirect', 'index']);
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
function refsIn(items, out = []) {
  items.forEach((item, i) => {
    if (item.items) { if (!(items[i - 1]?.v === 'import' && item.items[0]?.t === 'str')) refsIn(item.items, out); return; }
    if (item.t === 'id' && item.v === 'import' && items[i + 1]?.items?.[0]?.t === 'str') out.push({ spec: items[i + 1].items[0].v });
    else if (item.t === 'id' && /^[A-Z]/.test(item.v) && items[i - 1]?.v !== '.') out.push({ name: item.v });
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

/** Route screens and links of one router file. */
export function fileRoutes(file, text, ctx) {
  const tree = parse(text);
  const out = { screens: [], links: [] };
  objectRoutes(tree, ctx, out);
  jsxRoutes(tree.items, ctx, out);
  callLinks(tree.items, ctx, out);
  return out;
}
