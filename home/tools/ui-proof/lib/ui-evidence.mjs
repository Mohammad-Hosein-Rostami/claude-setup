// Purpose: the one vocabulary of UI check evidence (spec ui-kinds-spec.md section 4): the plan depths, the classes of a changed file
// and of its changed lines, and the design and no-change evidence in a request text. The check plan and the skill router both import
// it, so they read one definition. Exports: DEPTHS, stricterDepth, planEvidence, FILE_CLASSES, classifyFile, and, re-exported from
// ui-request.mjs (the request-text part), requestEvidence, uiClauses, ownClauseMatches, FIGMA_LINK, DESIGN_WORDS, UI_WORDS.
// Invariants: pure (no I/O; its only import is the pure ui-request.mjs, so the router imports it without a cycle). A change is
// "no change" only when its lines are re-spaced in place (same trimmed lines, each pair in one hunk); a moved line is a change. An
// app line that fits no class counts as look, never as nothing; a file type we do not know counts as look. Every line regex runs in
// linear time.

export { requestEvidence, uiClauses, ownClauseMatches, FIGMA_LINK, DESIGN_WORDS, UI_WORDS } from './ui-request.mjs';

export const DEPTHS = Object.freeze(['none', 'same', 'render', 'visual', 'pixel']);
export const FILE_CLASSES = Object.freeze(['test', 'docs', 'devConfig', 'deps', 'globalLook', 'look', 'text', 'logic']);

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
