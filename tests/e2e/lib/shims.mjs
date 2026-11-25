// The stand-ins first on every child's PATH, so a run shows no real dialog, note or sound. Exports: SHIMMED, shimText(spec),
// installShims(ops, spec), childPath(bin, quietDir, basePath).
// What sits where (plan section 9, PATH): `<run>/bin/` holds the scripted dialog under the platform's dialog tool name
// (osascript on macOS, zenity on Linux: hooks/lib/timed-ask.mjs dialogExecutable) and `afplay`; after it comes clean-env.mjs's
// quiet-tools folder (osascript, notify-send, powershell, zenity: inert, each logging `<tool> <args>`), then the runner's PATH.
// The scripted dialog appends its argv to the dialog log, then runs fake-dialog-tool.mjs's fake popup with the answer named in
// the mode file (allow | deny | timeout; deny when the file is missing), so a scenario switches the answer between runs. A
// desktop note goes through the same tool; logs.mjs dialogCalls counts only calls that open a dialog. `afplay` (the macOS
// settings' sound hook) logs to the quiet-tools log like the other quiet tools.
// Invariants: POSIX only (Windows: the scenarios that need these print NOT RUN, plan section 10); every path in a shim is
// single-quoted for sh; a shim never reaches a real tool.
import { delimiter, join } from 'node:path';
import { dialogExecutable } from '../../../home/hooks/lib/timed-ask.mjs';
import { quote } from './context.mjs';

/** The tools a scenario's PATH replaces besides the quiet tools. */
export const SHIMMED = Object.freeze(['afplay']);

/**
 * @param {{kind: 'dialog' | 'afplay', dialogLog?: string, quietLog?: string, modeFile?: string, popupBin?: string,
 *   popupPidFile?: string}} spec
 * @returns {string} the shim's sh text
 */
export function shimText({ kind, dialogLog, quietLog, modeFile, popupBin, popupPidFile }) {
  if (kind === 'afplay') {
    return `#!/bin/sh\n# e2e shim (tests/e2e/lib/shims.mjs): never plays a sound\nprintf '%s\\n' "afplay $*" >> ${quote(quietLog)}\nexit 0\n`;
  }
  return [
    '#!/bin/sh',
    '# e2e scripted dialog (tests/e2e/lib/shims.mjs): logs its argv, then the fake popup answers as the mode file says',
    `printf '%s\\n' "$*" >> ${quote(dialogLog)}`,
    `mode="$(cat ${quote(modeFile)} 2>/dev/null)"`,
    'case "$mode" in allow|deny|timeout) ;; *) mode=deny ;; esac',
    `FAKE_POPUP_RESULT="$mode" FAKE_POPUP_PID=${quote(popupPidFile)} exec ${quote(popupBin)} "$@"`,
    '',
  ].join('\n');
}

/**
 * @param {ReturnType<import('./context.mjs').makeOps>} ops
 * @param {{bin: string, dialogLog: string, quietLog: string, modeFile: string, popupDir: string, platform?: string}} spec
 *   `popupDir` the folder fakePopup made (its tool is there under the dialog tool name)
 * @returns {string[]} the shims written (none on Windows)
 */
export function installShims(ops, { bin, dialogLog, quietLog, modeFile, popupDir, platform = process.platform }) {
  if (platform === 'win32') return [];
  const dialogTool = dialogExecutable(platform);
  const dialogShim = join(bin, dialogTool);
  const afplayShim = join(bin, 'afplay');
  ops.mkdir(bin);
  ops.write(dialogShim, shimText({ kind: 'dialog', dialogLog, modeFile, popupBin: join(popupDir, dialogTool), popupPidFile: join(popupDir, 'popup.pid') }),
    { mode: 0o755, label: `scripted dialog as ${dialogTool}, argv to ${dialogLog}` });
  ops.write(afplayShim, shimText({ kind: 'afplay', quietLog }), { mode: 0o755, label: `afplay shim, argv to ${quietLog}` });
  ops.write(modeFile, 'deny', { label: 'scripted dialog: deny until a scenario says otherwise' });
  return [dialogShim, afplayShim];
}

/** @returns {string} the children's PATH: the run's shims, the quiet tools, then the runner's own PATH */
export const childPath = (bin, quietDir, basePath = process.env.PATH ?? '') => [bin, quietDir, basePath].filter(Boolean).join(delimiter);
