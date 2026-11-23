// Purpose: the one vocabulary of UI check evidence (spec ui-kinds-spec.md section 4): the plan depths, the classes of a changed file
// and of its changed lines, and the design and no-change evidence in a request text. The check plan and the skill router both import
// it, so they read one definition. Exports: DEPTHS, stricterDepth, planEvidence, FILE_CLASSES, classifyFile, requestEvidence,
// uiClauses, FIGMA_LINK, DESIGN_WORDS, UI_WORDS.
// Invariants: pure (imports nothing, no I/O, so the router imports it without a cycle). Request text is untrusted: capped at 1 MB,
// only tested with regexes that run in linear time, never evaluated, and only short matched phrases are returned. An app line that
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
const GLOBAL_NAME = /^(?:index\.html?|(?:index|globals?|app|main|reset|normalize|base|root|styles?|tailwind|theme|variables|vars|tokens|fonts?)\.(?:css|scss|sass|less|styl|pcss)|(?:tailwind|postcss|uno|windi|panda)\.config\.\w+|(?:palette|tokens|theme)\.[\w.]+)$/;
const GLOBAL_SUFFIX = /\.(?:theme|tokens)\.\w+$|\.(?:woff2?|ttf|otf|eot)$/;
const LOCALE_FOLDERS = new Set(['locales', 'locale', 'i18n', 'l10n', 'lang', 'langs', 'languages', 'translations', 'messages']);
const LOCALE_DATA = /\.(?:json5?|ya?ml|toml|properties|ini)$/;
const TEXT_NAME = /\.(?:po|pot|xlf|xliff|arb|ftl)$/;
const STYLE_FILE = /\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)$/;
const ASSET_FILE = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?|mp4|webm|mov|lottie)$/;
const STYLE_FOLDERS = new Set(['style', 'styles', 'sx', 'css', 'scss']);
const STYLE_SCRIPT = /\.(?:styles?|sx|css)\.[cm]?[jt]sx?$/; // Button.styles.ts, vanilla-extract Button.css.ts
const SCRIPT = /\.[cm]?[jt]s$/;
const SOURCE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|html?|mdx|hbs|handlebars|ejs|njk|liquid|pug|jade|twig|erb|tmpl|gohtml|go|py|rb|php|java|kts?|swift|dart|rs|cs|exs?)$/;
const MARKUP = /\.(?:tsx|jsx|vue|svelte|astro|html?|mdx|hbs|handlebars|ejs|njk|liquid|pug|jade|twig|erb|tmpl|gohtml)$/;
const INDENT_SENSITIVE = /\.(?:py|ya?ml|pug|jade|sass|styl|haml|slim|coffee)$/; // re-indenting changes meaning: never "whitespace only"

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
const CSS_VALUE = /@(?:media|keyframes|apply|tailwind|layer|font-face|container|supports)\b|\bvar\(--|\b(?:rgba?|hsla?|oklch)\(|\d(?:px|rem|em|vh|vw|dvh|svh|vmin|vmax)\b|!important|\.(?:css|scss|sass|less|styl)['"]/i;
const CSS_DECL = /^\s*(?:--[\w-]+|-?[a-z]+(?:-[a-z]+)+)\s*:/; // font-size: / --brand: (a bare name in code cannot hold a hyphen)
const CSS_PROP = /^\s*(?:color|background|margin|padding|border|display|position|width|height|top|left|right|bottom|opacity|transform|transition|animation|gap|flex|grid|overflow|cursor|outline|filter|inset|float|visibility|content)\s*:(?!\s*(?:string|number|boolean|any|unknown|null|undefined|never|void|object)\b)[^;]*;\s*$/;
const STYLE_KEY = /^\s*['"]?(?:fontSize|fontWeight|fontFamily|lineHeight|letterSpacing|textAlign|textTransform|textDecoration|backgroundColor|backgroundImage|borderRadius|borderColor|borderWidth|boxShadow|zIndex|minWidth|maxWidth|minHeight|maxHeight|marginTop|marginBottom|marginLeft|marginRight|paddingTop|paddingBottom|paddingLeft|paddingRight|justifyContent|alignItems|alignSelf|flexDirection|flexWrap|gridTemplateColumns|whiteSpace|objectFit)['"]?\s*:/;
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
  TAG.test(line) || STYLE_WORD.test(line) || CSS_VALUE.test(line) || CSS_DECL.test(line) || CSS_PROP.test(line) || STYLE_KEY.test(line) ||
  (markup && (SELECTOR.test(line) || ATTR_LINE.test(line)));

const isTextLine = (line) => I18N_CALL.test(line) || (TEXT_ONLY.test(line) && !TEXT_NOT.test(line) && !ONE_LOWER_WORD.test(line));

/** Classes of one changed source line. `markup`: the file type can hold JSX or HTML text. */
function sourceLineClasses(line, markup) {
  if (line.length > MAX_LINE_CHARS) return ['look', 'logic'];
  if (isLookLine(line, markup)) return STRONG_LOGIC.test(line) || (markup && EVENT_OR_COND.test(line)) ? ['look', 'logic'] : ['look'];
  if (markup && isTextLine(line)) return ['text'];
  return LOGIC.test(line) ? ['logic'] : ['look']; // a line that fits no class counts as look (P3)
}

// package.json: only package metadata and test, lint or format script lines are dev config; any other line can change the build.
const PACKAGE_META = /^\s*"(?:version|description|keywords|author|contributors|license|repository|bugs|homepage|funding|private)"\s*:/;
const PACKAGE_DEV_SCRIPT = /^\s*"(?:test|lint|format|typecheck|e2e|storybook)(?::[\w:-]*)?"\s*:\s*"(?![\^~<>=*\d]|workspace:|npm:|file:|link:)/;
const packageLineClasses = (line) => (PACKAGE_META.test(line) || PACKAGE_DEV_SCRIPT.test(line) ? ['devConfig'] : ['deps']);

const contentLines = (lines) => lines.map((line) => String(line).trim()).filter(Boolean);
const sameContent = (a, b) => a.length === b.length && a.every((line, i) => line === b[i]);

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
 * @returns {string[]} classes in FILE_CLASSES order; [] when the change is whitespace only (re-indent, blank lines) or has no lines
 */
export function classifyFile(file, removed, added) {
  const parts = String(file).replace(/\\/g, '/').toLowerCase().split('/').filter((part) => part && part !== '.');
  const name = parts.at(-1) ?? '';
  const folders = parts.slice(0, -1);
  const known = Array.isArray(removed) && Array.isArray(added);
  if (known && !INDENT_SENSITIVE.test(name) && sameContent(contentLines(removed), contentLines(added))) return [];
  const byPath = classOfPath(folders, name);
  if (byPath) return [byPath];
  if (name === 'package.json') return known ? classesOfLines([...removed, ...added], packageLineClasses) : ['deps'];
  if (!SOURCE.test(name)) return ['look']; // a file type we do not know counts as look (P3)
  if (!known) return ['look', 'logic'];
  const markup = MARKUP.test(name);
  return classesOfLines([...removed, ...added], (line) => sourceLineClasses(line, markup));
}

// ---- Request text ----
/** A Figma file link: design evidence in any clause, even negated, talk or pasted (the router reads pasted blocks for it too). */
export const FIGMA_LINK = /figma\.com\/(?:design|file|proto|board|make)\/|\bnode-id=\d/i;
// FA: Figma, pixel, "matching the design / frame / Figma".
export const DESIGN_WORDS = /\bfigma\b|\bpixel[\s-]?perfect\b|\bmatch(?:es|ing)?\s(?:the\s|this\s|our\s)?(?:design|frame|mock-?ups?)\b|فیگما|پیکسل|(?:مطابق|طبق|عین|مثل|تطابق)\s?(?:با\s)?(?:طرح|دیزاین|فریم)/i;
// The router's UI nouns (FA: page, component, style, design work, button, look).
export const UI_WORDS = /\b(?:ui|ux|components?|screens?|modals?|dialogs?|drawers?|buttons?|navbar|css|scss|sx|tailwind|mui|styling|spacing|responsive|page[\s-]?layouts?|form[\s-]?fields?)\b|صفحه|کامپوننت|استایل|طراحی|دکمه|ظاهر/i;
// FA: without a look change; look/style unchanged; refactor.
const NO_CHANGE_WORDS = /\brefactor(?:s|ed|ing)?\b|\bno\s(?:visual|ui|ux|look|style|styling|design|layout|appearance)\s?(?:changes?|differences?|diffs?)\b|\b(?:don'?t|do\snot|never|without)\s(?:chang|touch|alter|modify)\w*\s(?:the\s|any\s)?(?:look|ui|ux|design|appearance|layout|styles?|styling|visuals?|css|screens?)\b|\bsame\s(?:look|ui|appearance|layout|visuals?|design|screens?|renders?)\b|\b(?:look|ui|visuals?|appearance|layout|screens?|design)\s(?:stays?|remains?)\s(?:the\s)?(?:same|unchanged|identical)\b|\b(?:pixel|visually)[\s-]?identical\b|بدون\s?تغییر\s?(?:ظاهر|ظاهری|در\sظاهر|ui|طراحی|استایل|رابط)|(?:ظاهر|استایل|طراحی|ui)\s?(?:را\s)?(?:تغییر|عوض)\s?(?:نده|ندهید|ندید|نکن|نکنید|نکند|نکنه|نشود|نشه)|ریفکتور/i;
// Talk about the checks themselves gives no evidence: "the pixel checks are heavy", "what do u mean". FA: checks (plural), check of ui/pixel/Figma/look.
const TALK = /\b(?:ui|ux|pixel|visual|design|figma|screen)[\s-]?(?:perfect[\s-]?)?(?:checks?|checkers?|checking|gates?|chains?|loops?|proofs?|qa|jobs?|rounds?)\b|\bchecks\b|\b(?:visual-qa|ui-check|ui-proof|ui-coverage|done-check|skill[\s-]?router|router|check[\s-]plan)\b|\bwhat\sdo(?:es)?\s(?:u|you|ya|it|this|that)\smean\b|(?:چک|تست|بررسی)[\s‌]?ها|(?:چک|تست|بررسی)[\s‌](?:ی[\s‌])?(?:ui|یو[\s‌]?آی|پیکسل|فیگما|ظاهر)/i;
// EN negation reaches forward ("don't ... pixel perfect"); "is not pixel perfect" is a complaint, not a negation.
const EN_NEGATOR = /\b(?:no|never|without|skip|skipping|stop|nothing|avoid|cannot|(?:do|does|did|should|must|wo|ca)n'?t)\b|(?<!\b(?:is|are|was|were|it's|looks?|seems?)\s)\bnot\b/i;
// FA negation sits in the verb at the clause end, so it counts anywhere in the clause (outside the matched phrase).
const FA_NEGATOR = /(?<=^|[\s‌])(?:نکن(?:ید|ی|ین|ه)?|نده(?:ید)?|ندی[دن]|نزن(?:ید|ین)?|نساز(?:ید|ین)?|نباید|نخواه|بدون|نه|هرگز|نمی)(?=$|[\s‌])/;
// Double negation keeps the evidence: "don't skip the ui checks", FA "do not drop / reduce / remove".
const AFFIRM = /\b(?:don'?t|do\snot|never|no|without)\s(?:skip(?:ping)?|drop(?:ping)?|los(?:e|ing)|sacrific(?:e|ing)|cut(?:ting)?|stop(?:ping)?|ignor(?:e|ing)|miss(?:ing)?)\b|(?:رد|کم|حذف|فراموش)[\s‌]?(?:نکن|نکنید|نشه|نشود)/gi;
const CLAUSE_BREAK = /[.!?;,\n\r،؛؟…]+|\s(?:but|however)\s|\s(?:ولی|اما)\s/i; // the router's clauses
const PART_BREAK = new RegExp(`${CLAUSE_BREAK.source}|\\s(?:and|then|also|so|plus)\\s|\\s(?:و|سپس|بعد)\\s`, 'i'); // finer, for design words

const globalOf = (pattern) => new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
const DESIGN_ALL = globalOf(DESIGN_WORDS);
const NO_CHANGE_ALL = globalOf(NO_CHANGE_WORDS);
const UI_ALL = globalOf(UI_WORDS);
const FIGMA_LINK_ALL = globalOf(FIGMA_LINK);
const FA_NEGATOR_ALL = globalOf(FA_NEGATOR);

/** The request as lower-case text, capped at 1 MB, FA letters unified, spaces collapsed. @throws {TypeError} on a non-string */
function requestText(text) {
  if (text === null || text === undefined) return '';
  if (typeof text !== 'string') throw new TypeError('request text must be a string');
  const bytes = new TextEncoder().encode(text.slice(0, MAX_REQUEST_BYTES)).subarray(0, MAX_REQUEST_BYTES);
  return new TextDecoder().decode(bytes).toLowerCase().replace(/[’‘]/g, "'").replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/[ \t\f\v ]+/g, ' ');
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

/** Each clause of `text` split by `breaks`, double negations blanked, talk clauses left out. */
const evidenceClauses = (text, breaks) =>
  text.split(breaks).map((clause) => clause.replace(AFFIRM, (phrase) => ' '.repeat(phrase.length))).filter((clause) => !TALK.test(clause));

const phrases = (found) => [...new Set(found.map((phrase) => phrase.trim().slice(0, MAX_PHRASE_CHARS)))].slice(0, MAX_PHRASES);

function evidenceOf(text) {
  const design = [...text.matchAll(FIGMA_LINK_ALL)].map((match) => match[0]);
  const noChange = [];
  for (const clause of evidenceClauses(text, PART_BREAK)) {
    design.push(...unnegatedMatches(clause, DESIGN_ALL));
    noChange.push(...unnegatedMatches(clause, NO_CHANGE_ALL));
  }
  return { design: phrases(design), noChange: phrases(noChange) };
}

/**
 * Design and no-change evidence in a request (the brief, STATUS rules and decisions). Talk clauses and negated phrases give nothing,
 * except a Figma link, which counts anywhere.
 * @param {string|null|undefined} text untrusted request text (only the first 1 MB is read)
 * @returns {{ design: string[], noChange: string[] }} the matched phrases (short, lower-case, at most 20 each)
 * @throws {TypeError} when text is neither a string nor null/undefined
 */
export const requestEvidence = (text) => evidenceOf(requestText(text));

/**
 * For the skill router: does the request ask for design work, and does it ask for UI work at all? Talk and negated clauses are removed.
 * @param {string|null|undefined} text untrusted prompt text
 * @returns {{ design: boolean, ui: boolean }} design: as requestEvidence; ui: design, or a UI noun in a clause that is neither talk nor negated
 */
export function uiClauses(text) {
  const request = requestText(text);
  const design = evidenceOf(request).design.length > 0;
  return { design, ui: design || evidenceClauses(request, CLAUSE_BREAK).some((clause) => unnegatedMatches(clause, UI_ALL).length > 0) };
}
