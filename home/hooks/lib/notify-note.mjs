// The desktop notes of display design 7.10, only for "needs you" and "limit stopped work" (owner, 2026-11-19; the "agent failed"
// note and its queue were removed on 2026-11-24, nothing queued one):
// their texts, the terminal sequence that carries them (a hook's `terminalSequence` output: OSC 9, 99 or 777, or a bare BEL;
// hooks docs "Emit terminal notifications") and the channel the owner picked.
// Exports: needsYouText(type), stoppedText(sample), quotaText(type), noteSequence(text, channel),
// effectiveChannel(env), terminalName(env); NOTE_TITLE.
// Channel: `preferredNotifChannel` of Claude Code's global config (`$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`);
// `notifications_disabled` gives no note; `auto` (or none) picks by the terminal: Ghostty OSC 777, Kitty OSC 99, Apple Terminal a
// bell only (it shows no desktop note), else OSC 9 (iTerm2, WezTerm, Windows Terminal).
// Invariants: a note text has no control, format (bidi override, isolate, mark) or line-separator character (UNSAFE_TEXT: each is
// dropped), so no text can end the sequence early, add one, or reorder or split the note; a reset time is shown only when a limit
// sample has one, never guessed; nothing here throws (any failure reads as no note).
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readPlainFile } from './plain-file.mjs';

export const NOTE_TITLE = 'Claude';
const ESC = '\u001b';
const BEL = '\u0007';
const MAX_TEXT_CHARS = 160;
const MAX_CONFIG_BYTES = 16 * 1024 * 1024; // the global config holds every project's history; a bigger file is not read
const MS_PER_S = 1000;
const FULL_PERCENT = 100;
const ELICITATION_TYPES = ['elicitation_dialog', 'elicitation_url_dialog'];
const WINDOW_LABEL = { five_hour: '5-hour', seven_day: '7-day' };
const CHANNELS = ['auto', 'iterm2', 'iterm2_with_bell', 'terminal_bell', 'kitty', 'ghostty', 'notifications_disabled'];
/**
 * Characters no note text may carry: control characters, line and paragraph separators (U+2028/2029), and format characters (the bidi
 * overrides, isolates and marks that reorder text, zero-width and tag characters), except ZWNJ and ZWJ, which Persian words and emoji
 * need and which move nothing.
 */
const UNSAFE_TEXT = /[\p{Cc}\p{Zl}\p{Zp}]|(?![\u200c\u200d])\p{Cf}/gu;

const clean = (text) => String(text ?? '').replace(UNSAFE_TEXT, '').slice(0, MAX_TEXT_CHARS);
const pad2 = (n) => String(n).padStart(2, '0');
const clock = (epochMs) => { const d = new Date(epochMs); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

/**
 * @param {string} type the Notification hook's notification_type
 * @returns {string | null} `Needs you: ...`, or null for a type that is not a wait on the owner
 */
export function needsYouText(type) {
  if (type === 'permission_prompt') return 'Needs you: a permission prompt';
  return ELICITATION_TYPES.includes(type) ? 'Needs you: an MCP server asks for input' : null;
}

/**
 * @param {{ five_hour?: { used_percentage?: number, resets_at?: number } | null, seven_day?: object | null } | null} sample the
 *   account's last limit sample (limits-store latestSample), or null
 * @returns {string} `Stopped: 5-hour limit, resumes 17:40`; without a known reset, says so
 */
export function stoppedText(sample) {
  const windows = Object.keys(WINDOW_LABEL)
    .map((name) => ({ name, window: sample?.[name] }))
    .filter(({ window }) => Number.isFinite(window?.used_percentage) && Number.isFinite(window?.resets_at));
  const full = windows.find(({ window }) => window.used_percentage >= FULL_PERCENT);
  const chosen = full ?? windows.sort((a, b) => b.window.used_percentage - a.window.used_percentage)[0];
  if (!chosen) return 'Stopped: usage limit, reset time not known';
  return `Stopped: ${WINDOW_LABEL[chosen.name]} limit, resumes ${clock(chosen.window.resets_at * MS_PER_S)}`;
}

/** @returns {string | null} the note of a quota notification that leaves work stopped; null for one that resumed it */
export function quotaText(type) {
  if (type === 'quota_auto_resume_stale') return 'Stopped: usage limit reset while the computer slept · press Enter to go on';
  if (type === 'quota_auto_resume_disabled') return 'Stopped: usage limit · it will not resume by itself';
  return null;
}

/**
 * @param {string} text the note
 * @param {string} channel an effective channel (effectiveChannel)
 * @returns {string} the sequence for `terminalSequence`; '' for no note
 */
export function noteSequence(text, channel) {
  const body = clean(text);
  if (!body || channel === 'notifications_disabled') return '';
  if (channel === 'terminal_bell' || channel === 'bell') return BEL;
  if (channel === 'ghostty') return `${ESC}]777;notify;${NOTE_TITLE};${body}${BEL}`;
  if (channel === 'kitty') return `${ESC}]99;;${NOTE_TITLE}: ${body}${BEL}`;
  const osc9 = `${ESC}]9;${NOTE_TITLE}: ${body}${BEL}`;
  return channel === 'iterm2_with_bell' ? osc9 + BEL : osc9;
}

/** @returns {string} the terminal this session runs in, as its environment names it */
export function terminalName(env = process.env) {
  if (env.TERM_PROGRAM) return clean(env.TERM_PROGRAM);
  if (env.KITTY_WINDOW_ID || env.TERM === 'xterm-kitty') return 'kitty';
  if (env.WT_SESSION) return 'Windows Terminal';
  return clean(env.TERM || 'unknown');
}

/** The owner's `preferredNotifChannel`, or 'auto' when it is unset or cannot be read. */
function preferredChannel(env) {
  try {
    const file = join(env.CLAUDE_CONFIG_DIR || env.HOME || homedir(), '.claude.json');
    // a link (a dotfiles setup) is followed once by realpath; the read never waits (lib/plain-file.mjs): a FIFO, or a file over the cap,
    // throws and reads as unset
    const value = JSON.parse(readPlainFile(realpathSync(file), MAX_CONFIG_BYTES))?.preferredNotifChannel;
    return CHANNELS.includes(value) ? value : 'auto';
  } catch {
    return 'auto'; // no config yet: Claude Code's own default
  }
}

/** @returns {string} the channel a note goes out on: the owner's choice, or for `auto` the one this terminal shows */
export function effectiveChannel(env = process.env) {
  const chosen = preferredChannel(env);
  if (chosen !== 'auto') return chosen;
  const terminal = terminalName(env).toLowerCase();
  if (terminal === 'ghostty') return 'ghostty';
  if (terminal === 'kitty') return 'kitty';
  if (terminal === 'apple_terminal') return 'bell';
  return 'iterm2';
}
