// Literal secrets typed into a Bash command. Exports: findLiteralSecret(command) -> string | undefined; maskSecrets(command) -> string.
// Returns only a KIND label ("an Anthropic API key", ...), never the secret itself: the caller prints it in a deny message.
// Detected: sk-ant-..., ghp_/gho_/ghu_/ghs_/ghr_/github_pat_ tokens, AWS access key ids, `--password=x` / `--password x`,
// `sshpass -p x`, `mysql -pX`, `docker login -p x`, PGPASSWORD / MYSQL_PWD / AWS_SECRET_ACCESS_KEY assigned a literal, any
// `*_KEY=` / `*_TOKEN=` / `*_SECRET=` / `*PASSWORD=` assigned a literal, sk-proj- / glpat- / xoxb- / xoxp- tokens, `Bearer x`
// (so `Authorization: Bearer x` too), `-u user:pass` / `--user user:pass`, and URL credentials `scheme://user:pass@host`.
// A value that starts with `$` (variable, `$(cat file)`), a backtick or `<(` is not literal. Scans the raw text, so quotes,
// heredocs and `bash -c '...'` are all covered. A noisy false positive is accepted: the check is meant to be strict (the hook turns a hit into a timed ask).

const TOKEN_KINDS = [
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/, 'an Anthropic API key'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/, 'a GitHub token'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\bsk-proj-[A-Za-z0-9_-]{10,}/, 'an OpenAI API key'],
  [/\bglpat-[A-Za-z0-9_-]{10,}/, 'a GitLab token'],
  [/\bxox[bp]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
];
const SECRET_ENV = '(?:PGPASSWORD|MYSQL_PWD|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)';
const NOT_LITERAL_START = '(?!["\']?(?:\\$|`|<|\\s|;|&|\\||$))';
const VALUE = `["']?[^\\s"';&|]`;
// What the masker hides after a prefix: a whole quoted string or one unquoted word.
const VALUE_RUN = `"[^"]*"|'[^']*'|[^\\s"';&|]+`;
// [prefix, extra lookahead, kind, options]: the prefix ends right before the value, so one table drives both detection and
// masking. options.value replaces the detected/masked value pattern, options.flags are the regex flags (e.g. 'i').
const BOUNDARY = `(?:^|[\\s;&|("'])`;
// URL userinfo: the password runs to the LAST `@` of the word, so one containing `@` or `/` is still covered. A `:port/@scope`
// (`http://localhost:5173/@vite/client`) is not a password: digits followed by `/ ? #` or the end are a port.
const URL_PASSWORD = '[^\\s"\']*(?=@)';
const URL_NOT_A_PORT = '(?!\\d+(?:[/?#"\'\\s]|$))';
// curl-family commands, quote-aware so `-H "X: a;b"` does not end the command early; `-u user:pass` is only a credential for these
const HTTP_TOOL = `\\b(?:curl|wget|http|https|xh|hurl)\\b(?:"[^"]*"|'[^']*'|[^\\n|;&"'])*?`;
// A header value is a literal unless it contains a variable, a substitution or a placeholder (`Bearer $TOKEN`, `Bearer <token>`).
const HEADER_VALUE = `(?![^"'\\n]*[$\`<])[^"'\\n]+`;
// `Authorization`, `Proxy-Authorization`, any hyphenated `...-Key/-Token/-Secret` name (`X-Api-Key`, `PRIVATE-TOKEN`), `Cookie`
const HEADER_NAME = '(?:(?:Proxy-)?Authorization|[A-Za-z0-9]+-[\\w-]*(?:key|token|secret)|Cookie)';
const SECRET_NAME_PART = '(?<![A-Za-z0-9])(?:KEY|TOKEN|SECRET|PASS|PASSWD|PWD)(?![A-Za-z0-9])';
const QUERY_SECRET = 'api[_-]?key|access[_-]?(?:token|key)|auth[_-]?token|token|client[_-]?secret|secret|password|passwd|pwd';
const SECRET_FLAG = '--(?:token|api-key|apikey|password|passwd|client-secret|access-token|auth-token)(?:=|\\s+)';
const VALUE_KINDS = [
  [`(?:^|[\\s;&|("'])${SECRET_ENV}=`, '', 'a password or key assigned in the command'],
  [SECRET_FLAG, '(?!-)', 'a password, token or key flag with a literal value'],
  ['\\bsshpass\\s+(?:-\\w*\\s+)*-p\\s*', '', 'an sshpass password'],
  ['\\b(?:mysql|mysqladmin|mysqldump|mariadb)\\b[^\\n|;&]*?\\s-p', '', 'a mysql password flag with a literal value'],
  ['\\bdocker\\s+login\\b[^\\n|;&]*?\\s-p\\s+', '', 'a docker login password'],
  // any variable whose name has KEY, TOKEN, SECRET, PASS, PASSWD, PWD or PASSWORD as a part (`DB_PASS`, `TOKEN_FILE_X`, `ADMINPASSWORD`)
  [`${BOUNDARY}[\\w.-]*(?:${SECRET_NAME_PART}|PASSWORD)[\\w.-]*=`, '', 'a key, token, secret or password assigned in the command', { flags: 'i' }],
  [`[?&](?:${QUERY_SECRET})=`, '', 'a token or key in a URL query string', { flags: 'i' }],
  ['\\bredis-cli\\b[^\\n|;&]*?\\s(?:-a|--pass)\\s+', '', 'a redis password'],
  ['(?<![A-Za-z0-9])_(?:authToken|auth|password)=|(?<![A-Za-z0-9])_authToken\\s+', '', 'an npm registry credential', { flags: 'i' }],
  ['\\bBearer\\s+', '', 'a bearer token', { flags: 'i' }],
  [`${HTTP_TOOL}\\s(?:-u|--user)(?:=|\\s*)[^\\s:"']*:`, '', 'a user:password pair', { value: '["\']?[^\\s"\';&|]+["\']?' }],
  [`${HTTP_TOOL}\\s(?:-u|--user)(?:=|\\s*)["'][^"':]*:`, '', 'a user:password pair', { value: '[^"\']+' }],
  [`\\b${HEADER_NAME}\\s*:[ \\t]*`, '', 'a credential header with a literal value', { value: HEADER_VALUE, flags: 'i' }],
  [`(?<!\\b(?:docker|podman|buildx|buildah)\\b[^\\n|;&]*)--secret(?:=|\\s+)`, '(?!-)', 'a secret flag with a literal value'],
  ['\\b[a-z][a-z0-9+.-]*://[^\\s/@:"\']+:', URL_NOT_A_PORT, 'a password inside a URL', { value: URL_PASSWORD, flags: 'i' }],
].map(([prefix, lookahead, kind, { value, flags = '' } = {}]) => ({
  kind,
  detect: new RegExp(`${prefix}${NOT_LITERAL_START}${lookahead}${value ?? VALUE}`, flags),
  mask: new RegExp(`(${prefix})${NOT_LITERAL_START}${lookahead}(?:${value ?? VALUE_RUN})`, `g${flags}`),
}));
const MASK = '[masked]';

/**
 * @param {string} command raw command text
 * @returns {string | undefined} what kind of secret was found, or undefined; never the value
 */
export function findLiteralSecret(command) {
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
  let text = command;
  for (const [pattern] of TOKEN_KINDS) text = text.replace(new RegExp(pattern.source, 'g'), MASK);
  for (const { mask } of VALUE_KINDS) text = text.replace(mask, `$1${MASK}`);
  return text;
}
