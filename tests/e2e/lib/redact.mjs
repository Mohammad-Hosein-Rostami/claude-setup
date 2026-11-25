// Masks every token-shaped text before the harness prints, logs or writes it (owner rule: never a token in a log, a result or a
// commit). Exports: REDACTED, registerSecret(value), redact(text), redactedSlice(text, maxChars), redactJson(value).
// What is masked: Anthropic keys and OAuth tokens (`sk-ant-...`, any kind), `Bearer <value>`, an `Authorization:` header, and the
// value of any JSON field or `NAME=value` pair whose name says token, secret, key, password or authorization
// (`"accessToken": "..."`, `CLAUDE_CODE_OAUTH_TOKEN=...`). The stream of a `claude` child is redacted line by line before it is
// written, so a checker never reads a raw token either. The runner's own login token (CLAUDE_CODE_OAUTH_TOKEN, env.mjs) is masked
// by its value too, whatever its shape, wherever it shows up, and so is every value registered at run time (registerSecret:
// the token the runner read from the claude-account store, review round 3).
// A text is always masked before it is cut (redactedSlice, report.mjs): a cut through a value of no known shape would leave a
// part the exact-value mask no longer matches (review round 4, R3).
// Invariants: reads nothing but that one env value and the registered values (held in memory only, never written); masking is
// idempotent (redact(redact(x)) === redact(x)); non-string input is turned into a string first.

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

const registered = new Set();

/** Masks this exact value from now on, in every text redact() sees (a value shorter than MIN_SECRET_CHARS is ignored). */
export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= MIN_SECRET_CHARS) registered.add(value);
}

/**
 * @param {unknown} text anything about to be printed or written
 * @returns {string} the text with every token-shaped part replaced by REDACTED
 */
export function redact(text) {
  const values = [process.env[LOGIN_ENV] ?? '', ...registered].filter((value) => value.length >= MIN_SECRET_CHARS);
  const masked = values.reduce((out, value) => out.split(value).join(REDACTED), String(text ?? ''));
  return PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), masked);
}

/**
 * @param {unknown} text a text a check line shows only the start of (a deny, a report, a command from a transcript)
 * @param {number} maxChars how much of it is shown
 * @returns {string} the text redacted first, then cut to maxChars
 */
export const redactedSlice = (text, maxChars) => redact(text).slice(0, maxChars);

/**
 * @param {unknown} value a value about to be written as JSON (results.json)
 * @returns {string} its pretty JSON, redacted
 */
export const redactJson = (value) => redact(JSON.stringify(value, null, 2));
