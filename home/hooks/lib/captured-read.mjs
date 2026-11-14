// A stored secret read that only fills a variable prints nothing: `X=$(security find-generic-password -s gh -w)`, `export GH_TOKEN="$(gh auth
// token)"`, `T=$(security ... -w 2>/dev/null) && curl -H "Authorization: Bearer $T" ...`. decide() drops the "prints a stored secret" asks of
// such a line. A read that is printed, piped, redirected, inside quotes or after text that is not plain (a quote, group, substitution, heredoc
// or comment) still asks, and so does `security ... -g` without `2>/dev/null`: it prints the password on stderr, which `$(...)` does not capture.
// Exports: withoutCapturedPrints(reasons, command, recheck) -> reasons.
// Pure, no I/O. Raw-text matching made safe by two checks: the text before each capture must be plain, and the line with its captures made
// plain must have no secret print left (both parsers, through `recheck`). A value printed later (`X=$(...); echo $X`) is not followed.
import { isSecretPrintReason, secretPrintOf } from './command-checks.mjs';
import { commandOf } from './command-of.mjs';
import { segments } from './shell-words.mjs';

// one plain command as the whole value of an assignment, with an optional ` 2>/dev/null`: `X=$(...)`, `X="$(...)"`
const CAPTURE = /([A-Za-z_]\w*=)("?)\$\(((?:[^()`"'\\;&|<>\n#]|'[^'\n]*'|"[^"`\\\n()]*"|2>\s*\/dev\/null)+)\)\2(?=$|[\s;&|)])/g;
const PLAIN_TEXT = /^[^'"`\\(){}<>#]*$/; // no quote, group, substitution, heredoc or comment can be open in such text
const STATEMENT_START = /(?:^|[;&|\n])\s*(?:(?:then|do|else|!)\s+)?(?:(?:export|local|declare|readonly|typeset)(?:\s+-\w+)*\s+)?(?:[A-Za-z_]\w*=\S*\s+)*$/;
const STDERR_PRINT = /^-[A-Za-z]*g/; // `security ... -g` prints the password on stderr
const DROPS_STDERR = /2>\s*\/dev\/null/;

/** True when `body` is one plain command whose secret goes to stdout only (`security find-generic-password -s x -w`, `gh auth token`). */
function readsSecret(body) {
  const words = segments(body);
  if (words.length !== 1) return false;
  const { cmd, args } = commandOf(words[0]);
  if (cmd === undefined || secretPrintOf(cmd, args) === undefined) return false;
  return cmd !== 'security' || DROPS_STDERR.test(body) || !args.some((word) => STDERR_PRINT.test(word));
}

/** The command with its leading captured secret reads made plain (`export T=$(gh auth token) && x` -> `export T=_ && x`). */
function maskCapturedReads(command) {
  const parts = [];
  let from = 0;
  for (const match of command.matchAll(CAPTURE)) {
    const gap = command.slice(from, match.index);
    if (!PLAIN_TEXT.test(gap) || !STATEMENT_START.test(gap) || !readsSecret(match[3])) break;
    parts.push(gap, `${match[1]}_`);
    from = match.index + match[0].length;
  }
  return parts.join('') + command.slice(from);
}

/**
 * Drops the "prints a stored secret" asks when every such read of the line only fills a variable (`export GH_TOKEN=$(gh auth token)`): the
 * secret lands in the variable, not in the transcript.
 * @param {string[]} reasons the asks of the command line
 * @param {string} command its raw text
 * @param {(text: string) => string[]} recheck the guard's reasons for another text (both parsers)
 * @returns {string[]} the reasons, without the secret-print ones when the line with its captured reads made plain has none
 */
export function withoutCapturedPrints(reasons, command, recheck) {
  if (!reasons.some(isSecretPrintReason)) return reasons;
  const masked = maskCapturedReads(command);
  if (masked === command || recheck(masked).some(isSecretPrintReason)) return reasons;
  return reasons.filter((reason) => !isSecretPrintReason(reason));
}
