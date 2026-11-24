// The text of a timed-ask dialog (timed-ask.mjs shows it): what is asked, why, the masked target, detail lines, directory, session,
// and the timeout rule (a request with `timeoutDenies`, max's outward ask, says no answer does not run it); a question popup (a request with `body`, display design 7.5) shows only its own lines and the default button.
// Exports: dialogText(request, timeoutS, platform) -> string; formatDuration(seconds) -> '2 min' | '45 s'; ALLOW_DENY_BUTTONS.
// Invariants: every shown value is masked with its real line breaks before it is flattened or cut, so no secret reaches the dialog;
// line breaks become a visible mark and control, format, bidi, zero-width and other default-ignorable characters are dropped, so no
// value can fake a "Why:" line or hide part of a command; a long value shows its head, its tail and its full length.
import { maskSecrets } from './secrets.mjs';

export const ALLOW_DENY_BUTTONS = { accept: 'Allow', decline: 'Deny' };
const MAX_COMMAND_CHARS = 200; // a value up to this length is shown whole
const HEAD_CHARS = 120; // a longer one shows its first HEAD_CHARS and last TAIL_CHARS characters and its length
const TAIL_CHARS = 80;
const MAX_LABEL_CHARS = 24; // a detail line's label is a short name such as "Answer 1"; longer caller text is cut
const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/g;
const LINE_MARK = ' \u23CE '; // a visible return symbol where the value had a line break
// Controls (except the \n that LINE_BREAK leaves), format characters (bidi marks, overrides, isolates, zero-width, tags, soft hyphen) and
// every other default-ignorable code point (fillers, variation selectors): none of them shows, so each could hide or reorder text.
const HIDDEN_CHARS = /(?!\n)[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const SECONDS_PER_MINUTE = 60;

export const formatDuration = (seconds) => (seconds % SECONDS_PER_MINUTE === 0 ? `${seconds / SECONDS_PER_MINUTE} min` : `${seconds} s`);

/** @returns {string} `text` with every line break as \n, tabs as spaces and hidden characters dropped (still multi-line) */
const plain = (text) => String(text ?? '').replace(LINE_BREAK, '\n').replace(/\t/g, ' ').replace(HIDDEN_CHARS, '');

/** @returns {string} `text` on one line: line breaks become a visible mark, tabs a space, hidden characters are dropped */
const visible = (text) => plain(text).replace(/\n/g, LINE_MARK);

/**
 * @returns {string} `text` masked, then put on one line. The masker must see the real line breaks: its rules stop at a newline (a header value
 * is not a literal when a `$` follows on the SAME line), so flattening first would let a later line unmask a secret.
 */
const maskedVisible = (text) => maskSecrets(plain(text)).replace(/\n/g, LINE_MARK);

/**
 * @returns {string} `text` masked and made visible; over MAX_COMMAND_CHARS it is head ... tail [length chars]. The whole text is masked
 * before it is cut, so a value whose prefix is in the head never shows its own tail; past the masker's 32 KB scan limit the tail is the
 * end of the scanned part, marked "[...cut]", never unmasked text.
 */
function shownValue(text) {
  const raw = String(text ?? '');
  const shown = maskedVisible(raw);
  if (shown.length <= MAX_COMMAND_CHARS) return shown;
  return `${shown.slice(0, HEAD_CHARS)} ... ${shown.slice(-TAIL_CHARS)} [${raw.length} chars]`;
}

/** @returns {string} `text` masked and made visible; over MAX_COMMAND_CHARS only its start is shown, then ... [length chars] */
function shownStart(text) {
  const raw = String(text ?? '');
  const shown = maskedVisible(raw);
  return shown.length <= MAX_COMMAND_CHARS ? shown : `${shown.slice(0, MAX_COMMAND_CHARS)} ... [${raw.length} chars]`;
}

/** @returns {string} a question's body (display design 7.5): its own lines, masked, then the default button; no tool, directory or session line */
function plainBody(body, buttons, platform) {
  const yesNo = platform === 'win32' ? ` (Yes = ${buttons.accept}, No = ${buttons.decline})` : '';
  const defaultLabel = buttons.defaultButton === 'decline' ? buttons.decline : buttons.accept;
  return [...body.map((line) => shownStart(line)), '', `${defaultLabel} is the default${yesNo}.`].join('\n');
}

/**
 * @returns {string} the dialog body: tool, why, the labelled target (head and tail), detail lines, directory, session/agent, the timeout
 *   rule (timeoutDenies: no answer does not run it, for max's outward asks); a request with `body` (the question popups) shows only
 *   those lines and the default button
 */
export function dialogText({ tool, reason, command, targetLabel = 'Command', details = [], cwd, sessionId, agentId, buttons = ALLOW_DENY_BUTTONS, body, timeoutDenies = false }, timeoutS, platform) {
  if (Array.isArray(body)) return plainBody(body, buttons, platform);
  const target = shownValue(command);
  const who = [sessionId && `session ${visible(String(sessionId).slice(0, 8))}`, agentId && `agent ${visible(String(agentId).slice(0, 8))}`].filter(Boolean).join(', ');
  const lines = [`Tool: ${visible(tool)}`, `Why: ${maskedVisible(reason)}`];
  if (target) lines.push(`${visible(targetLabel)}: ${target}`);
  for (const { label, value, keepStart } of details) {
    lines.push(`${maskedVisible(label).slice(0, MAX_LABEL_CHARS)}: ${keepStart ? shownStart(value) : shownValue(value)}`);
  }
  if (cwd) lines.push(`Directory: ${visible(cwd)}`);
  if (who) lines.push(`From: ${who}`);
  const yesNo = platform === 'win32' ? ` (Yes = ${buttons.accept}, No = ${buttons.decline})` : '';
  const goesAhead = buttons.defaultButton === 'decline' ? `${buttons.accept} is taken.` : 'it goes ahead.';
  const timeoutRule = timeoutDenies ? `it does not run: only a click on ${buttons.accept} runs it.` : goesAhead;
  const defaultLabel = buttons.defaultButton === 'decline' ? buttons.decline : buttons.accept;
  lines.push('', `${defaultLabel} is the default${yesNo}. With no answer in ${formatDuration(timeoutS)} ${timeoutRule}`);
  return lines.join('\n');
}
