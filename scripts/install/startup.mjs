// Purpose: the one start-up line that gives every new terminal the `claude-as` function (spec-accounts.md "Start-up line"):
//   zsh or bash source home/shell/claude-as.sh, PowerShell dot-sources home/shell/claude-as.ps1. The line holds no token and
//   no account name.
// Exports: addStartupLines, removeLine, endsWithoutNewline, shellStartUpFile, homeOf.
// Invariants: the line is found again by its mark (START_UP_MARK), so a second run, or a machine where an earlier install added
//   it, never gets a second one (the installer takes the existing line over); a marked line for another path is left as it is
//   and named, never rewritten. The rc file is the login shell's (shellStartUpFile). removeLine undoes an append byte for byte:
//   only the recorded text goes, and the newline the install put after a last line that had none.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { act, note, warn } from './context.mjs';
import { ensureDir, remember } from './record.mjs';

/** The comment that ends the start-up line install.sh and install.ps1 write; the line is found by it. */
const START_UP_MARK = '# claude-setup: claude-as';

/** The user's home folder from the run's env (HOME, or USERPROFILE on Windows). */
export const homeOf = (env) => env.HOME || env.USERPROFILE || '';

/** The rc file install.sh writes the line to for this login shell, or null for a shell it does not write (fish, none). */
export function shellStartUpFile(env) {
  const shell = basename(env.SHELL || '');
  if (shell === 'zsh') return join(env.ZDOTDIR || homeOf(env), '.zshrc');
  if (shell === 'bash') return join(homeOf(env), '.bashrc');
  return null;
}

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
    const addedNewline = endsWithoutNewline(text);
    appendFileSync(file, `${addedNewline ? '\n' : ''}${line}\n`);
    remember(record, { kind: 'line', path: file, line, createdFile: text === null, addedNewline });
    note(ctx, `added the claude-as start-up line to ${file}`);
  });
}

/**
 * True when `text` (a file's text, null when there is none) has a last line with no newline after it: an append first ends that
 * line, and records so (`addedNewline`), so that removeLine can take the newline away again.
 */
export const endsWithoutNewline = (text) => Boolean(text) && !text.endsWith('\n');

/** Where the rows of `block` stand one after another in `rows` (each row without its line end), the last such place; -1 when nowhere. */
function lastBlockStart(rows, block) {
  for (let start = rows.length - block.length; start >= 0; start -= 1) {
    if (block.every((line, offset) => rows[start + offset] === line)) return start;
  }
  return -1;
}

/**
 * Takes one recorded line, or block of lines (`line` holds them joined by "\n"), out of a file: only its last place, since the
 * install appended it, so the user's own copy of the same text stays. When the install also ended the user's last line
 * (`addedNewline`) and the block is still the end of the file, that newline goes too: the file is byte for byte as before.
 * Deletes the file when the installer made it and nothing else is left.
 * @param {{path: string, line: string, createdFile?: boolean, addedNewline?: boolean}} entry the record entry
 * @returns {boolean} true when the line was there
 */
export function removeLine(entry) {
  if (!existsSync(entry.path)) return false;
  const rows = readFileSync(entry.path, 'utf8').split(/(?<=\n)/);
  const block = entry.line.split('\n');
  const start = lastBlockStart(rows.map((row) => row.replace(/\r?\n$/, '')), block);
  if (start === -1) return false;
  const before = rows.slice(0, start).join('');
  const after = rows.slice(start + block.length).join('');
  const rest = entry.addedNewline && after === '' && before.endsWith('\n') ? before.slice(0, -1) : before + after;
  if (entry.createdFile && rest.trim() === '') rmSync(entry.path);
  else writeFileSync(entry.path, rest);
  return true;
}
