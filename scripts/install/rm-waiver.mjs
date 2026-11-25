// Purpose: sets CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS=1 in every new terminal, so bypass mode runs a dangerous rm
//   without a prompt. Claude Code reads that variable only from the environment it starts in (it ignores it in a settings `env`
//   block), so it goes into the shell start-up files: zsh `~/.zshenv`, bash `~/.bashrc` (Git Bash too), and the PowerShell
//   profile when install.ps1 named it (--ps-profile).
// Exports: addRmWaiverLines.
// Invariants: two lines per file, a why-comment and the setting; a file that already holds the setting line gets nothing new,
//   so a second run adds no copy. Both lines are named in the install record, so --uninstall takes them out (removeLine).
//   A running session keeps its old environment: the waiver starts with a `claude` launched from a new terminal.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { act, note } from './context.mjs';
import { ensureDir, remember } from './record.mjs';

const WAIVER_VARIABLE = 'CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS';
const WHY_LINE =
  '# claude-setup: no dangerous-rm prompt in bypass mode; Claude Code reads this variable only at launch, never from settings';
const SH_LINE = `export ${WAIVER_VARIABLE}=1`;
const PS_LINE = `$env:${WAIVER_VARIABLE} = '1'`;

const homeOf = (env) => env.HOME || env.USERPROFILE || '';

/** The file every new shell of this login shell reads, or null for a shell the installer does not write (fish, none). */
function shellEnvFile(env) {
  const shell = basename(env.SHELL || '');
  if (shell === 'zsh') return join(env.ZDOTDIR || homeOf(env), '.zshenv'); // read by every zsh, not only interactive ones
  if (shell === 'bash') return join(homeOf(env), '.bashrc');
  return null;
}

/**
 * Adds the waiver lines to the login shell's start-up file and, when install.ps1 named it, the PowerShell profile.
 * @param {object} ctx the run context (env.SHELL, env.HOME, psProfile)
 * @param {object} record the install record
 */
export function addRmWaiverLines(ctx, record) {
  const shellFile = shellEnvFile(ctx.env);
  if (shellFile) ensureWaiver(ctx, record, shellFile, SH_LINE);
  if (ctx.psProfile) ensureWaiver(ctx, record, ctx.psProfile, PS_LINE);
}

function ensureWaiver(ctx, record, file, settingLine) {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const lines = text?.split(/\r?\n/) ?? [];
  if (lines.includes(settingLine)) {
    for (const line of [WHY_LINE, settingLine]) if (lines.includes(line)) remember(record, { kind: 'line', path: file, line });
    note(ctx, `ok ${WAIVER_VARIABLE} in ${file}`);
    return;
  }
  ensureDir(ctx, record, dirname(file));
  act(ctx, `add ${WAIVER_VARIABLE} to ${file}`, () => {
    appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${WHY_LINE}\n${settingLine}\n`);
    for (const line of [WHY_LINE, settingLine]) remember(record, { kind: 'line', path: file, line, createdFile: text === null });
    note(ctx, `added ${WAIVER_VARIABLE} to ${file} (restart Claude Code from a new terminal)`);
  });
}
