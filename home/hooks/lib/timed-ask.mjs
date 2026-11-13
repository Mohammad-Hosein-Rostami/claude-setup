// Timed ask for PreToolUse hooks. Exports: askTimeoutSeconds(env), guiAvailable(env, platform), dialogInvocation(platform, text,
// title, timeoutS), parseDialogResult(platform, result) -> 'allow'|'deny'|'timeout'|'unavailable', answerAsk(request, env) ->
// {decision, outcome, reason}, decisionOutput(answer) -> hook stdout, askOwner(request, env) -> hook stdout (asks, logs, formats).
// Why: the native "ask" waits forever. The owner's policy is "block nothing": show a native dialog with Allow (default) and Deny,
// and go ahead when nobody answers within CLAUDE_ASK_TIMEOUT_S (default 180, at most 190 so it stays under the 200 s hook
// timeout). Only a click on Deny denies. Allow and timeout print NO decision (empty stdout, exit 0): the CLI's normal permission
// flow then still applies, so base.json deny rules keep working and the rest of a compound command is not pre-approved.
// A timeout only counts when the full time really passed; a dialog that was killed, crashed or gave up early is "dialog-failed".
// No GUI (ssh session, CI, no display) or a failing dialog tool -> decision "ask": the CLI's own prompt, which also covers
// bypassPermissions mode. Dialog tools: macOS osascript, Windows PowerShell WScript.Shell Popup (its buttons are fixed to
// Yes = Allow / No = Deny), Linux zenity. The dialog text is built from masked, truncated text and is passed as an argument or
// an environment variable, never spliced into a script. Invariants: never throws, never puts a secret in the dialog.
import { spawnSync } from 'node:child_process';
import { logDecision } from './guard-log.mjs';
import { maskSecrets } from './secrets.mjs';

export const ASK_TIMEOUT_ENV = 'CLAUDE_ASK_TIMEOUT_S';
export const DEFAULT_ASK_TIMEOUT_S = 180;
export const MAX_ASK_TIMEOUT_S = 190; // the hook timeout in settings/base.json is 200 s
const TIMEOUT_SLACK_MS = 500; // a dialog tool may report its timeout marginally before the full time has elapsed
const MS_PER_SECOND = 1000;
const SPAWN_GRACE_S = 5; // the dialog tool gives up by itself at the timeout; this only stops one that hangs
const MAX_COMMAND_CHARS = 200;
const MAX_MASKED_INPUT = 2048;
const SECONDS_PER_MINUTE = 60;
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
const USER_CANCELED_TEXT = /user canceled/i;

// Popup(text, seconds, title, 4 + 32): Yes/No buttons, question icon, first button (Yes) is the default.
const WINDOWS_SCRIPT = `$ErrorActionPreference='Stop'; $w=New-Object -ComObject WScript.Shell; [Console]::Out.Write($w.Popup($env:${TEXT_ENV}, ${'$'}args[0], $env:${TITLE_ENV}, 36))`;
const MAC_SCRIPT = [
  'on run argv',
  'display dialog (item 1 of argv) with title (item 2 of argv) buttons {"Deny", "Allow"} default button "Allow" with icon caution giving up after ((item 3 of argv) as integer)',
  'end run',
];

/** @returns {number} the dialog timeout in whole seconds: CLAUDE_ASK_TIMEOUT_S when it is a positive number (at most 190), else 180 */
export function askTimeoutSeconds(env = process.env) {
  const seconds = Math.floor(Number(env[ASK_TIMEOUT_ENV]));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, MAX_ASK_TIMEOUT_S) : DEFAULT_ASK_TIMEOUT_S;
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

const escapeMarkup = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
 * @returns {{command: string, args: string[], env: Record<string, string>} | undefined} how to run the dialog; undefined for an unknown platform
 */
export function dialogInvocation(platform, text, title, timeoutS) {
  const command = dialogExecutable(platform);
  if (platform === 'darwin') return { command, args: [...MAC_SCRIPT.flatMap((line) => ['-e', line]), text, title, String(timeoutS)], env: {} };
  if (platform === 'win32') {
    return { command, args: ['-NoProfile', '-NonInteractive', '-Command', `& { ${WINDOWS_SCRIPT} }`, String(timeoutS)], env: { [TEXT_ENV]: text, [TITLE_ENV]: title } };
  }
  if (platform === 'linux') {
    return { command, args: ['--question', `--title=${title}`, `--text=${escapeMarkup(text)}`, '--ok-label=Allow', '--cancel-label=Deny', `--timeout=${timeoutS}`, '--width=520'], env: {} };
  }
  return undefined;
}

/**
 * @param {string} platform process.platform
 * @param {{status: number | null, stdout?: string, stderr?: string, error?: Error}} result spawnSync result
 * @returns {'allow' | 'deny' | 'timeout' | 'unavailable'} what the person did; "unavailable" when the dialog tool failed
 */
export function parseDialogResult(platform, result) {
  if (result.error) return 'unavailable';
  const out = String(result.stdout ?? '');
  const err = String(result.stderr ?? '');
  if (platform === 'darwin') {
    if (/gave up:true/.test(out)) return 'timeout';
    if (/button returned:Allow/.test(out)) return 'allow';
    if (/button returned:Deny/.test(out) || USER_CANCELED_TEXT.test(err)) return 'deny';
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

/** @returns {string} the dialog body: tool, why, masked short command, directory, session/agent, and the 3-minute rule */
function dialogText({ tool, reason, command, cwd, sessionId, agentId }, timeoutS) {
  const masked = maskSecrets(String(command ?? '').slice(0, MAX_MASKED_INPUT)); // a huge command is cut before masking (regex work stays bounded)
  const short = masked.length > MAX_COMMAND_CHARS ? `${masked.slice(0, MAX_COMMAND_CHARS)}...` : masked;
  const who = [sessionId && `session ${String(sessionId).slice(0, 8)}`, agentId && `agent ${String(agentId).slice(0, 8)}`].filter(Boolean).join(', ');
  const lines = [`Tool: ${tool}`, `Why: ${maskSecrets(String(reason))}`];
  if (short) lines.push(`Command: ${short}`);
  if (cwd) lines.push(`Directory: ${cwd}`);
  if (who) lines.push(`From: ${who}`);
  lines.push('', `Allow is the default. With no answer in ${formatDuration(timeoutS)} it goes ahead.`);
  return lines.join('\n');
}

/**
 * Asks the owner through a native dialog and turns the answer into a decision.
 * @param {{tool: string, reason: string, command?: string, cwd?: string, sessionId?: string, agentId?: string}} request what to show
 * @param {Record<string, string | undefined>} env process environment (timeout, ssh/CI detection, PATH)
 * @param {string} platform process.platform
 * @param {() => number} now clock in milliseconds (injectable so a test can simulate the full wait)
 * @returns {{decision: 'allow' | 'deny' | 'ask', outcome: 'allow' | 'deny' | 'timeout' | 'no-gui' | 'dialog-failed', reason: string}}
 *   decision "ask" means the caller falls back to the CLI's own prompt
 */
export function answerAsk(request, env = process.env, platform = process.platform, now = () => performance.now()) {
  const reason = maskSecrets(String(request.reason));
  if (!guiAvailable(env, platform)) return { decision: 'ask', outcome: 'no-gui', reason };
  const timeoutS = askTimeoutSeconds(env);
  let outcome = 'unavailable';
  try {
    const invocation = dialogInvocation(platform, dialogText(request, timeoutS), DIALOG_TITLE, timeoutS);
    if (invocation) {
      const started = now();
      const result = spawnSync(invocation.command, invocation.args, {
        encoding: 'utf8',
        env: { ...env, ...invocation.env },
        timeout: (timeoutS + SPAWN_GRACE_S) * MS_PER_SECOND,
        windowsHide: true,
      });
      // killed or crashed dialog -> unavailable; a "timeout" is only believed when the full time has passed
      outcome = result.signal || result.status === null ? 'unavailable' : parseDialogResult(platform, result);
      const waitedMs = now() - started;
      if (outcome === 'timeout' && waitedMs < timeoutS * MS_PER_SECOND - TIMEOUT_SLACK_MS) outcome = 'unavailable';
    }
  } catch {
    outcome = 'unavailable';
  }
  if (outcome === 'unavailable') return { decision: 'ask', outcome: 'dialog-failed', reason };
  if (outcome === 'deny') return { decision: 'deny', outcome, reason: `denied by the owner in the dialog (${reason})` };
  if (outcome === 'timeout') return { decision: 'allow', outcome, reason: `no answer in ${formatDuration(timeoutS)}, went ahead (${reason})` };
  return { decision: 'allow', outcome, reason: `allowed by the owner in the dialog (${reason})` };
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
 * @param {{hook: string, tool: string, reason: string, command?: string, cwd?: string, sessionId?: string, agentId?: string, omitCommandFromLog?: boolean}} request what to show and who asks
 *   (omitCommandFromLog: the dialog shows the command, the decision log does not)
 * @param {Record<string, string | undefined>} env process environment
 * @returns {string} the hook stdout line for the decision (allow, deny, or the native ask as a fallback)
 */
export function askOwner(request, env = process.env) {
  const answer = answerAsk(request, env);
  logDecision({ hook: request.hook, tool: request.tool, decision: answer.decision, outcome: answer.outcome, reason: request.reason, command: request.omitCommandFromLog ? '' : request.command, cwd: request.cwd, session: request.sessionId }, env);
  return decisionOutput(answer);
}
