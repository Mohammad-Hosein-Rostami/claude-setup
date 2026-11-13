// Purpose: replace secrets in text with [REDACTED]; used when indexing and again on every output.
// Exports: redact, REDACTED.
// Invariants: pure and idempotent (redacting twice equals redacting once); biased towards over-redaction; every
// pattern anchors on a token start (lookbehind) so no pattern is quadratic on long runs; whole-block and
// credential-header patterns run before the generic key=value rule so values are not left half-covered. Space-form
// patterns (`pass X`, `رمز X`, `mysql -p X`) only take a single token of at least 4 chars, to keep false positives low.
export const REDACTED = '[REDACTED]';

const MIN_SECRET_RUN = 32;
const MIN_BODY_LINE = 60;
const SECRET_NEIGHBOUR = '(?:key|secret|token|password|credential|auth)';
const RUN = `[A-Za-z0-9+/=_-]{${MIN_SECRET_RUN},}`;
const NOT_DONE = '(?!\\[REDACTED\\])'; // keeps a second pass from re-eating text after an earlier [REDACTED]
const QUOTED_OR_WORD = `${NOT_DONE}(?:"[^"\\n]*"|'[^'\\n]*'|[^\\s,;"'&]+)`;
const VALUE = `(?:${QUOTED_OR_WORD})`;
const TOKEN_START = '(?<![A-Za-z0-9_.-])';
// Words that make a name secret-bearing: DB_PASSWORD, SSHPASS, client_secret, X-API-Key, STRIPE_KEY, passphrase ...
const SECRET_NAME = '(?:pass|pwd|secret|token(?!s\\b|iz)|api[_-]?key|credential|authorization|private[_-]?key|_key)';
// Longest first: "رمز عبور" must win over bare "رمز". A possessive/plural suffix (رمزم, پسوردش) is allowed.
// A ZWNJ (‌) may stand where the space is (رمز‌عبور); indexed text has none, but redact() also runs on raw text.
const PERSIAN_WORDS = '(?:پسوو?رد|گذر[\\s\\u200C]?واژه|کلمه[\\s\\u200C]?عبور|رمز[\\s\\u200C]?عبور|رمز[\\s\\u200C]?ورود|رمز)(?:ها|م|ت|ش)?(?![\\p{L}\\u200C])';
const PERSIAN_PART = '(?:عبور|ورود)(?!\\p{L})'; // never the value itself: keeps "رمز عبور [REDACTED]" stable on a second pass
const PERSIAN_FILLER = '(?:(?:من|است|هست|شد|بود)\\s*[:：=]?\\s*)?'; // "رمز عبور من X", "رمزم X هست"
const MIN_BARE_VALUE = 4; // a value written without `:`/`=`/quotes must be one token of at least this many chars
// Weak words (`pass X`, `token X`) are common prose, so a bare value only counts when it looks secret: it holds a
// digit or one of _+=@#$%^&*, or an uppercase letter after its first character.
const SECRETISH = '(?=\\S*[\\d_+=@#$%^&*]|\\S+[A-Z])';
const BARE_QUOTED = `(?!\\[REDACTED\\])(?:'[^'\\n]*'|"[^"\\n]*"|[^\\s'"|;&]{${MIN_BARE_VALUE},})`;
const R = REDACTED;

const PEM_BEGIN = '-----BEGIN [A-Z ]*PRIVATE KEY[A-Z ]*-----';
const PEM_END = '-----END [A-Z ]*PRIVATE KEY[A-Z ]*-----';

// Order matters: blocks and headers first, the generic name=value rule after them.
const REDACTIONS = [
  [new RegExp(`${PEM_BEGIN}[\\s\\S]*?(?:${PEM_END}|$)`, 'g'), R],
  [new RegExp(`^[A-Za-z0-9+/]{${MIN_BODY_LINE},}={0,2}$`, 'gm'), R],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s:/@]*:\S*@/gi, `$1${R}@`], // the password may hold / or @: runs to the last @ of the token
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+@/gi, `$1${R}@`], // userinfo without a password is usually a token (https://TOKEN@host)
  [/(\bAuthorization["']?\s*[:=]\s*["']?)(?!\s*\[REDACTED\])[^"'\n|;&]+/gi, `$1${R}`], // any scheme (Basic, ApiKey, AWS4-HMAC-SHA256 ...): the rest of the header value
  [/(\bX-(?:[\w-]*-)?(?:Key|Token|Secret)["']?\s*:\s*)(?!\s*\[REDACTED\])[^"'\n]+/gi, `$1${R}`], // X-Auth-Key, X-Amz-Security-Token, X-Api-Key ...
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${R}`],
  [/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)*/g, R],
  [/(\b(?:Set-)?Cookie["']?\s*[:=]\s*)[^\n"']+/gi, `$1${R}`],
  [new RegExp(`(\\s(?:-b|--cookie)[\\s=]+)(${QUOTED_OR_WORD})`, 'g'), `$1${R}`],
  [/(\s(?:--user[\s=]+|-u[\s=]*))(?!\[REDACTED\])("[^"\n]*:[^"\n]*"|'[^'\n]*:[^'\n]*'|[^\s:"']+:[^\s"']*)/g, `$1${R}`], // -u U:PW, -uU:PW, --user "a b:PW
  [/(\bredis-cli\b[^\n]*?\s-a\s+)(?!\[REDACTED\])(\S+)/gi, `$1${R}`],
  [new RegExp(`(\\b(?:sshpass|(?:docker|podman|nerdctl)\\s+login)\\b[^\\n|;&]*?\\s-p\\s*)(${QUOTED_OR_WORD})`, 'gi'), `$1${R}`],
  [/(?<![\w-])(-p)(?!\[REDACTED\])('[^'\n]*'|"[^"\n]*"|[^\s'"-]\S*)/g, `$1${R}`],
  [new RegExp(`(--(?:[\\w-]*-)?(?:pass(?:word|wd|phrase)?|secret|token|api-?key)[\\s=]+)(${QUOTED_OR_WORD})`, 'gi'), `$1${R}`],
  [/(\bIDENTIFIED\s+(?:WITH\s+\w+\s+)?BY\s+)(?!\[REDACTED\])('[^'\n]*'|"[^"\n]*"|\S+)/gi, `$1${R}`],
  [/(\bPASSWORD\s*\(\s*)('[^'\n]*'|"[^"\n]*"|[^)\n]*)/gi, `$1${R}`],
  [/(\bpass(?:word|wd|code|phrase)?|\bpwd|\bsecret|\bapi[ _-]?key)(\s+(?:is|was|are|to|should\s+be|will\s+be)\s*:?\s*)(?!\[REDACTED\])('[^'\n]*'|"[^"\n]*"|\S+)/gi, `$1$2${R}`],
  [new RegExp(`${TOKEN_START}([A-Za-z0-9_.-]*${SECRET_NAME}[A-Za-z0-9_.-]*)(["']?\\s*[:=]\\s*)${VALUE}`, 'gi'), `$1$2${R}`],
  [new RegExp(`(?<!\\p{L})(${PERSIAN_WORDS})(\\s*[:：=]?\\s*${PERSIAN_FILLER})(?![\\s:：=]|\\[REDACTED\\]|${PERSIAN_PART})('[^'\\n]*'|"[^"\\n]*"|\\S{${MIN_BARE_VALUE},})`, 'gu'), `$1$2${R}`],
  [/(?<!\p{L})(رمز(?:ها|م|ت|ش)?(?:\s+[^\s:：=]+){0,4}\s*[:：=]\s*)(?!\[REDACTED\])('[^'\n]*'|"[^"\n]*"|\S+)/gu, `$1${R}`],
  // mysql -p X (space form), netrc "machine h login u password X", htpasswd's last argument, `echo X | sudo -S`.
  [new RegExp(`(\\bmysql\\w*\\b[^\\n|;&]*?\\s-p\\s+)${BARE_QUOTED}`, 'gi'), `$1${R}`],
  [new RegExp(`(\\b(?:machine\\s+\\S+|default)\\s+login\\s+\\S+\\s+password\\s+)(?!\\[REDACTED\\])('[^'\\n]*'|"[^"\\n]*"|\\S+)`, 'gi'), `$1${R}`],
  [new RegExp(`(\\bhtpasswd\\s+(?:-(?!\\w*n)\\w+\\s+)*-\\w*n\\w*\\s+(?:-\\w+\\s+)*(?!-)\\S+\\s+)${BARE_QUOTED}`, 'gi'), `$1${R}`], // -nb user PASS
  [new RegExp(`(\\bhtpasswd\\s+(?:-(?!\\w*n)\\w+\\s+)*(?!-)\\S+\\s+\\S+\\s+)${BARE_QUOTED}`, 'gi'), `$1${R}`], // -b file user PASS
  [new RegExp(`(\\becho\\s+(?:-\\w+\\s+)*)${BARE_QUOTED}(?=\\s*\\|\\s*sudo\\s+-\\w*S\\b)`, 'gi'), `$1${R}`],
  [/(--with-token\s+(?:<<<?\s*)?)(?!\[REDACTED\]|<)\S+/g, `$1${R}`],
  // Query-string secrets: ?key=X, &access_token=X.
  [new RegExp(`([?&](?:key|api[_-]?key|access[_-]?token|token|secret|password|passwd|auth|sig|signature)=)${VALUE}`, 'gi'), `$1${R}`],
  // Weak words: `pw: X`, and the space forms `pass X`, `pwd X`, `token X` (value must look secret, see SECRETISH).
  [new RegExp(`(?<![\\w.-])([Pp][Ww]["']?[ \\t]*[:=][ \\t]*)${VALUE}`, 'g'), `$1${R}`],
  [new RegExp(`(?<![\\w.-])((?:pass(?:word|wd)?|Pass(?:word|wd)?|PASS(?:WORD|WD)?|pwd|Pwd|PWD|pw|Pw|PW|token|Token|TOKEN)[ \\t]+)(?!\\[REDACTED\\])${SECRETISH}\\S{${MIN_BARE_VALUE},}`, 'g'), `$1${R}`],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, R],
  [/\bghp_[A-Za-z0-9]{20,}/g, R],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, R],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, R],
  [/\bnpm_[A-Za-z0-9]{30,}/g, R],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, R],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, R],
  [/\bAKIA[0-9A-Z]{16}\b/g, R],
  [new RegExp(`(${SECRET_NEIGHBOUR}[\\s:="'-]{0,4})${RUN}`, 'gi'), `$1${R}`],
  [new RegExp(`(?<![A-Za-z0-9+/=_-])${RUN}(?=[\\s:="'-]{0,4}${SECRET_NEIGHBOUR})`, 'gi'), R],
];

/**
 * Replace secrets with [REDACTED]. Pure and idempotent.
 * @param {string} text any text; null/undefined become ''.
 * @returns {string} the text with credential values removed.
 */
export function redact(text) {
  return REDACTIONS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), String(text ?? ''));
}
