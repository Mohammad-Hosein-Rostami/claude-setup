// Purpose: sets CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS=1 in every new terminal, so bypass mode runs a dangerous rm
//   without a prompt. Claude Code reads that variable only from the environment it starts in (it ignores it in a settings `env`
//   block), so it goes into the shell start-up files: zsh's first `.zshenv` (zshenvFile), bash `~/.bashrc` (Git Bash too), and
//   the PowerShell profile when install.ps1 named it (--ps-profile).
// Exports: addRmWaiverLines.
// Invariants: the installer's block is two lines, the why-comment (its mark) and the setting right under it, recorded as one
//   entry, so --uninstall (removeLine) takes out that block and nothing else. A file that holds the block already gets nothing
//   new; one where the user set the variable without the block gets nothing either, and that line is never recorded.
//   A running session keeps its old environment: the waiver starts with a `claude` launched from a new terminal.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { act, note, samePath } from './context.mjs';
import { ensureDir, remember } from './record.mjs';
import { endsWithoutNewline, homeOf, shellStartUpFile } from './startup.mjs';

const WAIVER_VARIABLE = 'CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS';
const WHY_LINE =
  '# claude-setup: no dangerous-rm prompt in bypass mode; Claude Code reads this variable only at launch, never from settings';
const SH_LINE = `export ${WAIVER_VARIABLE}=1`;
const PS_LINE = `$env:${WAIVER_VARIABLE} = '1'`;
const SETS_ZDOTDIR = /\bZDOTDIR=/;

/**
 * The `.zshenv` zsh reads first (zsh(1) STARTUP FILES: /etc/zshenv, then $ZDOTDIR/.zshenv, with HOME for an unset ZDOTDIR).
 * When ~/.zshenv itself sets ZDOTDIR, zsh has read ~/.zshenv already and never reads $ZDOTDIR/.zshenv, so the waiver goes
 * into ~/.zshenv; a ZDOTDIR from the environment zsh starts in (/etc/zshenv, the terminal) points at $ZDOTDIR/.zshenv.
 */
function zshenvFile(env) {
  const homeFile = join(homeOf(env), '.zshenv');
  if (!env.ZDOTDIR || (existsSync(homeFile) && SETS_ZDOTDIR.test(readFileSync(homeFile, 'utf8')))) return homeFile;
  return join(env.ZDOTDIR, '.zshenv');
}

/** The file every new shell of this login shell reads (zsh: .zshenv, read by every zsh, not only interactive ones), or null. */
function shellEnvFile(env) {
  return basename(env.SHELL || '') === 'zsh' ? zshenvFile(env) : shellStartUpFile(env); // bash: ~/.bashrc; fish, none: null
}

/**
 * Adds the waiver lines to the login shell's start-up file and, when install.ps1 named it, the PowerShell profile.
 * @param {object} ctx the run context (env.SHELL, env.HOME, env.ZDOTDIR, psProfile)
 * @param {object} record the install record
 */
export function addRmWaiverLines(ctx, record) {
  const shellFile = shellEnvFile(ctx.env);
  if (shellFile) ensureWaiver(ctx, record, shellFile, SH_LINE);
  if (ctx.psProfile) ensureWaiver(ctx, record, ctx.psProfile, PS_LINE);
}

/**
 * Takes out the entries an earlier install made for `file` line by line: its entry for the lone setting line also matched the
 * user's own copy, so --uninstall took that out too. The block entry replaces them.
 * @returns {boolean} true when one of them said the installer created the file
 */
function dropPerLineEntries(record, file, settingLine) {
  const isPerLine = (made) => made.kind === 'line' && samePath(made.path, file) && [WHY_LINE, settingLine].includes(made.line);
  const createdFile = record.made.some((made) => isPerLine(made) && made.createdFile);
  record.made = record.made.filter((made) => !isPerLine(made));
  return createdFile;
}

function ensureWaiver(ctx, record, file, settingLine) {
  const createdFile = dropPerLineEntries(record, file, settingLine);
  const block = `${WHY_LINE}\n${settingLine}`;
  const text = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const lines = text?.split(/\r?\n/) ?? [];
  if (lines.some((line, index) => line === WHY_LINE && lines[index + 1] === settingLine)) {
    remember(record, { kind: 'line', path: file, line: block, ...(createdFile && { createdFile }) });
    note(ctx, `ok ${WAIVER_VARIABLE} in ${file}`);
    return;
  }
  if (lines.includes(settingLine)) {
    note(ctx, `ok ${WAIVER_VARIABLE} in ${file}: your own line, which --uninstall leaves in place`);
    return;
  }
  ensureDir(ctx, record, dirname(file));
  act(ctx, `add ${WAIVER_VARIABLE} to ${file}`, () => {
    const addedNewline = endsWithoutNewline(text);
    appendFileSync(file, `${addedNewline ? '\n' : ''}${block}\n`);
    remember(record, { kind: 'line', path: file, line: block, createdFile: text === null, addedNewline });
    note(ctx, `added ${WAIVER_VARIABLE} to ${file} (restart Claude Code from a new terminal)`);
  });
}
