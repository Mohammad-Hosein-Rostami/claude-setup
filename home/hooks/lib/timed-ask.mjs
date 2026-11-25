// The timed native dialog of the question popup (question-popup.mjs, through lib/question-reply.mjs and lib/timed-ask-async.mjs,
// which runs it as a child that can be closed from outside); its text is built in timed-ask-text.mjs.
// Exports: askTimeoutSeconds(env), guiAvailable(env, platform), dialogExecutable(platform), dialogInvocation(platform, text, title,
// timeoutS, buttons), requestInvocation(request, timeoutS, platform), parseDialogResult(platform, result, buttons) ->
// 'allow'|'deny'|'timeout'|'unavailable', answerFromOutcome(outcome, {reason, timeoutS, waitedMs}) -> {decision, outcome, reason},
// ASK_TIMEOUT_ENV, DEFAULT_ASK_TIMEOUT_S, MAX_ASK_TIMEOUT_S, and timed-ask-text.mjs's ALLOW_DENY_BUTTONS and formatDuration.
// Why: the native question waits forever. The owner's rule is "everything goes ahead after 2 min": the dialog shows the accept button
// (default) and the decline button, and takes accept when nobody answers within the request's timeoutS, else CLAUDE_ASK_TIMEOUT_S
// (default 120; at most 190, so the up to 4 question popups in a row stay under the 800 s hook timeout in settings/base.json).
// A timeout only counts when the full time really passed; a dialog that was killed, crashed or gave up early is "dialog-failed".
// No GUI (ssh session, CI, no display) or a failing dialog tool -> decision "ask": Claude Code's own question UI. Dialog tools: macOS
// osascript, Windows PowerShell WScript.Shell Popup (its buttons are fixed to Yes = accept / No = decline), Linux zenity (plain text,
// --no-markup). The dialog text is passed as an argument or an environment variable, never spliced into a script.
// A request may name its own buttons ({accept, decline}, default Allow/Deny; accept is the default and the timeout answer), title and
// labelled detail lines (timed-ask-text.mjs); buttons.defaultButton 'decline' makes Enter hit the decline button, for a popup that may
// open while the owner types elsewhere; Windows keeps Yes/No and the body says which is which. On macOS the decline button is the
// cancel button, so Esc declines, never takes the default.
// Invariants: never throws; never puts a secret in the dialog (timed-ask-text.mjs masks every shown value before it is cut).
import { ALLOW_DENY_BUTTONS, dialogText, formatDuration } from './timed-ask-text.mjs';

export { ALLOW_DENY_BUTTONS, formatDuration };

export const ASK_TIMEOUT_ENV = 'CLAUDE_ASK_TIMEOUT_S';
export const DEFAULT_ASK_TIMEOUT_S = 120; // seconds; the owner: every prompt goes ahead after 2 min unless Deny is clicked
export const MAX_ASK_TIMEOUT_S = 190; // seconds; one popup's longest wait (see the header)
const TIMEOUT_SLACK_MS = 500; // a dialog tool may report its timeout marginally before the full time has elapsed
const MS_PER_SECOND = 1000;
const DIALOG_TITLE = 'Claude Code: confirm action';
const TEXT_ENV = 'CLAUDE_ASK_DIALOG_TEXT';
const TITLE_ENV = 'CLAUDE_ASK_DIALOG_TITLE';
const WINDOWS_POPUP_ALLOW = 6;
const WINDOWS_POPUP_DENY = 7;
const WINDOWS_POPUP_TIMEOUT = -1;
const ZENITY_ALLOW = 0;
const ZENITY_DENY = 1;
const ZENITY_TIMEOUT = 5;
const NO_DISPLAY_TEXT = /cannot open display|failed to open display|no display|unable to init server/i;
// osascript's cancel button (a click or Esc) fails with error -128; the message may be localised, the number is not
const USER_CANCELED_TEXT = /user canceled|\(-128\)/i;

// Popup(text, seconds, title, 4 + 32 [+ 256]): Yes/No buttons, question icon, first button (Yes) is the default, or the second (No) with 256.
const WINDOWS_YES_NO_QUESTION = 36;
const WINDOWS_SECOND_BUTTON_DEFAULT = 256;
const windowsScript = (decideByDefault) => `$ErrorActionPreference='Stop'; $w=New-Object -ComObject WScript.Shell; [Console]::Out.Write($w.Popup($env:${TEXT_ENV}, ${'$'}args[0], $env:${TITLE_ENV}, ${WINDOWS_YES_NO_QUESTION + (decideByDefault ? WINDOWS_SECOND_BUTTON_DEFAULT : 0)}))`;
// The button labels are constants from this code (never caller text), so they may sit in the script; the body and title travel as arguments.
// The decline button is also the cancel button, so Esc declines (Deny, or "Answer in terminal") and never takes the default.
const macScript = ({ accept, decline, defaultButton }) => [
  'on run argv',
  `display dialog (item 1 of argv) with title (item 2 of argv) buttons {"${decline}", "${accept}"} default button "${defaultButton === 'decline' ? decline : accept}" cancel button "${decline}" with icon caution giving up after ((item 3 of argv) as integer)`,
  'end run',
];

/** @returns {number} `raw` as whole seconds when it is a positive number (at most 190), else the fallback */
function positiveSeconds(raw, fallback) {
  const seconds = Math.floor(Number(raw));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, MAX_ASK_TIMEOUT_S) : fallback;
}

/** @returns {number} the dialog timeout in whole seconds: CLAUDE_ASK_TIMEOUT_S when it is a positive number (at most 190), else 120 */
export function askTimeoutSeconds(env = process.env) {
  return positiveSeconds(env[ASK_TIMEOUT_ENV], DEFAULT_ASK_TIMEOUT_S);
}

/**
 * @param {Record<string, string | undefined>} env process environment
 * @param {string} platform process.platform
 * @returns {boolean} true when somebody can plausibly see a native dialog (not ssh, not CI, not a node test run, and a display on Linux)
 */
export function guiAvailable(env = process.env, platform = process.platform) {
  // NODE_TEST_CONTEXT is set inside `node --test`: a test that forgot to fake the dialog must not open a real one
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY || env.CI || env.NODE_TEST_CONTEXT) return false;
  return platform === 'linux' ? Boolean(env.DISPLAY || env.WAYLAND_DISPLAY) : ['darwin', 'win32'].includes(platform);
}

/**
 * @param {string} platform process.platform
 * @returns {string | undefined} the dialog executable for the platform, or undefined when there is none
 */
export const dialogExecutable = (platform) => ({ darwin: 'osascript', win32: 'powershell', linux: 'zenity' })[platform];

/**
 * @param {string} platform process.platform
 * @param {string} text dialog body (already masked)
 * @param {string} title dialog title
 * @param {number} timeoutS seconds until the dialog closes itself
 * @param {{accept: string, decline: string, defaultButton?: 'decline'}} buttons button labels; accept is the default (Windows always shows Yes/No)
 *   unless defaultButton is 'decline': then Enter lands on decline, and accept stays clickable and is still the timeout answer
 * @returns {{command: string, args: string[], env: Record<string, string>} | undefined} how to run the dialog; undefined for an unknown platform
 */
export function dialogInvocation(platform, text, title, timeoutS, buttons = ALLOW_DENY_BUTTONS) {
  const command = dialogExecutable(platform);
  if (platform === 'darwin') return { command, args: [...macScript(buttons).flatMap((line) => ['-e', line]), text, title, String(timeoutS)], env: {} };
  if (platform === 'win32') {
    return { command, args: ['-NoProfile', '-NonInteractive', '-Command', `& { ${windowsScript(buttons.defaultButton === 'decline')} }`, String(timeoutS)], env: { [TEXT_ENV]: text, [TITLE_ENV]: title } };
  }
  if (platform === 'linux') {
    // --no-markup: zenity then shows the text as it is (no Pango markup, no backslash escapes)
    return { command, args: ['--question', '--no-markup', `--title=${title}`, `--text=${text}`, `--ok-label=${buttons.accept}`, `--cancel-label=${buttons.decline}`, `--timeout=${timeoutS}`, '--width=520', ...(buttons.defaultButton === 'decline' ? ['--default-cancel'] : [])], env: {} };
  }
  return undefined;
}

/**
 * @param {string} platform process.platform
 * @param {{status: number | null, stdout?: string, stderr?: string, error?: Error}} result spawnSync result
 * @param {{accept: string, decline: string}} buttons the labels the dialog showed (macOS reports the clicked label)
 * @returns {'allow' | 'deny' | 'timeout' | 'unavailable'} what the person did (accept -> allow, decline -> deny); "unavailable" when the dialog tool failed
 */
export function parseDialogResult(platform, result, buttons = ALLOW_DENY_BUTTONS) {
  if (result.error) return 'unavailable';
  const out = String(result.stdout ?? '');
  const err = String(result.stderr ?? '');
  if (platform === 'darwin') {
    if (/gave up:true/.test(out)) return 'timeout';
    if (out.includes(`button returned:${buttons.accept},`)) return 'allow';
    if (out.includes(`button returned:${buttons.decline},`) || USER_CANCELED_TEXT.test(err)) return 'deny';
    return 'unavailable';
  }
  if (platform === 'win32') {
    const code = Number.parseInt(out.trim(), 10);
    return { [WINDOWS_POPUP_ALLOW]: 'allow', [WINDOWS_POPUP_DENY]: 'deny', [WINDOWS_POPUP_TIMEOUT]: 'timeout' }[code] ?? 'unavailable';
  }
  if (platform === 'linux') {
    if (result.status === ZENITY_ALLOW) return 'allow';
    if (result.status === ZENITY_TIMEOUT) return 'timeout';
    if (result.status === ZENITY_DENY && !NO_DISPLAY_TEXT.test(err)) return 'deny';
  }
  return 'unavailable';
}

/**
 * @param {object} request what to show (see timed-ask-text.mjs dialogText)
 * @param {number} timeoutS seconds until the dialog closes itself
 * @param {string} platform process.platform
 * @returns {{command: string, args: string[], env: Record<string, string>} | undefined} how to run the dialog for this request; undefined for an unknown platform
 */
export const requestInvocation = (request, timeoutS, platform) => dialogInvocation(platform,
  dialogText(request, timeoutS, platform), request.title ?? DIALOG_TITLE, timeoutS, request.buttons ?? ALLOW_DENY_BUTTONS);

/**
 * Turns what the person did into the decision the popup takes. A "timeout" is only believed when the full time really passed.
 * @param {'allow' | 'deny' | 'timeout' | 'unavailable'} outcome parseDialogResult's answer ("unavailable": no dialog, killed, crashed)
 * @param {{reason: string, timeoutS: number, waitedMs: number}} context the masked reason, the dialog's timeout and how long it was open
 * @returns {{decision: 'allow' | 'deny' | 'ask', outcome: 'allow' | 'deny' | 'timeout' | 'dialog-failed', reason: string}}
 */
export function answerFromOutcome(outcome, { reason, timeoutS, waitedMs }) {
  const early = outcome === 'timeout' && waitedMs < timeoutS * MS_PER_SECOND - TIMEOUT_SLACK_MS;
  if (outcome === 'unavailable' || early) return { decision: 'ask', outcome: 'dialog-failed', reason };
  if (outcome === 'deny') return { decision: 'deny', outcome, reason: `denied by the owner in the dialog (${reason})` };
  if (outcome === 'timeout') return { decision: 'allow', outcome, reason: `no answer in ${formatDuration(timeoutS)}, went ahead (${reason})` };
  return { decision: 'allow', outcome, reason: `allowed by the owner in the dialog (${reason})` };
}
