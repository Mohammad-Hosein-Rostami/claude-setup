// Literal secrets typed into a Bash command. Exports: findLiteralSecret(command) -> string | undefined; maskSecrets(command) -> string;
// literalSecretValues(command) -> string[] (the raw values, for lib/allowed-literals.mjs, which only hashes them; never log or print them).
// Returns only a KIND label ("an Anthropic API key", ...), never the secret itself: the caller prints it in a deny message.
// Detected: sk-ant-..., ghp_/gho_/ghu_/ghs_/ghr_/github_pat_ tokens, AWS access key ids, `--password=x` / `--password x`,
// `sshpass -p x`, `mysql -pX`, `docker login -p x`, PGPASSWORD / MYSQL_PWD / AWS_SECRET_ACCESS_KEY assigned a literal, any
// `*_KEY=` / `*_TOKEN=` / `*_SECRET=` / `*PASSWORD=` assigned a literal, sk-proj- / glpat- / xoxb- / xoxp- tokens, `Bearer x`
// (so `Authorization: Bearer x` too), `-u user:pass` / `--user user:pass`, and URL credentials `scheme://user:pass@host`.
// A value that starts with `$` (variable, `$(cat file)`), a backtick or `<(` is not literal; nor, for a generic `*_KEY=` style name, one that starts like a path (`/`, `./`, `../`, `~/`). Scans the raw text, so quotes,
// heredocs and `bash -c '...'` are all covered. A noisy false positive is accepted: the check is meant to be strict (the hook turns a hit into a timed ask).
// Also: a literal given on stdin to a `--with-token` / `--password-stdin` command: `gh auth login --with-token <<< T`, `echo T | docker login
// --password-stdin` (`echo`/`printf` input; `$VAR` and `$(...)` input is not literal).
// Also: SSHPASS=, `vault login <token>`, `--from-literal=<k>=<v>` (k names a pass/secret/token/key), `az ... -p`, `htpasswd -b`,
// `aws configure set *secret* <v>`.
// Linear time (Round 4): every pattern is anchored at a rare literal and every gap between a prefix and its value is a BOUNDED repeat
// of disjoint alternatives (no unbounded nested or overlapping quantifier), so the cost is input length x a small constant. Input beyond
// MAX_SCAN_CHARS is not scanned (the hook asks about a command that long before it gets here); maskSecrets cuts it and says so.

import { MIN_VALUE_LENGTH } from './allowed-literals.mjs';

const TOKEN_KINDS = [
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/, 'an Anthropic API key'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/, 'a GitHub token'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\bsk-proj-[A-Za-z0-9_-]{10,}/, 'an OpenAI API key'],
  [/\bglpat-[A-Za-z0-9_-]{10,}/, 'a GitLab token'],
  [/\bxox[bp]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
];
const MAX_SCAN_CHARS = 32 * 1024;
const GAP = 300; // longest stretch between a command word and its flag that is still looked at
const NAME_MAX = 80; // longest variable, header or scheme name that is still looked at
const SECRET_ENV = '(?:PGPASSWORD|MYSQL_PWD|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|SSHPASS)';
const NOT_LITERAL_START = '(?!["\']?(?:\\$|`|<|\\s|;|&|\\||$))';
const VALUE = `["']?[^\\s"';&|]`;
// What the masker hides after a prefix: a whole quoted string or one unquoted word.
const VALUE_RUN = `"[^"]*"|'[^']*'|[^\\s"';&|]+`;
// [prefix, extra lookahead, kind, options]: the prefix ends right before the value, so one table drives both detection and
// masking. options.value replaces the detected/masked value pattern, options.flags are the regex flags (e.g. 'i'), options.start replaces NOT_LITERAL_START.
const BOUNDARY = `(?:^|[\\s;&|("'])`;
// URL userinfo: the password runs to the LAST `@` of the word, so one containing `@` or `/` is still covered. A `:port/@scope`
// (`http://localhost:5173/@vite/client`) is not a password: digits followed by `/ ? #` or the end are a port.
const URL_PASSWORD = '[^\\s"\']{0,500}(?=@)';
const URL_NOT_A_PORT = '(?!\\d+(?:[/?#"\'\\s]|$))';
// curl-family commands, quote-aware so `-H "X: a;b"` does not end the command early; `-u user:pass` is only a credential for these
const HTTP_TOOL = `\\b(?:curl|wget|http|https|xh|hurl)\\b(?:"[^"\\n]{0,${GAP}}"|'[^'\\n]{0,${GAP}}'|[^\\n|;&"']){0,${GAP}}?`;
// A header value is a literal unless it contains a variable, a substitution or a placeholder (`Bearer $TOKEN`, `Bearer <token>`).
const HEADER_VALUE = `(?![^"'\\n]{0,500}[$\`<])[^"'\\n]{1,500}`;
// `Authorization`, `Proxy-Authorization`, any hyphenated `...-Key/-Token/-Secret` name (`X-Api-Key`, `PRIVATE-TOKEN`), `Cookie`
// Spelled with `caseless` (no 'i' flag) so FORMAT_PLACEHOLDER below can test for lowercase.
const caseless = (letters) => letters.replace(/[a-z]/gi, (char) => `[${char.toLowerCase()}${char.toUpperCase()}]`);
const HEADER_NAME = `(?:(?:${caseless('Proxy-')})?${caseless('Authorization')}|[A-Za-z0-9]{1,${NAME_MAX}}-[\\w-]{0,${NAME_MAX}}(?:${caseless('key|token|secret')})|${caseless('Cookie')})`;
// A header value that is only a printf/format placeholder (`%v %+v %s %q %5.2f`, `%(name)s`, `{}` `{0}` `{name}`) up to the closing quote or line end
// is a format string in program text (`t.Errorf("bad cookie: %+v", c)`), not a credential. A verb glued to more text (`%s3cr3t`) is still a value,
// and a brace or `%(...)s` name only counts when it is a short lowercase identifier (`{R}` / `%(R)s` with R a token is a value).
const PLACEHOLDER_NAME = '[a-z_][a-z0-9_]{0,19}';
const PLACEHOLDER_SPEC = '[<>^=+ #0-9.,_a-z%-]{0,10}';
const PLACEHOLDER = `(?:%[-+# 0]{0,5}(?:\\d{1,3}|\\*)?(?:\\.(?:\\d{1,3}|\\*))?[a-zA-Z]|%\\(${PLACEHOLDER_NAME}\\)[-+# 0]{0,5}\\d{0,3}[a-zA-Z]|\\{(?:\\d{1,2}|${PLACEHOLDER_NAME})?(?::${PLACEHOLDER_SPEC})?\\})`;
// It ends at the quote that opened the header string (`\k<q>`, found by looking back) or at the line end when unquoted: `"X: %s'R'"` is not a placeholder.
const FORMAT_PLACEHOLDER = `(?!(?<=(?<![\\w])(?<q>["'])[^"'\\n]{0,500})${PLACEHOLDER}[ \\t]*\\k<q>|${PLACEHOLDER}[ \\t]*(?:\\n|$))`;
const STDIN_FLAG = '--(?:with-token|password-stdin)\\b';
// the value is echoed/printed (`echo -n T`, `printf '%s' T`) and piped into a command that has the stdin flag
const ECHOED_INTO_STDIN_FLAG = `(?=(?:"[^"]*"|'[^']*'|[^\\s"';&|]+)[ \\t]*\\|[^\\n;&|]{0,${GAP}}${STDIN_FLAG})`;
const SECRET_NAME_PART = '(?<![A-Za-z0-9])(?:KEY|TOKEN|SECRET|PASS|PASSWD|PWD)(?![A-Za-z0-9])';
// A value that looks like a path or a regex held in a variable is not a literal: `./x`, `../x`, `~/x`; a `/x|y/` regex (`STATE_KEY=/state|hover/`);
// `/x` under a common absolute root (`KEY_PATH=/Users/x/k.pem`). A bare leading `/` is not enough: about 1 in 64 base64 keys starts with one.
const ABSOLUTE_ROOTS = 'Users|home|tmp|private|var|etc|opt|usr|Volumes';
// a regex value has its `|` inside the value: in its own quotes, or unquoted and closed by a `/` plus JS flags (`/a|b/i;`; else `KEY=/<b64>|tee` would pass)
const REGEX_VALUE = `"/[^"\\n]{0,500}\\|[^"\\n]{0,500}"|'/[^'\\n]{0,500}\\|[^'\\n]{0,500}'|/[^\\s"';&|]{0,500}\\|[^\\s"';&]{0,500}/[dgimsuvy]{0,8}(?![^\\s;&|),])`;
// A template expression that reads something (`{{t .L "x"}}`, `{{ .Password }}`, `{{ user.password }}`, `{{ pw | e }}`, `{% .x %}`): it opens with `.` or an
// identifier followed by `.`, `|` or an argument, and is closed. `{{R}}`, `{{ R }}` and `{{ "R" }}` hold a literal, so they are not exempt.
const TEMPLATE_VALUE = `(?:\\\\?["'])?(?:\\{\\{-?|\\{%-?)[ \\t]{0,5}(?:\\.|[A-Za-z_]\\w{0,39}(?:\\.|[ \\t]{0,5}\\||[ \\t]{1,5}(?![ \\t}%-])))[^{}\\n]{0,200}(?:\\}\\}|%\\})(?![A-Za-z0-9])`;
const CODE_VALUE = `(?!${REGEX_VALUE}|${TEMPLATE_VALUE}|["']?(?:(?:\\.{1,2}|~)/|/(?:${ABSOLUTE_ROOTS})/)|[=>(\\[]|\\{(?!\\{)|[\\w$]{1,40}\\s*=>|lambda\\b|[\\w$]{1,40}(?:\\.[\\w$]{1,40}){0,6}\\s*[(\\[])`;
const QUERY_TOKEN_KEYS = caseless('api[_-]?key|access[_-]?(?:token|key)|auth[_-]?token|token');
const QUERY_SECRET_KEYS = caseless('client[_-]?secret|secret|password|passwd|pwd');
// What may follow the end of a quoted or bracketed query value: whitespace, a closing bracket, `;`, `,` plus whitespace, or the end. Glued text
// (`"/R`, `".R`, `)R`, `}R`) means the value goes on, so it is not an end.
const QUERY_END = '(?=[\\s)};\\]]|,(?:\\s|$)|$)';
// A value under MIN_VALUE_LENGTH characters (quotes skipped, `&` `#` whitespace end it) is a test fixture (`token=t`), not a secret: the allow-list never remembers one either.
const QUERY_MIN_LENGTH = `(?=(?:["']?[^\\s"';&|#]){${MIN_VALUE_LENGTH}})`;
// A query value that is code, not a literal: empty and closed by a quote then `} )` or a `+` that is not followed by a quoted literal
// (`"/reset?token="+token`, not `+"R"`); a `$(...)`, `$x` or `${name}` / `${name:-}` reference, but not `${name:-R}` (a literal default).
const QUERY_CODE = `["'\`][ \\t]*(?:\\+(?![ \\t]*["'\`])|[})]${QUERY_END})|["']?\\$(?:\\(|\\w|\\{[\\w.]{1,80}(?::?[-=+?])?\\})`;
// `$` is judged by QUERY_CODE here, so the query rules do not use NOT_LITERAL_START (which skips every `$` value).
const QUERY_START = '(?!["\']?(?:`|<|\\s|;|&|\\||$))';
// A kebab-case mock word (`token=verify-ok`): lowercase (these rules have no 'i' flag), 24 chars at most, one hyphen at least, and it ENDS the
// value: a quote not followed by more value, whitespace, `&`, `#`, `)` or the end. Only for token-like keys, never password/secret keys.
const QUERY_MOCK_WORD = `(?=[a-z-]{1,24}(?![\\w-]))[a-z]+(?:-[a-z]+)+(?:["'](?:${QUERY_END}|[ \\t]*\\+(?![ \\t]*["'\`]))|\\)${QUERY_END}|[\\s&#]|$)`;
const QUERY_NOT_LITERAL = `${QUERY_MIN_LENGTH}(?!${QUERY_CODE})`;
const QUERY_TOKEN_NOT_LITERAL = `${QUERY_MIN_LENGTH}(?!${QUERY_CODE}|${QUERY_MOCK_WORD})`;
const SECRET_FLAG = '--(?:token|api-key|apikey|password|passwd|client-secret|access-token|auth-token)(?:=|\\s+)';
const VALUE_KINDS = [
  [`(?:^|[\\s;&|("'])${SECRET_ENV}=`, '', 'a password or key assigned in the command'],
  [SECRET_FLAG, '(?!-)', 'a password, token or key flag with a literal value'],
  [`${STDIN_FLAG}[^\\n|;&<]{0,${GAP}}?<<<[ \\t]*`, '', 'a token or password given as a here-string'],
  [`\\b(?:echo|printf)\\b[ \\t]+(?:-[a-zA-Z]+[ \\t]+){0,3}(?:(?:"%s(?:\\\\n)?"|'%s(?:\\\\n)?'|%s)[ \\t]+)?`, ECHOED_INTO_STDIN_FLAG, 'a token or password piped to a stdin flag'],
  ['\\bsshpass\\s+(?:-\\w*\\s+){0,10}-p\\s*', '', 'an sshpass password'],
  [`\\b(?:mysql|mysqladmin|mysqldump|mariadb)\\b[^\\n|;&]{0,${GAP}}?\\s-p`, '', 'a mysql password flag with a literal value'],
  [`\\bdocker\\s+login\\b[^\\n|;&]{0,${GAP}}?\\s-p\\s+`, '', 'a docker login password'],
  [`\\bvault\\s+login\\s+(?:-[\\w-]+(?:=\\S*)?\\s+){0,6}`, '(?![^\\s"\']*=)', 'a vault token'],
  [`\\bvault\\s+login\\b[^\\n|;&]{0,${GAP}}?\\spassword=`, '', 'a vault password'],
  [`--from-literal(?:=|\\s+)[\\w.-]{0,${NAME_MAX}}(?:pass|secret|token|key)[\\w.-]{0,${NAME_MAX}}=`, '', 'a secret given with --from-literal', { flags: 'i' }],
  [`\\baz\\s[^\\n|;&]{0,${GAP}}?\\s-p(?:=|\\s+)`, '(?!-)', 'an Azure CLI password'],
  ['\\bhtpasswd\\s+(?:-[a-zA-Z]+\\s+){0,2}-[a-zA-Z]*b[a-zA-Z]*\\s+(?:-[a-zA-Z]+\\s+){0,2}[^\\s"\']+\\s+[^\\s"\']+\\s+', '', 'an htpasswd password'],
  [`\\baws\\s+configure\\s+set\\s+(?:--profile\\s+\\S+\\s+)?[\\w.-]{0,${NAME_MAX}}secret[\\w.-]{0,${NAME_MAX}}\\s+`, '', 'an AWS secret key set with aws configure', { flags: 'i' }],
  // any variable whose name has KEY, TOKEN, SECRET, PASS, PASSWD, PWD or PASSWORD as a part (`DB_PASS`, `TOKEN_FILE_X`, `ADMINPASSWORD`)
  // CODE_VALUE (a `{{` is a template, judged by TEMPLATE_VALUE): `key==x`, `key=>x`, `const key=s=>...`, `token=[]`, `key=(a)`, `token=fs.readFileSync(p)`, `key=lambda s:` are program code (heredocs, node -e), not literals
  [`${BOUNDARY}[\\w.-]{0,${NAME_MAX}}(?:${SECRET_NAME_PART}|PASSWORD)[\\w.-]{0,${NAME_MAX}}=`, CODE_VALUE, 'a key, token, secret or password assigned in the command', { flags: 'i' }],
  [`[?&](?:${QUERY_TOKEN_KEYS})=`, QUERY_TOKEN_NOT_LITERAL, 'a token or key in a URL query string', { start: QUERY_START }],
  [`[?&](?:${QUERY_SECRET_KEYS})=`, QUERY_NOT_LITERAL, 'a password or secret in a URL query string', { start: QUERY_START }],
  [`\\bredis-cli\\b[^\\n|;&]{0,${GAP}}?\\s(?:-a|--pass)\\s+`, '', 'a redis password'],
  ['(?<![A-Za-z0-9])_(?:authToken|auth|password)=|(?<![A-Za-z0-9])_authToken\\s+', '', 'an npm registry credential', { flags: 'i' }],
  ['\\bBearer\\s+', '', 'a bearer token', { flags: 'i' }],
  [`${HTTP_TOOL}\\s(?:-u|--user)(?:=|\\s*)[^\\s:"']*:`, '', 'a user:password pair', { value: '["\']?[^\\s"\';&|]+["\']?' }],
  [`${HTTP_TOOL}\\s(?:-u|--user)(?:=|\\s*)["'][^"':]*:`, '', 'a user:password pair', { value: '[^"\']+' }],
  [`\\b${HEADER_NAME}\\s*:[ \\t]*`, FORMAT_PLACEHOLDER, 'a credential header with a literal value', { value: HEADER_VALUE }],
  [`(?<!\\b(?:docker|podman|buildx|buildah)\\b[^\\n|;&]{0,${GAP}})--secret(?:=|\\s+)`, '(?!-)', 'a secret flag with a literal value'],
  ['\\b[a-z][a-z0-9+.-]{0,30}://[^\\s/@:"\']{1,200}:', URL_NOT_A_PORT, 'a password inside a URL', { value: URL_PASSWORD, flags: 'i' }],
].map(([prefix, lookahead, kind, { value, flags = '', start = NOT_LITERAL_START } = {}]) => ({
  kind,
  detect: new RegExp(`${prefix}${start}${lookahead}${value ?? VALUE}`, flags),
  mask: new RegExp(`(${prefix})${start}${lookahead}(?:${value ?? VALUE_RUN})`, `g${flags}`),
}));
const MASK = '[masked]';

/**
 * @param {string} command raw command text
 * @returns {string | undefined} what kind of secret was found, or undefined; never the value
 */
export function findLiteralSecret(command) {
  command = command.slice(0, MAX_SCAN_CHARS);
  for (const [pattern, kind] of TOKEN_KINDS) {
    if (pattern.test(command)) return kind;
  }
  return VALUE_KINDS.find(({ detect }) => detect.test(command))?.kind;
}

/**
 * Hides every literal secret findLiteralSecret detects, so the text can go to a dialog or a log.
 * @param {string} command raw command text
 * @returns {string} the command with each secret value replaced by "[masked]"
 */
export function maskSecrets(command) {
  let text = command.slice(0, MAX_SCAN_CHARS);
  for (const [pattern] of TOKEN_KINDS) text = text.replace(new RegExp(pattern.source, 'g'), MASK);
  for (const { mask } of VALUE_KINDS) text = text.replace(mask, `$1${MASK}`);
  return command.length > MAX_SCAN_CHARS ? `${text}[...cut]` : text;
}

const WORD_REST = /^[^\s;&|]*/;
const QUOTES = /["']/g;

/** The value plus whatever continues the same shell word (`'known'TAIL` is one word), quotes removed. */
const wholeWord = (text, valueText, end) => `${valueText}${text.slice(end).match(WORD_REST)[0]}`.replace(QUOTES, '');

/**
 * Every literal secret value the rules above find (same patterns and scan limit as findLiteralSecret/maskSecrets). A value
 * is the whole shell word it sits in, quotes removed, so a value with text glued on (`'known'TAIL`) is the combined word.
 * The values are raw: the caller must hash them and never print or store them.
 * @param {string} command raw command text
 * @returns {string[]} distinct non-empty values, in the order the rules found them
 */
export function literalSecretValues(command) {
  const text = command.slice(0, MAX_SCAN_CHARS);
  const found = [];
  for (const [pattern] of TOKEN_KINDS) {
    for (const match of text.matchAll(new RegExp(pattern.source, 'g'))) found.push(wholeWord(text, match[0], match.index + match[0].length));
  }
  for (const { mask } of VALUE_KINDS) {
    for (const match of text.matchAll(mask)) found.push(wholeWord(text, match[0].slice(match[1].length), match.index + match[0].length));
  }
  return [...new Set(found.filter((value) => value !== ''))];
}
