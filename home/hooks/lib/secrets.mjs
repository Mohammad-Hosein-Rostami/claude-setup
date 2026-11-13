// Literal secrets typed into a Bash command. Exports: findLiteralSecret(command) -> string | undefined; maskSecrets(command) -> string.
// Returns only a KIND label ("an Anthropic API key", ...), never the secret itself: the caller prints it in a deny message.
// Detected: sk-ant-..., ghp_/gho_/ghu_/ghs_/ghr_/github_pat_ tokens, AWS access key ids, `--password=x` / `--password x`,
// `sshpass -p x`, `mysql -pX`, `docker login -p x`, and PGPASSWORD / MYSQL_PWD / AWS_SECRET_ACCESS_KEY assigned a literal.
// A value that starts with `$` (variable, `$(cat file)`), a backtick or `<(` is not literal. Scans the raw text, so quotes,
// heredocs and `bash -c '...'` are all covered. A noisy false positive is accepted: the check is meant to be strict (the hook turns a hit into a timed ask).

const TOKEN_KINDS = [
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/, 'an Anthropic API key'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/, 'a GitHub token'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, 'an AWS access key id'],
];
const SECRET_ENV = '(?:PGPASSWORD|MYSQL_PWD|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)';
const NOT_LITERAL_START = '(?!["\']?(?:\\$|`|<\\(|\\s|;|&|\\||$))';
const VALUE = `["']?[^\\s"';&|]`;
// What the masker hides after a prefix: a whole quoted string or one unquoted word.
const VALUE_RUN = `"[^"]*"|'[^']*'|[^\\s"';&|]+`;
// [prefix, extra lookahead, kind]: the prefix ends right before the value, so one table drives both detection and masking.
const VALUE_KINDS = [
  [`(?:^|[\\s;&|("'])${SECRET_ENV}=`, '', 'a password or key assigned in the command'],
  ['--(?:password|passwd)(?:=|\\s+)', '(?!-)', 'a password flag with a literal value'],
  ['\\bsshpass\\s+(?:-\\w*\\s+)*-p\\s*', '', 'an sshpass password'],
  ['\\b(?:mysql|mysqladmin|mysqldump|mariadb)\\b[^\\n|;&]*?\\s-p', '', 'a mysql password flag with a literal value'],
  ['\\bdocker\\s+login\\b[^\\n|;&]*?\\s-p\\s+', '', 'a docker login password'],
].map(([prefix, lookahead, kind]) => ({
  kind,
  detect: new RegExp(`${prefix}${NOT_LITERAL_START}${lookahead}${VALUE}`),
  mask: new RegExp(`(${prefix})${NOT_LITERAL_START}${lookahead}(?:${VALUE_RUN})`, 'g'),
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
