#!/usr/bin/env node
// with-run-tmp: runs a command with TMPDIR, TMP and TEMP pointing at a fresh folder and removes that folder afterwards, whether the
// command passed, failed or was interrupted. It is a hand CLI: nothing starts it by itself, so run a suite through it to leave no temp folders behind.
// Usage: with-run-tmp.mjs [--shell] -- <command> [args...]    (--shell: the words are joined and run through the shell)
// Exit codes: the command's own code (128 + signal number when a signal ended it); 2 for a usage error or when the folder cannot be made.
// Invariants: the folder is made under os.tmpdir() with the prefix `cs-run-` (disk-clean removes one a killed run left behind);
//   children and grandchildren inherit TMPDIR, so os.tmpdir() inside them is the same folder; SIGINT, SIGTERM and SIGHUP go on to the command.
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RUN_TMP_PREFIX = 'cs-run-';
const EXIT_USAGE = 2;
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const USAGE = 'usage: with-run-tmp.mjs [--shell] -- <command> [args...]';

/**
 * Runs the command in a fresh temp folder (TMPDIR, TMP and TEMP) and removes the folder when it ends.
 * @param {string[]} words the command and its arguments
 * @param {{ shell?: boolean, cwd?: string, stdio?: import('node:child_process').StdioOptions }} options
 * @returns {Promise<number>} the command's exit code (128 + signal number after a signal), or 2 when it could not start
 */
export function runWithRunTmp(words, { shell = false, cwd, stdio = 'inherit' } = {}) {
  const runDir = mkdtempSync(join(tmpdir(), RUN_TMP_PREFIX));
  const env = { ...process.env, TMPDIR: runDir, TMP: runDir, TEMP: runDir };
  const child = shell ? spawn(words.join(' '), { env, cwd, stdio, shell: true }) : spawn(words[0], words.slice(1), { env, cwd, stdio });
  const forward = (signal) => child.kill(signal);
  for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
  return new Promise((resolve) => {
    const finish = (code) => {
      for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
      rmSync(runDir, { recursive: true, force: true });
      resolve(code);
    };
    child.on('error', (error) => {
      console.error(`with-run-tmp: could not run ${words[0]}: ${error.message}`);
      finish(EXIT_USAGE);
    });
    child.on('close', (code, signal) => finish(code ?? 128 + (constants.signals[signal] ?? 0)));
  });
}

async function main(argv) {
  const shell = argv[0] === '--shell';
  const words = argv.slice(shell ? 2 : 1);
  if (argv[shell ? 1 : 0] !== '--' || words.length === 0) {
    console.error(USAGE);
    return EXIT_USAGE;
  }
  try {
    return await runWithRunTmp(words, { shell });
  } catch (error) {
    console.error(`with-run-tmp: ${error.message}`);
    return EXIT_USAGE;
  }
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
