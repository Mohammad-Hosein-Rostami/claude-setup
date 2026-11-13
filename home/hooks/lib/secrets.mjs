// Literal secrets typed into a Bash command. Exports: findLiteralSecret(command) -> string | undefined.
// Returns only a KIND label ("an Anthropic API key", ...), never the secret itself: the caller prints it in a deny message.
// Detected: sk-ant-..., ghp_/gho_/ghu_/ghs_/ghr_/github_pat_ tokens, AWS access key ids, `--password=x` / `--password x`,
// `sshpass -p x`, `mysql -pX`, `docker login -p x`, and PGPASSWORD / MYSQL_PWD / AWS_SECRET_ACCESS_KEY assigned a literal.
// A value that starts with `$` (variable, `$(cat file)`), a backtick or `<(` is not literal. Scans the raw text, so quotes,
// heredocs and `bash -c '...'` are all covered. A noisy false positive is accepted: the deny is meant to be strict.

const TOKEN_KINDS = [
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/, 'an Anthropic API key'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/, 'a GitHub token'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, 'an AWS access key id'],
];
const SECRET_ENV = '(?:PGPASSWORD|MYSQL_PWD|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)';
const NOT_LITERAL_START = '(?!["\']?(?:\\$|`|<\\(|\\s|;|&|\\||$))';
const VALUE = `["']?[^\\s"';&|]`;
const VALUE_KINDS = [
  [new RegExp(`(?:^|[\\s;&|("'])${SECRET_ENV}=${NOT_LITERAL_START}`), 'a password or key assigned in the command'],
  [new RegExp(`--(?:password|passwd)(?:=|\\s+)${NOT_LITERAL_START}(?!-)${VALUE}`), 'a password flag with a literal value'],
  [new RegExp(`\\bsshpass\\s+(?:-\\w*\\s+)*-p\\s*${NOT_LITERAL_START}${VALUE}`), 'an sshpass password'],
  [new RegExp(`\\b(?:mysql|mysqladmin|mysqldump|mariadb)\\b[^\\n|;&]*?\\s-p${NOT_LITERAL_START}${VALUE}`), 'a mysql password flag with a literal value'],
  [new RegExp(`\\bdocker\\s+login\\b[^\\n|;&]*?\\s-p\\s+${NOT_LITERAL_START}${VALUE}`), 'a docker login password'],
];

/**
 * @param {string} command raw command text
 * @returns {string | undefined} what kind of secret was found, or undefined; never the value
 */
export function findLiteralSecret(command) {
  for (const [pattern, kind] of [...TOKEN_KINDS, ...VALUE_KINDS]) {
    if (pattern.test(command)) return kind;
  }
  return undefined;
}
