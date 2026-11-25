// Masks every token-shaped text before the harness prints, logs or writes it (owner rule: never a token in a log, a result or a
// commit). Exports: REDACTED, redact(text), redactJson(value).
// What is masked: Anthropic keys and OAuth tokens (`sk-ant-...`, any kind), `Bearer <value>`, an `Authorization:` header, and the
// value of any JSON field or `NAME=value` pair whose name says token, secret, key, password or authorization
// (`"accessToken": "..."`, `CLAUDE_CODE_OAUTH_TOKEN=...`). The stream of a `claude` child is redacted line by line before it is
// written, so a checker never reads a raw token either. The runner's own login token (CLAUDE_CODE_OAUTH_TOKEN, env.mjs) is masked
// by its value too, whatever its shape, wherever it shows up.
// Invariants: reads nothing but that one env value; masking is idempotent (redact(redact(x)) === redact(x)); non-string input is turned into a string first.

export const REDACTED = '<redacted>';
const LOGIN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN'; // env.mjs LOGIN_ENV (not imported: env.mjs loads the account tool)
const MIN_SECRET_CHARS = 8; // a shorter value would mask ordinary words

const SECRET_NAME = '[A-Za-z0-9_]*(?:token|secret|password|passwd|api_?key|authorization)[A-Za-z0-9_]*';
const PATTERNS = [
  // an Anthropic key or OAuth token of any kind (sk-ant-api03-..., sk-ant-oat01-..., sk-ant-ort01-...)
  [/sk-ant-[A-Za-z0-9_-]+/g, REDACTED],
  // an HTTP bearer credential, in a header or in prose
  [/\b(Bearer)\s+(?!<redacted>)[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  // a JSON field whose name says it holds a secret: "accessToken": "value"
  // ("apiKeySource": "none" names where a login came from, not a secret: a name ending in "source" is kept)
  [new RegExp(`("${SECRET_NAME}(?<!source)"\\s*:\\s*")(?!<redacted>)[^"]*(")`, 'gi'), `$1${REDACTED}$2`],
  // an env-style pair whose name says it holds a secret: NAME=value (up to a space, quote or end)
  [new RegExp(`\\b(${SECRET_NAME})=(?!<redacted>)[^\\s"']+`, 'gi'), `$1=${REDACTED}`],
];

/**
 * @param {unknown} text anything about to be printed or written
 * @returns {string} the text with every token-shaped part replaced by REDACTED
 */
export function redact(text) {
  const login = process.env[LOGIN_ENV] ?? '';
  const masked = login.length >= MIN_SECRET_CHARS ? String(text ?? '').split(login).join(REDACTED) : String(text ?? '');
  return PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), masked);
}

/**
 * @param {unknown} value a value about to be written as JSON (results.json)
 * @returns {string} its pretty JSON, redacted
 */
export const redactJson = (value) => redact(JSON.stringify(value, null, 2));
