// Purpose: mask credentials in an owner message for `recall --owner`, with the rule "when in doubt print [masked]".
// Exports: maskOwnerText, MASKED, MAX_MASK_INPUT_CHARS.
// Invariants: pure; works on at most MAX_MASK_INPUT_CHARS characters (so a huge message cannot cost much time); the
// text is normalised first (NFKC, Arabic ي/ك to Persian ی/ک, invisible characters removed, Persian and Arabic-Indic
// digits to ASCII); then redact() (kept as it was), then three rules: a strong credential word masks the rest of its
// line, an ambiguous word (key, code, pin, user ...) masks the values after it, and value-looking tokens are masked
// everywhere. Residual risk: a password that is an ordinary word with no label near it cannot be recognised.
import { redact } from './redact.mjs';

export const MASKED = '[masked]';
export const MAX_MASK_INPUT_CHARS = 2000;

const WORD_START = '(?<![\\p{L}\\p{N}_])';
const WORD_END = '(?![\\p{L}\\p{N}_])';
// A strong word masks everything after it on the line (suffixed Persian forms such as رمزش are matched by prefix).
const STRONG = new RegExp(`${WORD_START}(?:pass[\\s_-]?word|passwd|pwd|passphrase|secret|token|bearer|credentials?|creds?|api[\\s_-]?key|private[\\s_-]?key|pass(?=\\s*[:=])|رمز|گذرواژه|کلمه\\s?عبور|پسورد|توکن|سکرت)\\p{L}*`, 'iu');
// An ambiguous word masks the value after it (`key: X`, `pin is 4829`) and every value-looking token later in the line.
const AMBIGUOUS = new RegExp(`${WORD_START}(?:(?:key|code|pin|otp|login|user(?:name)?|wi-?fi)s?${WORD_END}|(?:کد|کلید|نام کاربری|یوزر)\\p{L}{0,3})`, 'iu');
const CONNECTOR_THEN_VALUE = /^(\s*(?:[:=]|\bis\b|\bwas\b|اینه|است|هست)\s*)(\S+)/iu;
const PLAIN_SEPARATORS_ONLY = /^[\s:=—.-]*$/u;

const DIGIT_GROUPS = /\d{2,}(?:[ -]\d{2,}){2,}|\d{4,}/g; // 4+ digits, or card/phone style groups
const KNOWN_PREFIX = new RegExp(`${WORD_START}(?:sk-|sk_|ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|figd_|hf_|glpat-|npm_|GOCSPX-|AIza|ya29\\.|xox|AKIA|eyJ)\\S*`, 'gu');
const URL_WITH_USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]*@\S*/gi;
const UPPER_SNAKE_ASSIGNMENT = /(\b[A-Z][A-Z0-9_]+=)\S*/g;
const BASE64_RUN = /[A-Za-z0-9+/=_-]{20,}/g;
const MIN_VALUE_TOKEN_CHARS = 8; // a token this long that mixes letters with digits or symbols
const SYMBOLS = /[!@#$%^&*+=?~|\\<>]/;
const EDGE_PUNCTUATION = /^[\s"'`()[\]{}.,;:!?*_،؛؟]+|[\s"'`()[\]{}.,;:!?*_،؛؟]+$/gu;

function normalise(text) {
  return String(text)
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/\u064A/g, '\u06CC')
    .replace(/\u0643/g, '\u06A9')
    .replace(/[\u06F0-\u06F9]/g, (digit) => String(digit.charCodeAt(0) - 0x06F0))
    .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));
}

const hasLetter = (token) => /\p{L}/u.test(token);
const hasDigit = (token) => /\d/.test(token);

/** A token that looks like a value: 3+ characters with a digit, or two parts joined by / : @ (`admin/x`). */
function looksLikeValue(token) {
  const core = token.replace(EDGE_PUNCTUATION, '');
  return (core.length >= 3 && hasDigit(core)) || /[\p{L}\p{N}][/:@\\][\p{L}\p{N}]/u.test(core);
}

/** Mask the value after an ambiguous word: the token right after `:`/`=`/`is`, then every value-looking token. */
function maskAfterAmbiguous(rest) {
  const direct = CONNECTOR_THEN_VALUE.exec(rest);
  const head = direct ? `${direct[1]}${MASKED}` : '';
  const tail = direct ? rest.slice(direct[0].length) : rest;
  return head + tail.replace(/\S+/g, (token) => (looksLikeValue(token) ? MASKED : token));
}

/** Per line: a strong word masks the rest of the line (and the next line when nothing follows it); an ambiguous word masks values. */
function maskKeywordLines(text) {
  let maskNextLine = false;
  return text.split('\n').map((line) => {
    if (maskNextLine && line.trim()) {
      maskNextLine = false;
      return MASKED;
    }
    const strong = STRONG.exec(line);
    if (strong) {
      const end = strong.index + strong[0].length;
      if (PLAIN_SEPARATORS_ONLY.test(line.slice(end))) {
        maskNextLine = true;
        return line;
      }
      return `${line.slice(0, end)} ${MASKED}`;
    }
    const ambiguous = AMBIGUOUS.exec(line);
    if (!ambiguous) return line;
    const end = ambiguous.index + ambiguous[0].length;
    return line.slice(0, end) + maskAfterAmbiguous(line.slice(end));
  }).join('\n');
}

function isValueToken(token) {
  const core = token.replace(EDGE_PUNCTUATION, '');
  return core.length >= MIN_VALUE_TOKEN_CHARS && hasLetter(core) && (hasDigit(core) || SYMBOLS.test(core));
}

/** Value-looking tokens, with or without a keyword. */
function maskValueTokens(text) {
  return text
    .replace(URL_WITH_USERINFO, MASKED)
    .replace(KNOWN_PREFIX, MASKED)
    .replace(UPPER_SNAKE_ASSIGNMENT, `$1${MASKED}`)
    .replace(DIGIT_GROUPS, MASKED)
    .replace(BASE64_RUN, (run) => (hasDigit(run) && hasLetter(run) ? MASKED : run))
    .replace(/\S+/g, (token) => (isValueToken(token) ? MASKED : token));
}

/**
 * The first MAX_MASK_INPUT_CHARS characters of a message with credentials masked.
 * @param {string} text the owner's words.
 * @returns {string} masked text (line breaks kept, so the caller decides how to flatten).
 */
export function maskOwnerText(text) {
  const bounded = normalise(String(text).slice(0, MAX_MASK_INPUT_CHARS));
  return maskValueTokens(maskKeywordLines(redact(bounded)));
}
