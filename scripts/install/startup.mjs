// Purpose: the one start-up line that gives every new terminal the `claude-as` function (spec-accounts.md "Start-up line"):
//   zsh or bash source home/shell/claude-as.sh, PowerShell dot-sources home/shell/claude-as.ps1. The line holds no token and
//   no account name.
// Exports: addStartupLines, removeLine.
// Invariants: the line is found again by its mark (START_UP_MARK), so a second run, or a machine where an earlier install added
//   it, never gets a second one (the installer takes the existing line over); a marked line for another path is left as it is
//   and named, never rewritten. The rc file follows scripts/doctor-accounts.mjs shellStartUpFile, which doctor checks.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { START_UP_MARK, shellStartUpFile } from '../doctor-accounts.mjs';
import { act, note, warn } from './context.mjs';
import { ensureDir, remember } from './record.mjs';

const shLine = (snippet) => `if [ -f '${snippet}' ]; then . '${snippet}'; fi ${START_UP_MARK}`;
const psLine = (snippet) => `if (Test-Path -LiteralPath '${snippet}') { . '${snippet}' } ${START_UP_MARK}`;

/**
 * Adds the start-up line to the login shell's rc file and, when install.ps1 named it (--ps-profile), the PowerShell profile.
 * @param {object} ctx the run context (env.SHELL, psProfile, repo)
 * @param {object} record the install record
 */
export function addStartupLines(ctx, record) {
  const rc = shellStartUpFile(ctx.env);
  const shell = join(ctx.repo, 'home', 'shell');
  if (rc) ensureLine(ctx, record, rc, join(shell, 'claude-as.sh'), shLine);
  else if (!ctx.psProfile) warn(`login shell ${ctx.env.SHELL || '(none)'}: no start-up line written; source ${join(shell, 'claude-as.sh')} from its start-up file by hand`);
  if (ctx.psProfile) ensureLine(ctx, record, ctx.psProfile, join(shell, 'claude-as.ps1'), psLine);
}

function ensureLine(ctx, record, file, snippet, lineFor) {
  if (snippet.includes("'")) {
    warn(`the repo path holds a quote; no claude-as start-up line written to ${file}`);
    return;
  }
  const line = lineFor(snippet);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (text?.split(/\r?\n/).includes(line)) {
    remember(record, { kind: 'line', path: file, line });
    note(ctx, `ok claude-as start-up line in ${file}`);
    return;
  }
  if (text?.includes(START_UP_MARK)) {
    warn(`${file} has a claude-as start-up line for another path; left as it is (replace it with: ${line})`);
    return;
  }
  ensureDir(ctx, record, dirname(file));
  act(ctx, `add the claude-as start-up line to ${file}`, () => {
    appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`);
    remember(record, { kind: 'line', path: file, line, createdFile: text === null });
    note(ctx, `added the claude-as start-up line to ${file}`);
  });
}

/**
 * Takes one recorded line out of a file; deletes the file when the installer made it and nothing else is left.
 * @param {{path: string, line: string, createdFile?: boolean}} entry the record entry
 * @returns {boolean} true when the line was there
 */
export function removeLine(entry) {
  if (!existsSync(entry.path)) return false;
  const lines = readFileSync(entry.path, 'utf8').split(/(?<=\n)/);
  const kept = lines.filter((row) => row.replace(/\r?\n$/, '') !== entry.line);
  if (kept.length === lines.length) return false;
  const rest = kept.join('');
  if (entry.createdFile && rest.trim() === '') rmSync(entry.path);
  else writeFileSync(entry.path, rest);
  return true;
}
