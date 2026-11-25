// The stand-in first on every child's PATH, so a run plays no real sound. Exports: SHIMMED, shimText(spec), installShims(ops, spec),
// childPath(bin, quietDir, basePath).
// What sits where (plan section 9, PATH): `<run>/bin/` holds `afplay`; after it comes clean-env.mjs's quiet-tools folder (osascript,
// notify-send, powershell, zenity: inert, each logging `<tool> <args>`), then the runner's PATH. `afplay` (the macOS settings' sound
// hook) logs to the quiet-tools log like the other quiet tools. The scripted dialog this folder once held served the question popup,
// which the setup no longer has.
// Invariants: POSIX only (Windows: the scenarios that need these print NOT RUN, plan section 10); every path in a shim is
// single-quoted for sh; a shim never reaches a real tool.
import { delimiter, join } from 'node:path';
import { quote } from './context.mjs';

/** The tools a scenario's PATH replaces besides the quiet tools. */
export const SHIMMED = Object.freeze(['afplay']);

/**
 * @param {{quietLog: string}} spec
 * @returns {string} the afplay shim's sh text
 */
export function shimText({ quietLog }) {
  return `#!/bin/sh\n# e2e shim (tests/e2e/lib/shims.mjs): never plays a sound\nprintf '%s\\n' "afplay $*" >> ${quote(quietLog)}\nexit 0\n`;
}

/**
 * @param {ReturnType<import('./context.mjs').makeOps>} ops
 * @param {{bin: string, quietLog: string, platform?: string}} spec
 * @returns {string[]} the shims written (none on Windows)
 */
export function installShims(ops, { bin, quietLog, platform = process.platform }) {
  if (platform === 'win32') return [];
  const afplayShim = join(bin, 'afplay');
  ops.mkdir(bin);
  ops.write(afplayShim, shimText({ quietLog }), { mode: 0o755, label: `afplay shim, argv to ${quietLog}` });
  return [afplayShim];
}

/** @returns {string} the children's PATH: the run's shims, the quiet tools, then the runner's own PATH */
export const childPath = (bin, quietDir, basePath = process.env.PATH ?? '') => [bin, quietDir, basePath].filter(Boolean).join(delimiter);
