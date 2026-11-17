// Purpose: decide which classes (docs, logic, security, concurrency ...) a diff belongs to, per file and per hit.
// Exports: CLASS_TIER (class name -> tier, in the order classes are listed: highest risk first), RISKY_CLASSES, LOCK_TAG,
//   RACE_TAG, MAX_HITS_PER_CLASS_FILE, tierOf(classes), isCodeFile(path), classifyFiles(files, readNewFile).
// Invariants: line texts are matched in memory and never stored: a hit is only {class, path, line}. Tests and docs carry no
//   risky class and no line test; prose files (.md .txt) carry no line test (path tests still apply, except for docs).
//   A file-level condition ("also has a write call") reads the whole new file once, through `readNewFile(path)`.
//   Concurrency hits are tagged: LOCK_TAG (a lock: stale-lock stress plan) or RACE_TAG (a lock-free race: concurrent-actors
//   check); the tags ride in fileClasses so the next delta round keeps the plan kind (A.1, lead decision 2).

/** Class name -> tier (0 docs ... 3 concurrency). Key order is the display order. */
export const CLASS_TIER = {
  concurrency: 3, security: 2, data: 2, money: 2, 'untrusted-input': 2, audit: 2, 'concurrency-lite': 2, size: 2,
  ui: 1, infra: 1, logic: 1, behaviour: 1, tests: 1, docs: 0,
};
/** Classes whose review gets an Opus max lens (listed concurrency first). */
export const RISKY_CLASSES = ['concurrency', 'security', 'data', 'money', 'untrusted-input'];
export const LOCK_TAG = 'lock-based';
export const RACE_TAG = 'lock-free';
export const MAX_HITS_PER_CLASS_FILE = 20; // a huge generated file must not make the JSON huge

const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'cargo.lock', 'poetry.lock', 'go.sum']);
const PROSE = /\.(md|mdx|txt|rst)$/;
const BEHAVIOUR_PATH = /(^|\/)(claude|agents)\.md$|(^|\/)\.claude\/|^home\/(claude\.md|(modes|rules|agents|skills|standards|workflows)\/)/;
const DOC_PATH = /(^|\/)(readme|changelog|license)[^/]*$|(^|\/)docs\/|\.(md|txt|png|jpg)$/;
const TEST_PATH = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\./;
const UI_PATH = /\.(tsx|jsx|vue|svelte|css|scss)$/;
const INFRA_PATH = /(^|\/)(dockerfile|docker-compose[^/]*|\.github\/|k8s\/|terraform\/|helm\/)|\.tf$/;
const SECURITY_PATH = /auth|login|session|token|secret|credential|passw|crypto|permission|guard|sandbox|sanitiz|upload|webhook|oauth|jwt|cookie|csrf|cors/;
const DATA_PATH = /(^|\/)(migrations?|prisma)\/|\.sql$|schema\./;
const MONEY_WORDS = 'payment|invoice|billing|refund|checkout|stripe|wallet|ledger';
const NOT_SHOP = '(?<!git\\s+|stale-)'; // `git checkout` and git-tidy's `stale-checkout` are not a shop checkout
const MONEY_PATH = new RegExp(`${NOT_SHOP}(${MONEY_WORDS})`);
const HOOKS_PATH = /(^|\/)hooks\//;
const LOCK_WORD = /^(un)?lock(s|ed|ing|file)?$/;
const SIZE_LINES = 400;

// A write call somewhere in the file: what makes a timer, Promise.all or link() a shared-file race.
const WRITE_CALL = /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync)\b|openSync\([^)]*['"][wa]/;
// Anything that acts on the file system after a check: what makes an existsSync/stat a stat-then-act race.
const ACT_CALL = /\b(writeFile(Sync)?|appendFile(Sync)?|copyFile(Sync)?|rm(Sync)?|rename(Sync)?|mkdir(Sync)?|open(Sync)?|unlink(Sync)?|rmdir(Sync)?)\(|\bcreateWriteStream\b/;
const TRUSTED_ARGUMENT = /^(__dirname|__filename|import\.meta\.(dirname|filename|url)|process\.cwd\(\)|(os\.)?(homedir|tmpdir)\(\)|(fileURLToPath|dirname)\(.*\))$/;
const LITERAL_ARGUMENT = /^(['"][^'"]*['"]|`[^`$]*`|\d+)$/;

/** The text of the arguments of the first `callName(` on the line (balanced on that line, else to its end). */
function argumentsOf(line, callPattern) {
  const start = callPattern.exec(line);
  if (start === null) return null;
  const parts = [];
  let depth = 0;
  let current = '';
  for (let i = start.index + start[0].length; i < line.length; i++) {
    const char = line[i];
    if (char === ')' && depth === 0) break;
    if ('([{'.includes(char)) depth++;
    if (')]}'.includes(char)) depth--;
    if (char === ',' && depth === 0) { parts.push(current.trim()); current = ''; } else current += char;
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

const hasUntrustedArgument = (callPattern, allArguments) => (line) => {
  const parts = argumentsOf(line, callPattern);
  if (parts === null || parts.length === 0) return false;
  const untrusted = (part) => !LITERAL_ARGUMENT.test(part) && !TRUSTED_ARGUMENT.test(part);
  return allArguments ? parts.some(untrusted) : untrusted(parts[0]);
};

const words = (list) => new RegExp(`\\b(${list})s?\\b`, 'i');

/** Line rules. `test` gets one changed line; `alsoInFile` must match the whole new file; `tag` marks concurrency hits. */
const LINE_RULES = [
  { cls: 'concurrency', tag: LOCK_TAG, test: /\b(un)?lock(s|ed|ing|file)?\b|\bmutex\b|\bsemaphore\b|\bflock\b|\bO_EXCL\b|['"]wx\+?['"]|\bAtomics\.|\btransaction\b|FOR UPDATE|SERIALIZABLE/i },
  { cls: 'concurrency', tag: RACE_TAG, test: /\b(rename|unlink|rm|rmdir)(Sync)?\(/ },
  { cls: 'concurrency', tag: RACE_TAG, test: (line) => /\bmkdir(Sync)?\(/.test(line) && !/recursive/.test(line) },
  { cls: 'concurrency', tag: RACE_TAG, test: /\b(existsSync|stat|statSync|lstat|lstatSync|access|accessSync)\(/, alsoInFile: ACT_CALL },
  { cls: 'concurrency-lite', tag: LOCK_TAG, test: /\blink(Sync)?\(/, alsoInFile: WRITE_CALL },
  { cls: 'concurrency-lite', tag: RACE_TAG, test: /\bPromise\.all\(|\b(setTimeout|setInterval)\b/, alsoInFile: WRITE_CALL },
  { cls: 'security', test: /\b(execSync|execFile|spawn|spawnSync|child_process|eval)\b|new Function|innerHTML|dangerouslySetInnerHTML|shell:\s*true/i },
  { cls: 'security', test: /\bexec\b/, alsoInFile: /child_process|execa/ },
  { cls: 'security', test: words('password|secret|apiKey|api_key|bearer|jwt|createHash|createHmac|randomBytes|Authorization|cookie|permissionDecision') },
  { cls: 'security', test: /\$queryRaw|\.raw\(/ },
  { cls: 'data', test: /ALTER TABLE|DROP (TABLE|COLUMN|INDEX)|CREATE (TABLE|INDEX)|DELETE FROM|TRUNCATE TABLE|\b(deleteMany|updateMany|createMany)\b|\$executeRaw|\.(delete|update|upsert|destroy)\(\s*\{/i },
  { cls: 'data', test: /\bTRUNCATE\b/ }, // upper case only: `truncated` and truncate(text) are ordinary code
  { cls: 'money', test: new RegExp(`${NOT_SHOP}\\b(${MONEY_WORDS})s?\\b`, 'i') },
  { cls: 'untrusted-input', test: /\breq\.(body|query|params|headers)|\brequest\.(body|query|params|json\()|JSON\.parse\(|process\.stdin|readFileSync\(\s*(0|['"]\/dev\/stdin['"])/ },
  { cls: 'untrusted-input', test: hasUntrustedArgument(/\bfetch\(/, false) },
  { cls: 'untrusted-input', test: hasUntrustedArgument(/\bpath\.(join|resolve)\(/, true) },
];

const tokensOf = (path) => path.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/);
const baseName = (path) => path.slice(path.lastIndexOf('/') + 1).toLowerCase();

/** The tier of a set of classes (the highest; 0 for none). */
export const tierOf = (classes) => Math.max(0, ...[...classes].map((name) => CLASS_TIER[name] ?? 0));

/** The one base class of a path: behaviour, docs, tests, ui, infra or logic. */
function baseClass(path) {
  const lower = path.toLowerCase();
  if (BEHAVIOUR_PATH.test(lower)) return 'behaviour';
  if (DOC_PATH.test(lower) && !lower.endsWith('.svg')) return 'docs';
  if (TEST_PATH.test(lower)) return 'tests';
  if (UI_PATH.test(lower)) return 'ui';
  return INFRA_PATH.test(lower) ? 'infra' : 'logic';
}

/** True for a file that holds code (not docs, tests or prose): the diffs a mutation plan can apply to. */
export const isCodeFile = (path) => !['docs', 'tests'].includes(baseClass(path)) && !PROSE.test(path.toLowerCase());

/** Risky classes a path alone gives (with the concurrency tag when it is a lock file name). */
function pathClasses(path) {
  const lower = path.toLowerCase();
  const found = [];
  if (LOCKFILES.has(baseName(path)) || SECURITY_PATH.test(lower)) found.push({ cls: 'security' });
  if (DATA_PATH.test(lower)) found.push({ cls: 'data' });
  if (MONEY_PATH.test(lower)) found.push({ cls: 'money' });
  if (!LOCKFILES.has(baseName(path)) && tokensOf(path).some((token) => LOCK_WORD.test(token))) found.push({ cls: 'concurrency', tag: LOCK_TAG });
  if (HOOKS_PATH.test(lower)) found.push({ cls: 'audit' });
  return found;
}

/** Classifies one file: {classes, hits: [{class, path, line}]} (an `audit` class only when the file has no security hit). */
function classifyFile(file, readNewFile) {
  const base = baseClass(file.path);
  const classes = new Set([base]);
  const hits = [];
  const perClass = new Map();
  const record = (cls, tag, line) => {
    classes.add(cls);
    if (tag) classes.add(tag);
    const seen = (perClass.get(cls) ?? new Set());
    perClass.set(cls, seen);
    if (seen.size < MAX_HITS_PER_CLASS_FILE && !seen.has(line)) { seen.add(line); hits.push({ class: cls, path: file.path, line }); }
  };
  if (base !== 'docs') for (const { cls, tag } of pathClasses(file.path)) record(cls, tag, 0);
  const lineTested = !['docs', 'tests'].includes(base) && !PROSE.test(file.path.toLowerCase());
  if (lineTested) {
    let whole; // the whole new file, read at most once and only when a rule needs it
    const wholeFile = () => (whole ??= readNewFile(file.path) ?? '');
    for (const { line, text } of [...file.added, ...file.removed]) {
      for (const rule of LINE_RULES) {
        const matched = typeof rule.test === 'function' ? rule.test(text) : rule.test.test(text);
        if (matched && (rule.alsoInFile === undefined || rule.alsoInFile.test(wholeFile()))) record(rule.cls, rule.tag, line);
      }
    }
  }
  if (classes.has('security')) classes.delete('audit');
  return { classes, hits: classes.has('audit') || !classes.has('security') ? hits : hits.filter((hit) => hit.class !== 'audit') };
}

/**
 * Classifies every changed file.
 * @param {{path: string, added: {line: number, text: string}[], removed: {line: number, text: string}[]}[]} files
 * @param {(path: string) => string | null} readNewFile whole text of the file after the change, null when it is gone
 * @returns {{fileClasses: Object<string, string[]>, hits: {class: string, path: string, line: number}[], changedLines: number}}
 */
export function classifyFiles(files, readNewFile) {
  const fileClasses = {};
  const hits = [];
  let changedLines = 0;
  for (const file of files) {
    const result = classifyFile(file, readNewFile);
    const ordered = [...Object.keys(CLASS_TIER), LOCK_TAG, RACE_TAG].filter((name) => result.classes.has(name));
    fileClasses[file.path] = ordered;
    hits.push(...result.hits);
    changedLines += file.added.length + file.removed.length;
  }
  return { fileClasses, hits, changedLines };
}

/** True when `changedLines` is over the size limit (the `size` class). */
export const isSizeable = (changedLines) => changedLines > SIZE_LINES;
