// `.env` read detection for pre-bash-guard. Exports: isEnvFile(path), envReadHit(cmd, args, tokens) -> path | undefined.
// This is a READER DENYLIST, not a sandbox: only commands listed in READERS (plus curl/wget uploads, cp-like sources,
// `dd if=` and `< file` redirection on any command) are inspected. Anything else is allowed, because a missed block
// is cheaper than a false block of a normal dev command. Commands that merely consume env for a run
// (`node --env-file=.env`, `docker compose --env-file .env`, `dotenv -e .env -- cmd`, ls, rm, touch) are not readers.
import { basenameOf, optionKinds, parseArgs } from './shell-words.mjs';

const ENV_FILE = /^\.env(\..+)?$/;
const ENV_TEMPLATE = /\.(example|sample|template)$/;
const ENV_NAMES = ['.env', '.env.local', '.env.production'];
const GLOB_CHARS = /[*?[]/;
const INPUT_REDIRECT = /^\d*<(?![<&(])/; // `<>` opens read-write: its input side reads
const HOST_PREFIX = /^[^/\\:]+:/;

/** Lowercased basename without trailing dots (Windows ignores them): `.ENV.` -> `.env`. */
const envName = (path) => basenameOf(path).toLowerCase().replace(/\.+$/, '');

/** `.env`-like name (quotes already removed). A glob counts only when its basename starts with a literal `.`; templates are allowed. */
export function isEnvFile(path) {
  const name = envName(path);
  if (ENV_TEMPLATE.test(name)) return false;
  if (!GLOB_CHARS.test(name)) return ENV_FILE.test(name);
  if (!name.startsWith('.')) return false;
  const pattern = name.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  try {
    const glob = new RegExp(`^${pattern}$`);
    return ENV_NAMES.some((n) => glob.test(n));
  } catch {
    return false; // malformed class such as `[`: not a glob we can reason about
  }
}

const spec = (options = [], extra = {}) => ({ options: new Map(options), ...extra });
const GREP_OPTIONS = [
  ...optionKinds('pattern', '-e', '--regexp'), ...optionKinds('file', '-f', '--file'),
  ...optionKinds('value', '-A', '-B', '-C', '-m', '-d', '-D', '-g', '-t', '-j', '--include', '--exclude',
    '--exclude-dir', '--max-count', '--context', '--after-context', '--before-context', '--label', '--binary-files',
    '--glob', '--iglob', '--type', '--type-not', '--threads', '--max-depth', '--replace', '--sort', '--sortr', '--ignore'),
];
const JQ = spec([
  ...optionKinds('file', '-f', '--from-file'), ...optionKinds('value2', '--arg', '--argjson'),
  ...optionKinds('namedfile', '--slurpfile', '--rawfile'), ...optionKinds('value', '--indent'),
], { firstIsPattern: true });
// node/python: only the script argument is a file; inline code (-e, -c, -m) ends the file arguments.
const NODE = spec([
  ...optionKinds('rest', '-e', '-p', '-pe', '--eval', '--print'),
  ...optionKinds('value', '--env-file', '--env-file-if-exists', '-r', '--require', '--import', '--loader'),
], { firstOnly: true });
const PYTHON = spec([...optionKinds('rest', '-c', '-m'), ...optionKinds('value', '-W', '-X')], { firstOnly: true });
const SCRIPT_RUNNER = spec([...optionKinds('pattern', '-e', '-E'), ...optionKinds('value', '-I', '-r')]);
const SOURCE_COPY = spec(optionKinds('target', '-t', '--target-directory'));
const SOURCE_COPY_VALUES = [...optionKinds('value', '-m', '-o', '-g', '-S', '--mode', '--owner', '--group', '--suffix')];
const SOURCE_ONLY = new Map([
  ['cp', SOURCE_COPY], ['mv', SOURCE_COPY], ['install', spec([...SOURCE_COPY.options, ...SOURCE_COPY_VALUES])],
  ['scp', spec(optionKinds('value', '-P', '-i', '-o', '-F', '-J', '-l', '-S', '-c'))],
  ['rsync', spec(optionKinds('value', '-e', '--rsh', '--exclude', '--include', '--filter', '-f', '--port', '--exclude-from',
    '--include-from', '--files-from', '--bwlimit', '--chmod', '--backup-dir', '--suffix', '-M', '-B'))],
]);
const TRANSFER = spec([
  ...optionKinds('file', '-T', '--upload-file', '--post-file', '--body-file'),
  ...optionKinds('data', '-d', '--data', '--data-ascii', '--data-binary', '--data-raw', '--data-urlencode', '--json', '-F', '--form'),
], { optionFilesOnly: true });
const READERS = new Map([
  ...['cat', 'type', 'less', 'more', 'head', 'tail', 'bat', 'get-content', 'gc', 'source', '.', 'base64', 'xxd', 'od', 'strings',
    'nl', 'tac', 'sort', 'cut', 'diff', 'cmp', 'comm', 'paste', 'uniq', 'rev', 'fold', 'column', 'tr', 'iconv', 'openssl', 'gzip',
  ].map((name) => [name, spec()]),
  ['grep', spec(GREP_OPTIONS, { firstIsPattern: true })], ['rg', spec(GREP_OPTIONS, { firstIsPattern: true })],
  ['ag', spec(GREP_OPTIONS, { firstIsPattern: true })],
  ['sed', spec([...optionKinds('pattern', '-e', '--expression'), ...optionKinds('file', '-f', '--file'),
    ...optionKinds('value', '-l', '--line-length')], { firstIsPattern: true })],
  ['awk', spec([...optionKinds('file', '-f'), ...optionKinds('value', '-v', '-F')], { firstIsPattern: true })],
  ['jq', JQ], ['yq', JQ],
  ['tar', spec(optionKinds('value', '--exclude', '--exclude-from', '-C', '--directory', '--transform', '-I', '--use-compress-program'))],
  ['zip', spec(optionKinds('rest', '-x', '-i'))],
  ['node', NODE], ['python', PYTHON], ['python3', PYTHON], ['ruby', SCRIPT_RUNNER], ['perl', SCRIPT_RUNNER],
]);

/** Paths a command would read: reader file arguments, copy sources, upload files, `dd if=`. */
function readCandidates(cmd, args) {
  if (cmd === 'curl' || cmd === 'wget') return parseArgs(args, TRANSFER).files;
  if (cmd === 'dd') return args.filter((a) => a.startsWith('if=')).map((a) => a.slice(3));
  const copy = SOURCE_ONLY.get(cmd);
  if (copy) {
    const { files, target } = parseArgs(args, copy);
    const sources = target ? files : files.slice(0, -1); // the last argument is the destination
    return cmd === 'scp' || cmd === 'rsync' ? sources.map((s) => s.replace(HOST_PREFIX, '')) : sources;
  }
  const reader = READERS.get(cmd.toLowerCase());
  if (!reader) return [];
  const { files } = parseArgs(args, reader);
  return reader.firstOnly ? files.slice(0, 1) : files;
}

// `cat < .env` / `0<.env` / `<>.env`: input redirection reads the file without the command naming it, on any command.
function redirectCandidates(tokens) {
  return tokens.flatMap((t, i) => (INPUT_REDIRECT.test(t) ? [t.replace(/^\d*<>?/, '') || tokens[i + 1]] : [])).filter(Boolean);
}

/**
 * The first `.env` path this command line segment would read, or undefined.
 * @param {string} cmd bare command name
 * @param {string[]} args words after the command
 * @param {string[]} tokens the whole segment (for redirections)
 */
export function envReadHit(cmd, args, tokens) {
  return [...redirectCandidates(tokens), ...readCandidates(cmd, args)].find(isEnvFile);
}
