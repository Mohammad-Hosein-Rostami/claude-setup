// Purpose: the CSS facts of a change (round 2, 8.1 item 4 and 9.1-9.2): which style properties changed (layout or paint), whether a
//   media or container query, a token or theme, RTL or locale text, or a new UI state was touched, and the scope (global, shared,
//   local) of the changed styles. Read from changed lines of style files and of components with styles in JS (`sx`, `styled`,
//   `style={{...}}`, Tailwind classes).
// Exports: cssFacts(files, {readNew, consumersOf}), LAYOUT_PROPS, PAINT_PROPS, UI_FILE.
// Invariants: pure, never throws; a style line whose property it cannot name sets `unknown` (the UI rule then takes the matrix).
export const UI_FILE = /\.(tsx|jsx|vue|svelte|css|scss|sass|less|html)$/;
const STYLE_FILE = /\.(css|scss|sass|less)$/;
/** Properties that move or resize boxes or reflow text (round 2, 9.2 "a layout property changed"). */
export const LAYOUT_PROPS = new Set(['display', 'position', 'inset', 'top', 'right', 'bottom', 'left', 'width', 'min-width', 'max-width', 'height',
  'min-height', 'max-height', 'overflow', 'overflow-x', 'overflow-y', 'float', 'box-sizing', 'aspect-ratio', 'white-space', 'text-overflow',
  'font-size', 'line-height', 'flex', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'grid', 'grid-template',
  'grid-template-columns', 'grid-template-rows', 'grid-area', 'grid-column', 'grid-row', 'order', 'align-items', 'justify-content',
  'align-self', 'justify-self', 'place-items', 'columns', 'zoom', 'transform', 'inset-inline', 'inset-block', 'inline-size', 'block-size', 'z-index']);
/** Properties that only repaint (round 2, 9.2 crop list). */
export const PAINT_PROPS = new Set(['color', 'background', 'background-color', 'background-image', 'border-color', 'box-shadow', 'opacity', 'font-weight',
  'font-style', 'text-decoration', 'fill', 'stroke', 'outline-color', 'caret-color', 'accent-color', 'cursor', 'transition', 'filter']);
/** Spacing inside a component: a crop is enough when the component's own size does not change. */
const SPACING_PROPS = /^(padding|margin|gap|row-gap|column-gap)(-|$)/;
const PROPERTY = /(?:^|[{;\s])(-?-?[a-z][a-z-]*)\s*:\s*[^:;]/i;
const JS_PROPERTY = /\b([a-z][a-zA-Z]*)\s*:\s*['"\d{[(-]/;
const STYLE_IN_JS = /\bsx\s*=|\bstyled[.(]|\bstyle\s*=\s*\{\{|\bmakeStyles\b|\bcss`|\bclassName\s*=|\bclass\s*=/;
const TAILWIND_LAYOUT = /\b(flex|grid|block|inline|hidden|absolute|relative|fixed|sticky|w-|h-|min-w|max-w|min-h|max-h|basis-|col-|row-|order-|overflow|text-(xs|sm|base|lg|[2-9]?xl)|leading-|truncate|whitespace)/;
const MEDIA = /@media|@container|\bbreakpoints?\b|\b(up|down|between)\(\s*['"]?(xs|sm|md|lg|xl)|\b(sm|md|lg|xl|2xl):/;
const TOKENS = /(^|\/)(tokens?|theme|themes|palette|variables|design-system)[^/]*\.|(^|\/)(tokens|theme|themes)\//i;
const TOKEN_LINE = /^\s*--[\w-]+\s*:|createTheme|ThemeProvider|prefers-color-scheme|data-theme|\bdark\b/;
const GLOBAL_FILE = /(^|\/)(global|globals|reset|normalize|base|app|index|main|root|styles)\.(css|scss|sass|less)$|(^|\/)\.storybook\/preview|(^|\/)(app|_app|layout|root)\.[jt]sx$/i;
const GLOBAL_SELECTOR = /^\s*(:root|html|body|\*|[a-z][a-z0-9]*)(\s*[,{:>+~[]|\s+[a-z.#])/;
const RTL = /\brtl\b|\bdir\s*=|direction\s*:|-inline(-start|-end)?\b|\b(margin|padding|inset)-(inline|block)|\bi18n\b|\blocale\b|\bt\(\s*['"]/;
const LOCALE_FILE = /(^|\/)(locales?|i18n|translations?|lang)\//i;
const STATE_WORD = /\b(isLoading|loading|isEmpty|empty|isError|error|disabled|skeleton|placeholder|status\s*===?)\b/;
const SHARED_CONSUMERS = 3; // a component imported by this many files is shared (round 2, 9.1)

const kebab = (name) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** The style property a changed line sets, or null. */
function propertyOf(text, styleFile) {
  const match = (styleFile ? PROPERTY : JS_PROPERTY).exec(text);
  return match ? kebab(match[1]).replace(/^-(webkit|moz|ms)-/, '') : null;
}

/** The scope of one file's style change: global, shared or local. */
function scopeOf(file, lines, consumersOf) {
  if (GLOBAL_FILE.test(file.path) || TOKENS.test(file.path)) return 'global';
  if (STYLE_FILE.test(file.path) && !/\.module\.(css|scss|sass|less)$/.test(file.path) && lines.some((text) => GLOBAL_SELECTOR.test(text))) return 'global';
  return consumersOf(file.path) >= SHARED_CONSUMERS ? 'shared' : 'local';
}

/** Adds one changed style line to the running facts. */
function addLine(facts, text, styleFile) {
  if (MEDIA.test(text)) facts.mediaOrContainer = true;
  if (TOKEN_LINE.test(text)) facts.tokensOrTheme = true;
  if (RTL.test(text)) facts.rtlOrLocale = true;
  if (!styleFile && TAILWIND_LAYOUT.test(text) && /class(Name)?\s*=/.test(text)) facts.layout.add('class-layout');
  const prop = propertyOf(text, styleFile);
  if (prop === null) return;
  if (LAYOUT_PROPS.has(prop)) facts.layout.add(prop);
  else if (PAINT_PROPS.has(prop)) facts.paint.add(prop);
  else if (SPACING_PROPS.test(prop)) facts.spacing.add(prop);
  else if (styleFile || STYLE_IN_JS.test(text)) facts.unknownProps.add(prop);
}

/**
 * CSS facts of a change.
 * @param {{path: string, added: {text: string}[], removed: {text: string}[], isNew: boolean}[]} files
 * @param {{readNew: (path: string) => string | null, consumersOf: (path: string) => number}} readers
 * @returns {{uiFiles: string[], scope: 'none'|'local'|'shared'|'global', layout: string[], paint: string[], spacing: string[],
 *   unknown: boolean, mediaOrContainer: boolean, tokensOrTheme: boolean, rtlOrLocale: boolean, newComponent: boolean, newState: boolean}}
 */
export function cssFacts(files, { consumersOf }) {
  const facts = { layout: new Set(), paint: new Set(), spacing: new Set(), unknownProps: new Set(), mediaOrContainer: false, tokensOrTheme: false, rtlOrLocale: false };
  const uiFiles = files.filter(({ path }) => UI_FILE.test(path) || LOCALE_FILE.test(path));
  const scopes = new Set();
  let newComponent = false;
  let newState = false;
  for (const file of uiFiles) {
    const styleFile = STYLE_FILE.test(file.path);
    const lines = [...file.added, ...file.removed].map(({ text }) => text);
    if (LOCALE_FILE.test(file.path)) facts.rtlOrLocale = true;
    if (TOKENS.test(file.path)) facts.tokensOrTheme = true;
    for (const text of lines) addLine(facts, text, styleFile);
    if (file.isNew && !styleFile) newComponent = true;
    if (!styleFile && file.added.some(({ text }) => STATE_WORD.test(text))) newState = true;
    scopes.add(scopeOf(file, lines, consumersOf));
  }
  const scope = ['global', 'shared', 'local'].find((name) => scopes.has(name)) ?? 'none';
  return {
    uiFiles: uiFiles.map(({ path }) => path), scope, layout: [...facts.layout], paint: [...facts.paint], spacing: [...facts.spacing],
    unknown: facts.unknownProps.size > 0 && facts.layout.size === 0 && facts.paint.size === 0, mediaOrContainer: facts.mediaOrContainer,
    tokensOrTheme: facts.tokensOrTheme, rtlOrLocale: facts.rtlOrLocale, newComponent, newState,
  };
}
