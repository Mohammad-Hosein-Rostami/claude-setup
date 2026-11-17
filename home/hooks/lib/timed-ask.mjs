// Timed ask for PreToolUse and PermissionRequest hooks. Exports: askTimeoutSeconds(env), secretAskTimeoutSeconds(env),
// permissionTimeoutSeconds(env), guiAvailable(env, platform), dialogInvocation(platform, text,
// title, timeoutS, buttons), requestInvocation(request, timeoutS, platform), parseDialogResult(platform, result, buttons) ->
// 'allow'|'deny'|'timeout'|'unavailable', answerFromOutcome(outcome, {reason, timeoutS, waitedMs}), answerAsk(request, env) ->
// {decision, outcome, reason}, decisionOutput(answer) -> hook stdout, askOwner(request, env) -> hook stdout (asks, logs, formats).
// answerAsk blocks until the dialog ends; lib/timed-ask-async.mjs opens the same dialog as a child that can be closed from outside.
// Why: the native "ask" waits forever. The owner's policy is "everything goes ahead after 2 min": show a native dialog with Allow
// (default) and Deny, and go ahead when nobody answers within the request's timeoutS, else CLAUDE_ASK_TIMEOUT_S (default 120; a
// secret-only ask passes CLAUDE_ASK_SECRET_TIMEOUT_S, default 120, see secretAskTimeoutSeconds; a Claude Code permission prompt answered
// by permission-timed-allow.mjs passes CLAUDE_PERMISSION_TIMEOUT_S, default 120, see permissionTimeoutSeconds; each at most 190 so it
// stays under the 200 s hook timeout; the question popups of permission-timed-allow.mjs run up to 4 in a row under its 800 s). Only a click on Deny denies. Allow and timeout print NO decision (empty stdout, exit 0): the CLI's normal permission
// flow then still applies, so base.json deny rules keep working and the rest of a compound command is not pre-approved.
// A timeout only counts when the full time really passed; a dialog that was killed, crashed or gave up early is "dialog-failed".
// No GUI (ssh session, CI, no display) or a failing dialog tool -> decision "ask": the CLI's own prompt, which also covers
// bypassPermissions mode. Dialog tools: macOS osascript, Windows PowerShell WScript.Shell Popup (its buttons are fixed to
// Yes = Allow / No = Deny), Linux zenity (plain text, --no-markup). The dialog text is passed as an argument or an environment
// variable, never spliced into a script. Every shown value is masked and then made visible (line breaks become a visible mark, control,
// format, bidi, zero-width and other default-ignorable characters are dropped), so no value can fake a "Why:" line or hide part of a
// command; a long value shows its head, its tail and its full length. Invariants: never throws, never puts a secret in the dialog (the
// whole value is masked with its real line breaks, before it is flattened or cut).
// A request may name its own buttons ({accept, decline}, default Allow/Deny; accept is the default and the timeout answer), title and
// labelled detail lines (AskUserQuestion's dialog uses all three; a label is masked and cut like a value, a detail may keep a long
// value's start instead of its head and tail; buttons.defaultButton 'decline' makes Enter hit the decline button, for a popup that may open
// while the owner types elsewhere); Windows keeps Yes/No and the body says which is which. On macOS the decline button is
// the cancel button, so Esc declines, never takes the default.
import { spawnSync } from 'node:child_process';
import { logDecision } from './guard-log.mjs';
import { maskSecrets } from './secrets.mjs';

export const ASK_TIMEOUT_ENV = 'CLAUDE_ASK_TIMEOUT_S';
export const DEFAULT_ASK_TIMEOUT_S = 120; // seconds; the owner: every prompt goes ahead after 2 min unless Deny is clicked
export const SECRET_ASK_TIMEOUT_ENV = 'CLAUDE_ASK_SECRET_TIMEOUT_S';
export const DEFAULT_SECRET_ASK_TIMEOUT_S = 120; // seconds
export const PERMISSION_TIMEOUT_ENV = 'CLAUDE_PERMISSION_TIMEOUT_S';
export const DEFAULT_PERMISSION_TIMEOUT_S = 120; // seconds
export const MAX_ASK_TIMEOUT_S = 190; // seconds; one popup's longest wait: the hook timeouts in settings/base.json are 200 s (800 s for 4 question popups)
const TIMEOUT_SLACK_MS = 500; // a dialog tool may report its timeout marginally before the full time has elapsed
const MS_PER_SECOND = 1000;
const SPAWN_GRACE_S = 5; // the dialog tool gives up by itself at the timeout; this only stops one that hangs
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
const DIALOG_TITLE = 'Claude Code: confirm action';
export const ALLOW_DENY_BUTTONS = { accept: 'Allow', decline: 'Deny' };
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
 * The shorter timeout for a secret-only ask (a repeated "confirm" about a value the owner typed themselves should not hold up a run).
 * @param {Record<string, string | undefined>} env process environment
 * @returns {number} CLAUDE_ASK_SECRET_TIMEOUT_S (default 120), but never more than the normal ask timeout
 */
export function secretAskTimeoutSeconds(env = process.env) {
  return Math.min(positiveSeconds(env[SECRET_ASK_TIMEOUT_ENV], DEFAULT_SECRET_ASK_TIMEOUT_S), askTimeoutSeconds(env));
}

/**
 * The timeout for Claude Code's own permission prompts (a "Dangerous rm operation not ruled out" check in bypassPermissions mode).
 * @param {Record<string, string | undefined>} env process environment
 * @returns {number} CLAUDE_PERMISSION_TIMEOUT_S when it is a positive number (at most 190), else 120; independent of CLAUDE_ASK_TIMEOUT_S
 */
export function permissionTimeoutSeconds(env = process.env) {
  return positiveSeconds(env[PERMISSION_TIMEOUT_ENV], DEFAULT_PERMISSION_TIMEOUT_S);
}

export const formatDuration = (seconds) => (seconds % SECONDS_PER_MINUTE === 0 ? `${seconds / SECONDS_PER_MINUTE} min` : `${seconds} s`);

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

/** @returns {string} the dialog body: tool, why, the labelled target (head and tail), detail lines, directory, session/agent, the timeout rule */
function dialogText({ tool, reason, command, targetLabel = 'Command', details = [], cwd, sessionId, agentId, buttons = ALLOW_DENY_BUTTONS }, timeoutS, platform) {
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
  const timeoutRule = buttons.defaultButton === 'decline' ? `${buttons.accept} is taken.` : 'it goes ahead.';
  const defaultLabel = buttons.defaultButton === 'decline' ? buttons.decline : buttons.accept;
  lines.push('', `${defaultLabel} is the default${yesNo}. With no answer in ${formatDuration(timeoutS)} ${timeoutRule}`);
  return lines.join('\n');
}

/**
 * @param {object} request what to show (see answerAsk)
 * @param {number} timeoutS seconds until the dialog closes itself
 * @param {string} platform process.platform
 * @returns {{command: string, args: string[], env: Record<string, string>} | undefined} how to run the dialog for this request; undefined for an unknown platform
 */
export const requestInvocation = (request, timeoutS, platform) =>
  dialogInvocation(platform, dialogText(request, timeoutS, platform), request.title ?? DIALOG_TITLE, timeoutS, request.buttons ?? ALLOW_DENY_BUTTONS);

/**
 * Turns what the person did into the decision answerAsk returns. A "timeout" is only believed when the full time really passed.
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

/**
 * Asks the owner through a native dialog and turns the answer into a decision.
 * @param {{tool: string, reason: string, command?: string, targetLabel?: string, details?: Array<{label: string, value: string, keepStart?: boolean}>, title?: string,
 *   buttons?: {accept: string, decline: string}, timeoutS?: number, cwd?: string, sessionId?: string, agentId?: string}} request
 *   what to show: `command` is the call's target (a command, or a file, URL or query when targetLabel says so; default label "Command");
 *   details are extra labelled lines (label and value masked and cut; keepStart shows a long value's start, else its head and tail); buttons default to Allow/Deny (accept -> "allow", decline -> "deny"); timeoutS overrides CLAUDE_ASK_TIMEOUT_S
 * @param {Record<string, string | undefined>} env process environment (timeout, ssh/CI detection, PATH)
 * @param {string} platform process.platform
 * @param {() => number} now clock in milliseconds (injectable so a test can simulate the full wait)
 * @returns {{decision: 'allow' | 'deny' | 'ask', outcome: 'allow' | 'deny' | 'timeout' | 'no-gui' | 'dialog-failed', reason: string}}
 *   decision "ask" means the caller falls back to the CLI's own prompt
 */
export function answerAsk(request, env = process.env, platform = process.platform, now = () => performance.now()) {
  const reason = maskSecrets(String(request.reason));
  if (!guiAvailable(env, platform)) return { decision: 'ask', outcome: 'no-gui', reason };
  const timeoutS = request.timeoutS ?? askTimeoutSeconds(env);
  let outcome = 'unavailable';
  let waitedMs = 0;
  try {
    const invocation = requestInvocation(request, timeoutS, platform);
    if (invocation) {
      const started = now();
      const result = spawnSync(invocation.command, invocation.args, {
        encoding: 'utf8',
        env: { ...env, ...invocation.env },
        timeout: (timeoutS + SPAWN_GRACE_S) * MS_PER_SECOND,
        windowsHide: true,
      });
      // killed or crashed dialog -> unavailable
      outcome = result.signal || result.status === null ? 'unavailable' : parseDialogResult(platform, result, request.buttons ?? ALLOW_DENY_BUTTONS);
      waitedMs = now() - started;
    }
  } catch {
    outcome = 'unavailable';
  }
  return answerFromOutcome(outcome, { reason, timeoutS, waitedMs });
}

/**
 * @param {{decision: 'allow' | 'deny' | 'ask', reason: string}} answer result of answerAsk
 * @returns {string} the PreToolUse hook JSON line for deny and ask; '' for allow (no decision: the normal permission flow applies)
 */
export function decisionOutput({ decision, reason }) {
  if (decision === 'allow') return '';
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } })}\n`;
}

/**
 * The whole timed ask for one hook call: dialog, decision log, hook JSON.
 * @param {{hook: string, tool: string, reason: string, command?: string, timeoutS?: number, cwd?: string, sessionId?: string, agentId?: string, omitCommandFromLog?: boolean, onAnswer?: (answer: ReturnType<typeof answerAsk>) => void}} request what to show and who asks
 *   (omitCommandFromLog: the dialog shows the command, the decision log does not; onAnswer runs after the log line, e.g. to remember an allow)
 * @param {Record<string, string | undefined>} env process environment
 * @returns {string} the hook stdout line for the decision (allow, deny, or the native ask as a fallback)
 */
export function askOwner(request, env = process.env) {
  const answer = answerAsk(request, env);
  logDecision({ hook: request.hook, tool: request.tool, decision: answer.decision, outcome: answer.outcome, reason: request.reason, command: request.omitCommandFromLog ? '' : request.command, cwd: request.cwd, session: request.sessionId }, env);
  request.onAnswer?.(answer);
  return decisionOutput(answer);
}
