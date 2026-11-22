// Purpose: mask credentials in an owner message for `recall --owner`, with the rule "when in doubt print [masked]".
// Exports: maskOwnerText, maskWholeOwnerText, MASKED, MAX_MASK_INPUT_CHARS.
// Invariants: pure; works on at most MAX_MASK_INPUT_CHARS characters (a token cut by that limit is dropped whole, so a
// value never prints in part); the text is normalised first (NFKC, Arabic ي/ك to Persian ی/ک, invisible characters,
// harakat and tatweel removed, Persian and Arabic-Indic digits to ASCII); then redact() (kept as it was), then three
// rules: a strong credential word masks the rest of its line (and the next line when nothing follows it) and the
// value-looking tokens before it, an ambiguous word (key, code, pin, user ...) masks the values after it, and
// value-looking tokens are masked everywhere. Residual risk: a password that is an ordinary word with no label near
// it cannot be recognised. maskWholeOwnerText masks a message of any length in pieces of at most MAX_MASK_INPUT_CHARS
// (redact() overflows the stack on megabytes of dashes, so one call over a whole message is not safe).
import { redact } from './redact.mjs';

export const MASKED = '[masked]';
export const MAX_MASK_INPUT_CHARS = 2000;

const WORD_START = '(?<![\\p{L}\\p{N}_])';
const WORD_END = '(?![\\p{L}\\p{N}_])';
// Latin labels (typos and short forms included) must be whole words, so "passing" and "passwordless" are not labels.
// Persian and Finglish labels also match with a suffix (رمزش, ramzesh).
const LATIN_LABELS = 'pass[\\s_-]?word|passwd|pasword|passwrd|passwrod|pwd|pswd|psw|pw|pass|passphrase|secret|sekret|token|tokan|bearer|credentials?|creds?|api[\\s_-]?key|private[\\s_-]?key';
const PREFIX_LABELS = 'رمز|گذرواژه|کلمه\\s?عبور|پسورد|توکن|سکرت|ramze?';
const STRONG = new RegExp(`${WORD_START}(?:(?:${LATIN_LABELS})s?${WORD_END}(?!-\\p{L})|(?:${PREFIX_LABELS})\\p{L}*)`, 'iu');
// An ambiguous word masks the value after it (`key: X`, `pin is 4829`) and every value-looking token later in the line.
const AMBIGUOUS = new RegExp(`${WORD_START}(?:(?:key|code|pin|otp|login|user(?:name)?|wi-?fi)s?${WORD_END}|(?:کد|کلید|نام کاربری|یوزر)\\p{L}{0,3})`, 'iu');
const CONNECTOR_THEN_VALUE = /^(\s*(?:[:=]|\bis\b|\bwas\b|اینه|است|هست)\s*)(\S+)/iu;
// What may follow a label when the value is on the next line: separators, arrows and filler words (redact() may have
// turned the filler into [REDACTED]), or a short phrase that ends in a separator ("رمز سرور:").
const FILLER_WORDS = 'is|are|was|below|here|follows|اینه|هست|است|زیر|پایین|\\[REDACTED\\]';
const LABEL_ENDS_LINE = new RegExp(`^(?:[\\s:=\\u2014.>\\u2192-]+|(?<![\\p{L}\\p{N}_])(?:${FILLER_WORDS})(?![\\p{L}\\p{N}_]))*$|^[^:=\\n\\u2192]{0,40}[:=\\u2192]\\s*$`, 'u');

const DIGIT_GROUPS = /\d+(?:[ -]\d+){3,}|\d{2,}(?:[ -]\d{2,}){2,}|\d{4,}/g; // 4+ digits, 4+ spaced digit groups, or card/phone style groups
const KNOWN_PREFIX = new RegExp(`${WORD_START}(?:sk-|sk_|ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|figd_|hf_|glpat-|npm_|GOCSPX-|AIza|ya29\\.|xox|AKIA|eyJ)\\S*`, 'gu');
const URL_WITH_USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]*@\S*/gi;
const UPPER_SNAKE_ASSIGNMENT = /(\b[A-Z][A-Z0-9_]+=)\S*/g;
const BASE64_RUN = /[A-Za-z0-9+/=_-]{20,}/g;
const MIN_VALUE_TOKEN_CHARS = 8; // a token this long that mixes letters with digits or symbols
const SYMBOLS = /[!@#$%^&*+=?~|\\<>]/;
const NOT_ORDINARY_PUNCTUATION = /[^\p{L}\p{N}\s.,;:!?'"()[\]{}\-_/*`،؛؟]/u;
const EDGE_PUNCTUATION = /^[\s"'`()[\]{}.,;:!?*_،؛؟]+|[\s"'`()[\]{}.,;:!?*_،؛؟]+$/gu;

function normalise(text) {
  return String(text)
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/\u064A/g, '\u06CC')
    .replace(/\u0643/g, '\u06A9')
    .replace(/[\u06F0-\u06F9]/g, (digit) => String(digit.charCodeAt(0) - 0x06F0))
    .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));
}

const hasLetter = (token) => /\p{L}/u.test(token);
const hasDigit = (token) => /\d/.test(token);
const coreOf = (token) => token.replace(EDGE_PUNCTUATION, '');

/** A token that looks like a value: 3+ characters with a digit, or two parts joined by / : @ (`admin/x`). */
function looksLikeValue(token) {
  const core = coreOf(token);
  return (core.length >= 3 && hasDigit(core)) || /[\p{L}\p{N}][/:@\\][\p{L}\p{N}]/u.test(core);
}

/** A token before a label that may be the value: a digit, an upper case letter after the first character beside lower case, or a symbol. */
function looksLikeValueBeforeLabel(token) {
  const core = coreOf(token);
  const mixedCase = /\p{Ll}/u.test(core) && /\p{Lu}/u.test(core.slice(1));
  return hasDigit(core) || mixedCase || NOT_ORDINARY_PUNCTUATION.test(core);
}

/** Mask the value after an ambiguous word: the token right after `:`/`=`/`is`, then every value-looking token. */
function maskAfterAmbiguous(rest) {
  const direct = CONNECTOR_THEN_VALUE.exec(rest);
  const head = direct ? `${direct[1]}${MASKED}` : '';
  const tail = direct ? rest.slice(direct[0].length) : rest;
  return head + tail.replace(/\S+/g, (token) => (looksLikeValue(token) ? MASKED : token));
}

/**
 * Per line: a strong word masks the rest of the line and the value-looking tokens before it; when only separators or
 * filler words follow it, the next non-empty line is masked whole. An ambiguous word masks the values after it.
 */
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
      const before = line.slice(0, strong.index).replace(/\S+/g, (token) => (looksLikeValueBeforeLabel(token) ? MASKED : token));
      if (LABEL_ENDS_LINE.test(line.slice(end))) {
        maskNextLine = true;
        return before + line.slice(strong.index);
      }
      return `${before}${strong[0]} ${MASKED}`;
    }
    const ambiguous = AMBIGUOUS.exec(line);
    if (!ambiguous) return line;
    const end = ambiguous.index + ambiguous[0].length;
    return line.slice(0, end) + maskAfterAmbiguous(line.slice(end));
  }).join('\n');
}

function isValueToken(token) {
  const core = coreOf(token);
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

/** The first MAX_MASK_INPUT_CHARS characters; a token the limit cuts in two is dropped whole. */
function boundedText(text) {
  const cut = text.slice(0, MAX_MASK_INPUT_CHARS);
  const cutsAToken = text.length > MAX_MASK_INPUT_CHARS && /\S/.test(text[MAX_MASK_INPUT_CHARS - 1]) && /\S/.test(text[MAX_MASK_INPUT_CHARS]);
  return cutsAToken ? cut.replace(/\S+$/, '') : cut;
}

/**
 * The first MAX_MASK_INPUT_CHARS characters of a message with credentials masked.
 * @param {string} text the owner's words.
 * @returns {string} masked text (line breaks kept, so the caller decides how to flatten).
 */
export function maskOwnerText(text) {
  return maskValueTokens(maskKeywordLines(redact(normalise(boundedText(String(text))))));
}

/**
 * Pieces of a line longer than MAX_MASK_INPUT_CHARS. A line with a credential word anywhere is masked whole (a piece
 * cannot know what came before it); else it is cut at whitespace, and a word longer than a piece prints as [masked].
 */
function splitLongLine(line) {
  if (STRONG.test(line) || AMBIGUOUS.test(line)) return [MASKED];
  const pieces = [];
  const whitespace = /\s/g;
  let start = 0;
  while (line.length - start > MAX_MASK_INPUT_CHARS) {
    const cut = line.slice(start, start + MAX_MASK_INPUT_CHARS).search(/\s\S*$/);
    if (cut > 0) {
      pieces.push(line.slice(start, start + cut));
      start += cut;
    } else {
      pieces.push(MASKED);
      whitespace.lastIndex = start + MAX_MASK_INPUT_CHARS;
      start = whitespace.exec(line)?.index ?? line.length;
    }
  }
  pieces.push(line.slice(start));
  return pieces;
}

/** Whether the last non-empty line names a credential and leaves its value to the next line. */
function endsWithBareLabel(lines) {
  const last = lines.findLast((line) => line.trim());
  const label = last === undefined ? null : STRONG.exec(last);
  return label !== null && LABEL_ENDS_LINE.test(last.slice(label.index + label[0].length));
}

/**
 * A whole message with credentials masked, with the same rules as maskOwnerText: lines are masked in pieces of at
 * most MAX_MASK_INPUT_CHARS characters, and a label that ends one piece still masks the first line of the next.
 * A message that fits in one piece gives exactly maskOwnerText's result.
 * @param {string} text the owner's words, any length.
 * @returns {string} masked text (line breaks kept).
 */
export function maskWholeOwnerText(text) {
  const masked = [];
  let piece = [];
  let pieceChars = 0;
  let maskNextLine = false;
  const flush = () => {
    if (piece.length === 0) return;
    const first = maskNextLine ? piece.findIndex((line) => line.trim()) : -1;
    if (first >= 0) {
      piece[first] = MASKED;
      maskNextLine = false;
    }
    masked.push(maskOwnerText(piece.join('\n')));
    maskNextLine ||= endsWithBareLabel(piece);
    piece = [];
    pieceChars = 0;
  };
  for (const line of normalise(text).split('\n')) {
    for (const part of line.length > MAX_MASK_INPUT_CHARS ? splitLongLine(line) : [line]) {
      if (pieceChars + part.length + 1 > MAX_MASK_INPUT_CHARS) flush();
      piece.push(part);
      pieceChars += part.length + 1;
    }
  }
  flush();
  return masked.join('\n');
}
