// Purpose: the one vocabulary of UI check evidence (spec ui-kinds-spec.md section 4): the plan depths, the classes of a changed file
// and of its changed lines, and the design and no-change evidence in a request text. The check plan and the skill router both import
// it, so they read one definition. Exports: DEPTHS, stricterDepth, planEvidence, FILE_CLASSES, classifyFile, requestEvidence,
// uiClauses, FIGMA_LINK, DESIGN_WORDS, UI_WORDS.
// Invariants: pure (imports nothing, no I/O, so the router imports it without a cycle). Request text is untrusted: capped at 1 MB
// (text past the cap is reported as `partial`, which the caller plans as full checks), only tested with regexes that run in linear
// time, never evaluated, and only short matched phrases are returned. A change is "no change" only when its lines are re-spaced in
// place (same trimmed lines, each pair in one hunk); a moved line is a change. An app line that
// fits no class counts as look, never as nothing; a file type we do not know counts as look. A Figma link is design evidence in any
// clause, and nothing here lowers a depth: noChange and design are both returned and the plan takes the stricter.

export const DEPTHS = Object.freeze(['none', 'same', 'render', 'visual', 'pixel']);
export const FILE_CLASSES = Object.freeze(['test', 'docs', 'devConfig', 'deps', 'globalLook', 'look', 'text', 'logic']);

const MAX_REQUEST_BYTES = 1 << 20; // request text past 1 MB is not read
const MAX_PHRASES = 20; // matched phrases returned per kind
const MAX_PHRASE_CHARS = 80;
const MAX_LINE_CHARS = 4000; // a longer line (minified bundle or css) is not read: it counts as look and logic

/** Rank of a depth in DEPTHS. @throws {TypeError} on a value that is not a depth (a bug in the caller: fail closed) */
function depthRank(depth) {
  const rank = DEPTHS.indexOf(depth);
  if (rank < 0) throw new TypeError(`not a ui plan depth: ${String(depth).slice(0, 40)}`);
  return rank;
}

/** The stricter of two depths (pixel beats everything). @throws {TypeError} when either is not a depth */
export const stricterDepth = (a, b) => (depthRank(a) >= depthRank(b) ? a : b);

/** The suffix a landing row's evidence ends with once its plan is proved. @throws {TypeError} when depth is not a depth */
export const planEvidence = (depth) => ` (ui plan ${DEPTHS[depthRank(depth)]}: proved)`;

// ---- Files: path rules (folders and names are compared lower-case, with `\` read as `/`) ----
const TEST_FOLDERS = new Set(['test', 'tests', '__tests__', '__mocks__', '__snapshots__', 'fixtures', 'e2e', 'cypress', 'spec', 'specs', '.storybook']);
const TEST_NAME = /\.(?:(?:test|spec|stories|story|cy|e2e)\.\w+|snap)$/;
const DOCS_FOLDERS = new Set(['docs', 'doc', 'documentation']);
const PRODUCT_PAGE = /mail|template/; // email and template folders or files under docs/ are product pages, never docs
const APP_FOLDERS = new Set(['src', 'app', 'pages', 'public', 'static', 'components', 'views', 'routes', 'layouts', 'www']);
const DEPS_NAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'deno.lock', '.npmrc', '.yarnrc', '.yarnrc.yml', '.nvmrc', '.node-version', 'go.mod', 'go.sum', 'cargo.lock', 'gemfile.lock', 'poetry.lock', 'composer.lock']);
const DEV_FOLDERS = new Set(['.github', '.gitlab', '.circleci', '.buildkite', '.husky', '.vscode', '.idea', '.devcontainer', '.changeset', '.claude']);
// Lint, format, type-check, test-runner and CI config. Not browserslist or bundler config: those change the built css or js.
// Whole basenames only (`.eslintrc.cjs`, `eslint.config.js`, `tsconfig.app.json`): an app file that starts with a tool's name
// (`license-banner.tsx`, `renovate-card.vue`) is app source, never config.
const DEV_TOOL = 'eslint|prettier|stylelint|commitlint|lint-?staged|markdownlint(?:-cli2)?|mocha|nyc|c8';
const CONFIG_EXT = '(?:\\.(?:[cm]?[jt]s|jsonc?|json5|ya?ml|toml))?';
const DEV_NAME = new RegExp(`^(?:(?:\\.?(?:${DEV_TOOL})rc|\\.(?:${DEV_TOOL})(?:ignore)?|(?:${DEV_TOOL})\\.config|(?:vitest|jest|playwright|cypress|karma)\\.(?:config|workspace|setup))${CONFIG_EXT}|[tj]sconfig(?:\\.[\\w-]+)*\\.json|\\.?renovate(?:rc)?(?:\\.json5?)?|\\.editorconfig|\\.gitignore|\\.gitattributes|(?:\\.gitlab-ci|\\.travis|azure-pipelines|bitbucket-pipelines)\\.ya?ml|jenkinsfile|codeowners|licen[cs]e(?:\\.(?:md|txt))?)$`);
const MARKDOWN = /\.(?:md|markdown)$/; // devConfig, except under an app folder (content the app may render): text
const GLOBAL_FOLDERS = new Set(['theme', 'themes', 'tokens', 'design-tokens', 'fonts']);
const GLOBAL_NAME = /^(?:index\.html?|(?:index|globals?|app|main|reset|normalize|base|root|styles?|tailwind|theme|variables|vars|tokens|fonts?)\.(?:css|scss|sass|less|styl|pcss)|(?:tailwind|postcss|uno|windi|panda)\.config\.\w+|(?:palette|tokens|design-tokens|theme|colou?rs?|typography)\.[\w.]+)$/;
const GLOBAL_SUFFIX = /\.(?:theme|tokens)\.\w+$|\.(?:woff2?|ttf|otf|eot)$/;
const LOCALE_FOLDERS = new Set(['locales', 'locale', 'i18n', 'l10n', 'lang', 'langs', 'languages', 'translations', 'messages']);
const LOCALE_DATA = /\.(?:json5?|ya?ml|toml|properties|ini)$/;
const TEXT_NAME = /\.(?:po|pot|xlf|xliff|arb|ftl)$/;
const STYLE_FILE = /\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)$/;
const ASSET_FILE = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?|mp4|webm|mov|lottie)$/;
const STYLE_FOLDERS = new Set(['style', 'styles', 'sx', 'css', 'scss']);
const STYLE_SCRIPT = /\.(?:styles?|sx|css)\.[cm]?[jt]sx?$/; // Button.styles.ts, vanilla-extract Button.css.ts
const SCRIPT = /\.[cm]?[jt]s$/;
// A global-look file whose lines are read too: a theme or token module, not bundler config (tailwind.config.js holds settings).
const THEME_SCRIPT = /^(?!.*\.config\.\w+$).*\.[cm]?[jt]sx?$/;
const SOURCE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|html?|mdx|hbs|handlebars|ejs|njk|liquid|pug|jade|twig|erb|tmpl|gohtml|go|py|rb|php|java|kts?|swift|dart|rs|cs|exs?)$/;
const MARKUP = /\.(?:tsx|jsx|vue|svelte|astro|html?|mdx|hbs|handlebars|ejs|njk|liquid|pug|jade|twig|erb|tmpl|gohtml)$/;
// Re-indenting changes meaning (markdown: code blocks, nested lists, trailing-space breaks): never "whitespace only".
const INDENT_SENSITIVE = /\.(?:py|pyi|ya?ml|pug|jade|sass|styl|haml|slim|coffee|md|markdown|mdx|rst|adoc|mk)$|^(?:makefile|gnumakefile)$/;

/** A docs page: under a docs folder, no product-page (mail, template) part, and no app folder above the docs folder. */
function isDocsPath(folders, name) {
  const docsAt = folders.findIndex((folder) => DOCS_FOLDERS.has(folder));
  if (docsAt < 0 || [...folders, name].some((part) => PRODUCT_PAGE.test(part))) return false;
  return !folders.slice(0, docsAt).some((folder) => APP_FOLDERS.has(folder));
}

/** The class a path alone decides, or null when the lines decide. Order matters: the first rule that fits wins. */
function classOfPath(folders, name) {
  const inFolder = (set) => folders.some((folder) => set.has(folder));
  if (inFolder(TEST_FOLDERS) || TEST_NAME.test(name)) return 'test';
  if (isDocsPath(folders, name)) return 'docs';
  if (DEPS_NAMES.has(name)) return 'deps';
  if (inFolder(DEV_FOLDERS) || DEV_NAME.test(name) || (MARKDOWN.test(name) && !inFolder(APP_FOLDERS))) return 'devConfig';
  if (inFolder(GLOBAL_FOLDERS) || GLOBAL_NAME.test(name) || GLOBAL_SUFFIX.test(name)) return 'globalLook';
  if (TEXT_NAME.test(name) || MARKDOWN.test(name) || (inFolder(LOCALE_FOLDERS) && LOCALE_DATA.test(name))) return 'text';
  if (STYLE_FILE.test(name) || ASSET_FILE.test(name) || STYLE_SCRIPT.test(name) || (inFolder(STYLE_FOLDERS) && SCRIPT.test(name))) return 'look';
  return null;
}

// ---- Lines (every regex here runs in linear time: no nested or overlapping quantifiers) ----
// A JSX or HTML tag: `<x` or `</x` or `<>` at the line start, after `return`, or after punctuation (not after a name: `Array<T>`, `a<b`).
const TAG = /(?:^|[^\w$.)\]\s]|\breturn)\s*<\/?(?:[a-z]|>)/i;
const STYLE_WORD = /\b(?:class|classname|classes|sx|style|styles|tw|css)\s*[=:]|\bclassname\b|\b(?:styled|css|keyframes|createglobalstyle|tw|clsx|classnames|cn|cva|makestyles|withstyles)\s*[.(`]/i;
// Colour values: quoted or after a colon `'#d32f2f'` / `: #fff` (not an issue ref `fixes #123`), and colour functions.
const CSS_VALUE = /@(?:media|keyframes|apply|tailwind|layer|font-face|container|supports)\b|\bvar\(--|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\(|(?:['"`]|:\s?)#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])|\d(?:px|rem|em|vh|vw|dvh|svh|vmin|vmax)\b|!important|\.(?:css|scss|sass|less|styl)['"]/i;
const CSS_DECL = /^\s*(?:--[\w-]+|-?[a-z]+(?:-[a-z]+)+)\s*:/; // font-size: / --brand: (a bare name in code cannot hold a hyphen)

// A style object or token map key, one per line: `color: 'blue',`, `'font-size': 14`, `p: 2,`. The key is read as a css name
// (camelCase to kebab, vendor prefix dropped). A type member (`width: number;`) is not a style.
const STYLE_KEY_LINE = /^\s*['"]?(-?[a-z][a-z-]{0,40})['"]?\s*:(?!:)/i;
const TYPE_VALUE = /^\s*['"]?[\w-]+['"]?\s*:\s*(?:string|number|boolean|any|unknown|null|undefined|never|void|object)\b/;
const VENDOR = /^-?(?:webkit|moz|ms|o)-/;
const MUI_SHORTHANDS = new Set(['p', 'pt', 'pr', 'pb', 'pl', 'px', 'py', 'm', 'mt', 'mr', 'mb', 'ml', 'mx', 'my', 'bgcolor', 'typography', 'displayPrint']);
// Multi-word css properties: names no data key uses, so the line is look only.
const CSS_LONG_NAME = new RegExp(`^(?:${[
  'font-(?:size|weight|family|style|stretch|display|kerning|feature-settings|variant(?:-[a-z]+)?|optical-sizing|synthesis)',
  'text-(?:align(?:-last)?|transform|decoration(?:-[a-z]+)?|indent|overflow|shadow|underline-offset|wrap|rendering|size-adjust|orientation|fill-color|stroke(?:-[a-z]+)?)',
  '(?:letter|word)-spacing|line-(?:height|clamp)|white-space|word-(?:break|wrap)|overflow-(?:x|y|wrap|anchor)|writing-mode|vertical-align|tab-size',
  'background-(?:color|image|size|position(?:-[xy])?|repeat|clip|origin|attachment|blend-mode)',
  'border-(?:(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?(?:-(?:width|style|color))?|width|style|color|radius|collapse|spacing|image(?:-[a-z]+)?|(?:top|bottom|start|end)-(?:left|right|start|end)-radius)',
  '(?:margin|padding|inset|scroll-margin|scroll-padding)-(?:top|right|bottom|left|block|inline|x|y)(?:-(?:start|end))?',
  'outline-(?:width|style|color|offset)|scroll-(?:behavior|snap-(?:type|align|stop))|list-style(?:-(?:type|position|image))?',
  '(?:min|max)-(?:width|height|block-size|inline-size)|(?:block|inline)-size|aspect-ratio|box-(?:shadow|sizing|decoration-break|orient)|object-(?:fit|position)',
  '(?:justify|align|place)-(?:content|items|self)|(?:row|column)-gap|column-(?:count|width|rule|span|fill)|z-index',
  'grid-(?:template(?:-[a-z]+)?|area|column(?:-start|-end)?|row(?:-start|-end)?|auto-(?:flow|columns|rows)|gap)|flex-(?:direction|wrap|grow|shrink|basis|flow)',
  'animation-(?:name|duration|delay|timing-function|iteration-count|direction|fill-mode|play-state)|transition-(?:property|duration|delay|timing-function|behavior)',
  'transform-(?:origin|style|box)|perspective-origin|backface-visibility|mask-(?:image|size|position|repeat|mode|clip|origin|composite)|clip-path',
  'pointer-events|user-select|touch-action|will-change|backdrop-filter|mix-blend-mode|accent-color|caret-color|color-scheme|content-visibility',
  'table-layout|caption-side|empty-cells|image-rendering|shape-outside|(?:fill|stroke)-(?:opacity|rule|width|dasharray|dashoffset|linecap|linejoin)',
].join('|')})$`);
// One-word css properties are also common data keys (`filter`, `order`, `content`): the line is look and logic.
const CSS_WORD_NAMES = new Set(['color', 'background', 'margin', 'padding', 'border', 'outline', 'display', 'position', 'width', 'height', 'top',
  'left', 'right', 'bottom', 'inset', 'opacity', 'transform', 'transition', 'animation', 'gap', 'flex', 'grid', 'overflow', 'cursor', 'filter',
  'float', 'clear', 'visibility', 'content', 'order', 'columns', 'resize', 'scale', 'rotate', 'translate', 'zoom', 'isolation', 'appearance',
  'hyphens', 'perspective', 'fill', 'stroke', 'font', 'mask', 'clip', 'direction']);

/** The classes of a style key line, or null when the line is not one. `;`-ended one-word lines are css (in a template or <style>). */
function styleKeyClasses(line) {
  const key = STYLE_KEY_LINE.exec(line)?.[1];
  if (!key || TYPE_VALUE.test(line)) return null;
  if (MUI_SHORTHANDS.has(key)) return ['look'];
  const name = key.replace(/[A-Z]/g, (letter) => `-${letter}`).toLowerCase().replace(VENDOR, '');
  if (CSS_LONG_NAME.test(name)) return ['look'];
  if (CSS_WORD_NAMES.has(name)) return /;\s*$/.test(line) ? ['look'] : ['look', 'logic'];
  return null;
}

// Tailwind: a quoted string of two or more utilities, or one prefixed utility (`'bg-red-500 text-white'`, `'hover:bg-accent'`).
const QUOTED = /(['"`])([^'"`\n]{1,500})\1/g;
// Variant prefixes (`md:`, `hover:`), then: a colour or type utility; a spacing or size utility with a scale value (`p-4`, not the
// locale `pl-PL`); a gradient stop with a colour; or a bare utility word (counted only next to another utility).
const TW_UTILITY = new RegExp(`^(?:[\\w-]{1,12}:){0,4}!?-?(?:${[
  '(?:bg|text|font|border|rounded|shadow|ring|fill|stroke|outline|divide|decoration|placeholder|accent|caret|leading|tracking|opacity|z|basis|grid-cols|grid-rows|col-span|row-span|items|justify|place-items|place-content|aspect|overflow(?:-[xy])?|whitespace|duration|ease|delay|animate|transition|cursor|blur|backdrop|line-clamp)-[\\w./[\\]#%()-]{1,60}',
  '(?:[pm][xytrblse]?|w|h|size|min-w|max-w|min-h|max-h|gap(?:-[xy])?|space-[xy]|inset(?:-[xy])?|top|left|right|bottom|start|end|translate-[xy]|scale|rotate|skew-[xy])-(?:\\d|px|auto|full|screen|fit|min|max|\\[)[\\w./[\\]%()-]{0,60}',
  '(?:from|via|to)-(?:[a-z]+-\\d{2,3}|transparent|white|black|current|\\[)[\\w./[\\]#%()-]{0,60}',
  'flex|grid|hidden|block|inline(?:-block|-flex)?|contents|truncate|uppercase|lowercase|capitalize|italic|underline|absolute|relative|fixed|sticky|static|invisible|container|rounded|shadow|border|grow|shrink',
].join('|')})$`);

function isTailwindLine(line) {
  for (const [, , body] of line.matchAll(QUOTED)) {
    const tokens = body.trim().split(/\s+/);
    const utilities = tokens.filter((token) => TW_UTILITY.test(token));
    if (utilities.length >= 2 || (tokens.length === 1 && utilities.length === 1 && /[-:]/.test(tokens[0]))) return true;
  }
  return false;
}
const SELECTOR = /^\s*[.#][a-z][\w-]*(?:[\s,>+~.#:\w-]|\[[^\]]*\])*\{\s*$/i; // a css rule head in a <style> block
const ATTR_LINE = /^\s*(?:[:@]|v-)?[a-z][\w.:-]*=(?:["'{]|$)/i; // a markup attribute on its own line: variant="primary"
const EVENT_OR_COND = /^\s*(?:on[A-Z]\w*|@[\w.:-]+|v-(?:on|if|else-if|else|show|for|model)\b|\*ng(?:If|For)\b|\(\w+\)=)/;
// Logic on a look line: control flow, handlers, conditions, method calls. Not a declaration (`const Box = styled.div`) or an import.
const STRONG_LOGIC = /\b(?:if|else|for|while|switch|case|return|await|async|function|throw|try|catch|fetch|yield)\b|=>|&&|\|\||\?\?|\?\.|[!=]==?|\w\.\w+\(/;
const LOGIC = /[=;(){}[\]]|=>|\b(?:import|export|const|let|var|function|return|if|else|for|while|await|async|new|class|interface|type|enum|throw|try|catch|switch|case|break|continue|default|func|def|package|struct)\b|\w\.\w|\w\s*:\s*\S|,\s*$|^\s*(?:\/\/|\/\*|\*|#\s|['"]use\s)/;
// JSX or template text: words and sentence punctuation only (FA included), not a statement keyword, not a list item (`Foo,`).
const TEXT_ONLY = /^\s*[\p{L}\p{N}][\p{L}\p{N}\p{M}\s‌.,!?'’«»\-–—…&%/؟،٪]*$/u;
const TEXT_NOT = /^\s*(?:import|export|from|return|break|continue|else|try|finally|do|debugger|yield|await|throw|case|default|package|use|async|let|const|var|type|interface|enum|declare|namespace|module)\b|,\s*$/;
const ONE_LOWER_WORD = /^\s*[a-z][\w$]*\s*$/; // `disabled`, `isOpen`: a prop or an expression, not text (falls to look)
const I18N_CALL = /^\s*\{{1,2}\s*\$?t\(\s*['"][\w.:-]+['"]\s*\)\s*\}{1,2}\s*$/; // {t('save')} / {{ $t('save') }}

const isLookLine = (line, markup) =>
  TAG.test(line) || STYLE_WORD.test(line) || CSS_VALUE.test(line) || CSS_DECL.test(line) || isTailwindLine(line) ||
  (markup && (SELECTOR.test(line) || ATTR_LINE.test(line)));

const isTextLine = (line) => I18N_CALL.test(line) || (TEXT_ONLY.test(line) && !TEXT_NOT.test(line) && !ONE_LOWER_WORD.test(line));

/** Classes of one changed source line. `markup`: the file type can hold JSX or HTML text. */
function sourceLineClasses(line, markup) {
  if (line.length > MAX_LINE_CHARS) return ['look', 'logic'];
  const logicToo = STRONG_LOGIC.test(line) || (markup && EVENT_OR_COND.test(line));
  if (isLookLine(line, markup)) return logicToo ? ['look', 'logic'] : ['look'];
  const styleKey = styleKeyClasses(line);
  if (styleKey) return logicToo ? ['look', 'logic'] : styleKey;
  if (markup && isTextLine(line)) return ['text'];
  return LOGIC.test(line) ? ['logic'] : ['look']; // a line that fits no class counts as look (P3)
}

// package.json: only package metadata and test, lint or format script lines are dev config; any other line can change the build.
const PACKAGE_META = /^\s*"(?:version|description|keywords|author|contributors|license|repository|bugs|homepage|funding|private)"\s*:/;
const PACKAGE_DEV_SCRIPT = /^\s*"(?:test|lint|format|typecheck|e2e|storybook)(?::[\w:-]*)?"\s*:\s*"(?![\^~<>=*\d]|workspace:|npm:|file:|link:)/;
const packageLineClasses = (line) => (PACKAGE_META.test(line) || PACKAGE_DEV_SCRIPT.test(line) ? ['devConfig'] : ['deps']);

/** The non-blank lines, trimmed, each with its hunk number (undefined when positions are unknown). */
const contentLines = (lines, hunks) =>
  lines.map((line, i) => ({ text: String(line).trim(), hunk: hunks?.[i] })).filter((entry) => entry.text);

/** @throws {TypeError} when `hunks` is given but is not one integer hunk number per removed and per added line */
function checkHunks(hunks, removed, added) {
  if (hunks === undefined || hunks === null) return;
  const fits = (numbers, lines) => Array.isArray(numbers) && numbers.length === lines.length && numbers.every(Number.isInteger);
  if (!fits(hunks.removed, removed) || !fits(hunks.added, added)) throw new TypeError('hunks must give one integer per removed and added line');
}

/**
 * True when the change only re-spaces lines in place: the trimmed lines are the same, in the same order, and each pair sits in one
 * hunk. A line removed in one hunk and added in another is a move, a visible change. Without positions only blank lines qualify.
 */
function whitespaceOnly(removed, added, hunks) {
  const before = contentLines(removed, hunks?.removed);
  const after = contentLines(added, hunks?.added);
  if (!hunks) return before.length === 0 && after.length === 0;
  return before.length === after.length && before.every((line, i) => line.text === after[i].text && line.hunk === after[i].hunk);
}

/** The union of the classes of the non-blank lines, in FILE_CLASSES order. */
function classesOfLines(lines, lineClasses) {
  const found = new Set();
  for (const line of lines) if (String(line).trim()) for (const name of lineClasses(String(line))) found.add(name);
  return FILE_CLASSES.filter((name) => found.has(name));
}

/**
 * The classes of one changed file, from its path and its changed lines (`git diff -U0`: removed and added, without the -/+ mark).
 * @param {string} file repo path (`/` or `\` separators)
 * @param {string[]|null} removed removed lines, or null when unknown (binary, by path only)
 * @param {string[]|null} added added lines, or null when unknown
 * @param {{ removed: number[], added: number[] }} [hunks] the hunk of each removed and added line (one number per `@@` header,
 *   equal numbers = same hunk); without it a re-indent cannot be told from a move, so it counts as a change
 * @returns {string[]} classes in FILE_CLASSES order; [] when the change has no lines, only blank lines, or (with hunks) only
 *   re-spaces lines in place
 * @throws {TypeError} when hunks is given but does not fit the lines
 */
export function classifyFile(file, removed, added, hunks) {
  const parts = String(file).replace(/\\/g, '/').toLowerCase().split('/').filter((part) => part && part !== '.');
  const name = parts.at(-1) ?? '';
  const folders = parts.slice(0, -1);
  const known = Array.isArray(removed) && Array.isArray(added);
  if (known) checkHunks(hunks, removed, added);
  if (known && !INDENT_SENSITIVE.test(name) && whitespaceOnly(removed, added, hunks)) return [];
  const byPath = classOfPath(folders, name);
  // A theme or token script (colors.ts, src/theme/palette.ts) reaches every screen, and its lines still say look or logic.
  const markup = MARKUP.test(name);
  const ofSourceLines = () => classesOfLines([...removed, ...added], (line) => sourceLineClasses(line, markup));
  if (byPath === 'globalLook' && known && THEME_SCRIPT.test(name)) return ['globalLook', ...ofSourceLines()];
  if (byPath) return [byPath];
  if (name === 'package.json') return known ? classesOfLines([...removed, ...added], packageLineClasses) : ['deps'];
  if (!SOURCE.test(name)) return ['look']; // a file type we do not know counts as look (P3)
  if (!known) return ['look', 'logic'];
  return ofSourceLines();
}

// ---- Request text ----
/** A Figma file link: design evidence in any clause, even negated, talk or pasted (the router reads pasted blocks for it too). */
export const FIGMA_LINK = /figma\.com\/(?:design|file|proto|board|make)\/|\bnode-id=\d/i;
// "match / follow / per / like the design(s), frame(s), mockup(s)", not "the design system / doc". FA: Figma, pixel,
// "matching the design / frame / Figma".
export const DESIGN_WORDS = /\bfigma\b|\bpixel[\s-]?perfect\b|\b(?:match(?:es|ed|ing)?|follow(?:s|ed|ing)?|per|like|according\sto|as\sin)\s(?:it\s)?(?:to\s)?(?:the\s|this\s|that\s|our\s|these\s|those\s)?(?:designs?|frames?|mock-?ups?|mocks?)\b(?!\s(?:systems?|docs?|documents?|reviews?|decisions?|patterns?|tokens?)\b)|فیگما|پیکسل|(?:مطابق|طبق|عین|مثل|تطابق)\s?(?:با\s)?(?:طرح|دیزاین|فریم)/i;
// The router's UI nouns (FA: page, component, style, design work, button, look).
export const UI_WORDS = /\b(?:ui|ux|components?|screens?|modals?|dialogs?|drawers?|buttons?|navbar|css|scss|sx|tailwind|mui|styling|spacing|responsive|page[\s-]?layouts?|form[\s-]?fields?)\b|صفحه|کامپوننت|استایل|طراحی|دکمه|ظاهر/i;
// FA: without a look change; look/style unchanged; refactor.
const NO_CHANGE_WORDS = /\brefactor(?:s|ed|ing)?\b|\bno\s(?:visual|ui|ux|look|style|styling|design|layout|appearance)\s?(?:changes?|differences?|diffs?)\b|\b(?:don'?t|do\snot|never|without)\s(?:chang|touch|alter|modify)\w*\s(?:the\s|any\s)?(?:look|ui|ux|design|appearance|layout|styles?|styling|visuals?|css|screens?)\b|\bsame\s(?:look|ui|appearance|layout|visuals?|design|screens?|renders?)\b|\b(?:look|ui|visuals?|appearance|layout|screens?|design)\s(?:stays?|remains?)\s(?:the\s)?(?:same|unchanged|identical)\b|\b(?:pixel|visually)[\s-]?identical\b|بدون\s?تغییر\s?(?:ظاهر|ظاهری|در\sظاهر|ui|طراحی|استایل|رابط)|(?:ظاهر|استایل|طراحی|ui)\s?(?:را\s)?(?:تغییر|عوض)\s?(?:نده|ندهید|ندید|نکن|نکنید|نکند|نکنه|نشود|نشه)|ریفکتور/i;
// Talk about the checks themselves gives no evidence: "the pixel checks are heavy", "what do u mean". FA: checks (plural), check of ui/pixel/Figma/look.
// Not "a pixel perfect job": that names the work asked for.
const TALK = /\b(?:ui|ux|pixel|visual|design|figma|screen)[\s-]?(?:perfect[\s-]?)?(?:checks?|checkers?|checking|gates?|chains?|loops?|proofs?|qa|rounds?)\b|\bchecks\b|\b(?:visual-qa|ui-check|ui-proof|ui-coverage|done-check|skill[\s-]?router|router|check[\s-]plan)\b|\bwhat\sdo(?:es)?\s(?:u|you|ya|it|this|that)\smean\b|(?:چک|تست|بررسی)[\s‌]?ها|(?:چک|تست|بررسی)[\s‌](?:ی[\s‌])?(?:ui|یو[\s‌]?آی|پیکسل|فیگما|ظاهر)/i;
// EN negation reaches forward ("don't ... pixel perfect"); "is not pixel perfect" is a complaint, not a negation.
const EN_NEGATOR = /\b(?:no|never|without|skip|skipping|stop|nothing|avoid|cannot|(?:do|does|did|should|must|wo|ca)n'?t)\b|(?<!\b(?:is|are|was|were|it's|looks?|seems?)\s)\bnot\b/i;
// FA negation sits in the verb at the clause end, so it counts anywhere in the clause (outside the matched phrase).
const FA_NEGATOR = /(?<=^|[\s‌])(?:نکن(?:ید|ی|ین|ه)?|نده(?:ید)?|ندی[دن]|نزن(?:ید|ین)?|نساز(?:ید|ین)?|نباید|نخواه|بدون|نه|هرگز|نمی)(?=$|[\s‌])/;
// Double negation keeps the evidence: "don't skip the ui checks", FA "do not drop / reduce / remove".
const AFFIRM = /\b(?:don'?t|do\snot|never|no|without)\s(?:skip(?:ping)?|drop(?:ping)?|los(?:e|ing)|sacrific(?:e|ing)|cut(?:ting)?|stop(?:ping)?|ignor(?:e|ing)|miss(?:ing)?)\b|(?:رد|کم|حذف|فراموش)[\s‌]?(?:نکن|نکنید|نشه|نشود)/gi;
// Negations that refuse nothing, blanked before the negators are read: a complaint ("doesn't match the design", "is not matching")
// or not knowing ("I don't know why ...", FA "I don't know / understand").
const NOT_A_REFUSAL = /\b(?:(?:do|does|did|is|are|was|were)(?:n'?t|\snot)|not)\s(?:(?:quite|exactly|fully|really|yet)\s)?(?=match)|\b(?:don'?t|do\snot|didn'?t|did\snot|can'?t|cannot)\s(?:know|understand|get|see|figure\sout|tell)\b|نمی[\s‌]?(?:دونم|دانم|فهمم|فهمیم|دونیم|دانیم)/gi;
// The router's clauses. A colon, a dash (` - `, `—`, `–`), a semicolon and a new line end a clause, so "no shortcuts: make it pixel
// perfect" keeps its design words; a hyphen inside a word (`pixel-perfect`) does not.
const CLAUSE_BREAK = /[.!?;:,\n\r،؛؟…—–]+|\s-+\s|\s(?:but|however)\s|\s(?:ولی|اما)\s/i;
const PART_BREAK = new RegExp(`${CLAUSE_BREAK.source}|\\s(?:and|then|also|so|plus)\\s|\\s(?:و|سپس|بعد)\\s`, 'i'); // finer, for design words

const globalOf = (pattern) => new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
const DESIGN_ALL = globalOf(DESIGN_WORDS);
const NO_CHANGE_ALL = globalOf(NO_CHANGE_WORDS);
const UI_ALL = globalOf(UI_WORDS);
const FIGMA_LINK_ALL = globalOf(FIGMA_LINK);
const FA_NEGATOR_ALL = globalOf(FA_NEGATOR);

/**
 * The request as lower-case text, capped at 1 MB, FA letters unified, spaces collapsed; `partial` when text past the cap was not read.
 * @throws {TypeError} on a non-string
 */
function requestText(text) {
  if (text === null || text === undefined) return { text: '', partial: false };
  if (typeof text !== 'string') throw new TypeError('request text must be a string');
  const encoded = new TextEncoder().encode(text.slice(0, MAX_REQUEST_BYTES));
  const partial = text.length > MAX_REQUEST_BYTES || encoded.length > MAX_REQUEST_BYTES;
  return { text: unifiedText(new TextDecoder().decode(encoded.subarray(0, MAX_REQUEST_BYTES))), partial };
}

/** Lower case, typographic apostrophes as `'`, Arabic yeh and kaf as Persian, runs of spaces as one. */
function unifiedText(read) {
  return read.toLowerCase().replace(/[’‘]/g, "'").replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/[ \t\f\v ]+/g, ' ');
}

/**
 * The matches of `pattern` in a clause that no negator reaches: no EN negator before the match, no FA negator outside it. The
 * negators are found once per clause (first EN start; first FA start, last FA end), so a long clause with many matches stays linear.
 */
function unnegatedMatches(clause, pattern) {
  const enAt = clause.search(EN_NEGATOR);
  const faSpans = [...clause.matchAll(FA_NEGATOR_ALL)];
  const faFirst = faSpans.length ? faSpans[0].index : Infinity;
  const faLastEnd = faSpans.length ? faSpans.at(-1).index + faSpans.at(-1)[0].length : -Infinity;
  const found = [];
  for (const match of clause.matchAll(pattern)) {
    const end = match.index + match[0].length;
    if (!(enAt >= 0 && enAt < match.index) && faFirst >= match.index && faLastEnd <= end) found.push(match[0]);
  }
  return found;
}

const blank = (phrase) => ' '.repeat(phrase.length);

/** Each clause of `text` split by `breaks`, double negations and negations that refuse nothing blanked, talk clauses left out. */
const evidenceClauses = (text, breaks) =>
  text.split(breaks).map((clause) => clause.replace(AFFIRM, blank).replace(NOT_A_REFUSAL, blank)).filter((clause) => !TALK.test(clause));

const phrases = (found) => [...new Set(found.map((phrase) => phrase.trim().slice(0, MAX_PHRASE_CHARS)))].slice(0, MAX_PHRASES);

function evidenceOf({ text, partial }) {
  const design = [...text.matchAll(FIGMA_LINK_ALL)].map((match) => match[0]);
  const noChange = [];
  for (const clause of evidenceClauses(text, PART_BREAK)) {
    design.push(...unnegatedMatches(clause, DESIGN_ALL));
    noChange.push(...unnegatedMatches(clause, NO_CHANGE_ALL));
  }
  return { design: phrases(design), noChange: phrases(noChange), partial };
}

/**
 * Design and no-change evidence in a request (the brief, STATUS rules and decisions). Talk clauses and negated phrases give nothing,
 * except a Figma link, which counts anywhere.
 * @param {string|null|undefined} text untrusted request text (only the first 1 MB is read)
 * @returns {{ design: string[], noChange: string[], partial: boolean }} the matched phrases (short, lower-case, at most 20 each);
 *   partial: the text was over 1 MB and its rest was not read, so the caller must plan the full checks (pixel)
 * @throws {TypeError} when text is neither a string nor null/undefined
 */
export const requestEvidence = (text) => evidenceOf(requestText(text));

/**
 * For the skill router: does the request ask for design work, and does it ask for UI work at all? Talk and negated clauses are removed.
 * A prompt over 1 MB is not read whole, so it counts as both (the full route).
 * @param {string|null|undefined} text untrusted prompt text
 * @returns {{ design: boolean, ui: boolean }} design: as requestEvidence; ui: design, or a UI noun in a clause that is neither talk nor negated
 */
export function uiClauses(text) {
  const request = requestText(text);
  if (request.partial) return { design: true, ui: true };
  const design = evidenceOf(request).design.length > 0;
  return { design, ui: design || evidenceClauses(request.text, CLAUSE_BREAK).some((clause) => unnegatedMatches(clause, UI_ALL).length > 0) };
}
