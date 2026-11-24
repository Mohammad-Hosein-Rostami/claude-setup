// Static check of the installer call order (scripts/install.mjs, the one installer that install.sh and install.ps1 call).
// Exports: none (node:test file).
// Invariants: settings are written after plugin installs, because `claude plugin install`
// re-enables plugins in ~/.claude/settings.json and the merged repo settings must win; tool deps
// run after settings, so a failed dependency install cannot leave settings.json stale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * Line index of the first top-level call matching `pattern` (definitions excluded).
 * @param {string[]} lines script lines
 * @param {RegExp} pattern call pattern
 * @returns {number} index, or -1 when absent
 */
function callIndex(lines, pattern) {
  return lines.findIndex((line) => pattern.test(line) && !/^\s*(function\s|\w+\s*\(\)\s*\{)/.test(line));
}

for (const [file, plugins, settings, tools] of [
  ['scripts/install.mjs', /\btools\.installPlugins\b/, /^\s*buildSettings\(ctx, record\);\s*$/, /\btools\.installToolDeps\b/],
]) {
  test(`${file}: plugins, then settings, then tool deps`, () => {
    const lines = readFileSync(`${root}${file}`, 'utf8').split(/\r?\n/);
    const [pluginCall, settingsCall, toolsCall] = [plugins, settings, tools].map((p) => callIndex(lines, p));
    assert.ok(pluginCall >= 0 && settingsCall >= 0 && toolsCall >= 0, 'an installer step call was not found');
    assert.ok(settingsCall > pluginCall, `settings built on line ${settingsCall + 1}, before plugins (${pluginCall + 1})`);
    assert.ok(toolsCall > settingsCall, `tool deps on line ${toolsCall + 1}, before settings (${settingsCall + 1})`);
  });
}

for (const file of ['scripts/install.mjs', 'scripts/doctor.sh']) {
  test(`${file}: the list of linked home items ends with the status line and holds no workflows link (workflows are gone)`, () => {
    const text = readFileSync(`${root}${file}`, 'utf8');
    assert.match(text, /project-notes[ ',]+statusline\.mjs/);
    assert.doesNotMatch(text, /project-notes[ ',]+workflows/);
  });
}
