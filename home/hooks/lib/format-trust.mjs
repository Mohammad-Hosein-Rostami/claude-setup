// When post-edit may run a project's `format` script (audit H8: a cloned repo's script is repo text and would run at the first edit).
// Exports: TRUST_ENV, formatterCall(script), trustedFormat(env, cwd, packageDir), refusedText(refused).
// Rules: the script runs through the package manager only in a project the owner trusts: TRUST_ENV is "1" from the shell or the
//   project's untracked .claude/settings.local.json (lib/team-switch.mjs: a committed team file cannot set it), and the package.json
//   lies inside one of the session's project folders, so a trust set for one project never reaches a repo cloned elsewhere. Untrusted,
//   a script that is one plain call of a known formatter (KNOWN_FORMATTERS) runs as that tool's binary with the script's words, never
//   through npm, pnpm or yarn, so no pre/post script, .npmrc script-shell or yarnPath of the repo runs; anything else is not run.
// Left open: the formatter itself still reads the repo's config (prettier.config.js and eslint.config.js run code) and may be the
//   repo's node_modules binary; only trust settles that, so the README says so.
// Invariants: pure except trustedFormat, which reads the project settings through lib/team-switch.mjs and resolves real paths.
import { realpathSync } from 'node:fs';
import { isInside } from './agent-brief.mjs';
import { escaped } from './shown-name.mjs';
import { switchDirs, trustedSwitch } from './team-switch.mjs';

/** Env var that lets any `format` script of the session's project run: "1". Honoured from the shell or the untracked settings.local.json only. */
export const TRUST_ENV = 'CLAUDE_POST_EDIT_TRUST_FORMAT';
const TRUSTED_VALUE = '1';
// Formatter calls that run without trust: the first word is the tool; `next` must be the second word, `flag` any later word.
const KNOWN_FORMATTERS = [
  { tool: 'prettier' }, { tool: 'biome' }, { tool: 'eslint', flag: '--fix' }, { tool: 'dprint' }, { tool: 'oxfmt' },
  { tool: 'ruff', next: 'format' }, { tool: 'black' }, { tool: 'gofmt' },
];
// A chain, pipe, redirect, substitution, quote or escape (sh and cmd.exe): the script is then more than one plain call, or its words
// cannot be split on spaces alone.
const NOT_ONE_PLAIN_CALL = /[;&|<>`$()%^!"'\\\r\n]/;

/**
 * The words of `script` when it is one plain call of a known formatter (`prettier --write`, `eslint --fix src`), else null. Pure.
 * @param {string} script the package.json `format` script (repo text)
 * @returns {string[] | null} the tool name, then its arguments
 */
export function formatterCall(script) {
  if (NOT_ONE_PLAIN_CALL.test(script)) return null;
  const words = script.trim().split(/\s+/);
  const [tool, next, ...rest] = words;
  const known = KNOWN_FORMATTERS.some((formatter) => formatter.tool === tool && (formatter.next === undefined || formatter.next === next)
    && (formatter.flag === undefined || [next, ...rest].includes(formatter.flag)));
  return known ? words : null;
}

/** The real path of `folder`, or the folder itself when it cannot be resolved (then it simply matches less). */
function realFolder(folder) {
  try {
    return realpathSync(folder);
  } catch {
    return folder; // gone or unreadable: compared as given
  }
}

/**
 * Whether the owner trusts the format scripts of the package in `packageDir`: TRUST_ENV is "1", no team file set it
 * (lib/team-switch.mjs), and the package lies inside one of the session's project folders (a trust set for one project never reaches
 * a repo cloned somewhere else).
 * @param {Record<string, string|undefined>} env the hook's environment
 * @param {string|undefined} cwd the hook input's cwd
 * @param {string} packageDir the folder of the package.json
 * @returns {{ trusted: boolean, ignored: string|null }} ignored: why a team file's TRUST_ENV was not honoured, else null
 */
export function trustedFormat(env, cwd, packageDir) {
  const dirs = switchDirs(env, cwd);
  const { value, ignored } = trustedSwitch(env, TRUST_ENV, dirs);
  const real = realFolder(packageDir);
  return { trusted: value === TRUSTED_VALUE && dirs.some((dir) => isInside(real, realFolder(dir))), ignored };
}

/** The one-line warning for a format script that was not run (formatFile's `refused`). */
export function refusedText({ dir, ignored }) {
  const where = escaped(dir);
  const known = KNOWN_FORMATTERS.map((f) => [f.tool, f.next, f.flag].filter(Boolean).join(' ')).join(', ');
  const how = `set ${TRUST_ENV}=${TRUSTED_VALUE} in this project's .claude/settings.local.json (kept out of git) or in your shell to run it`;
  return `post-edit: the format script of ${where}/package.json was not run: it is not one plain call of a known formatter (${known}); ${how}${ignored ? ` (${ignored})` : ''}`;
}
