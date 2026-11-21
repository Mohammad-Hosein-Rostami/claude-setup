#!/usr/bin/env node
// Purpose: the one installer of the Claude Code setup, on macOS, Linux and Windows. scripts/install.sh and scripts/install.ps1
//   only find Node and call this file.
// Usage: node scripts/install.mjs [--update [--to <tag>]] [--uninstall] [--dry-run] [--no-plugins] [--no-tools]
//          [--project-workflows <repo> [--copy]] [--ps-profile <path>] [--claude-version <x.y.z>]
//   (no flag) / --update   link home/ into ~/.claude, ccm onto PATH, the claude-as start-up line, settings.json, plugins, tool
//                          dependencies; safe to repeat (a second run changes nothing). --update is the same run, by name.
//   --update --to <tag>    the same, with the links on a worktree of a phase tag (rollback; scripts/install/pin.mjs); a plain
//                          --update points them back at this checkout.
//   --claude-version <v>   install Claude Code <v> (the phase pin, 2.1.326 or newer) and prove it answers, else put the old
//                          binary back (scripts/install/cli.mjs)
//   --uninstall            remove what the install record names and put the backed-up files back (scripts/install/uninstall.mjs).
// Exports: LINKS, TOOLS_WITH_DEPS, main.
// Invariants: never deletes a file it did not make: anything replaced goes to ~/.claude-backup-<stamp>/ and is named in the
//   install record (~/.claude/.claude-setup-install.json, saved even when a step fails); settings are written after the plugin
//   installs, because `claude plugin install` re-enables plugins in settings.json and the merged repo settings must win; tool
//   dependencies come after settings, so a failed dependency install cannot leave settings.json stale.
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InstallError, makeContext, note, parseArgs } from './install/context.mjs';
import { ensureDir, loadRecord, saveRecord } from './install/record.mjs';
import { checkPath, linkHomeItems, linkLaunchers, projectWorkflows } from './install/links.mjs';
import { addStartupLines } from './install/startup.mjs';
import { buildSettings, isNewMachine } from './install/settings.mjs';
import { tagRoot } from './install/pin.mjs';
import { uninstall } from './install/uninstall.mjs';
import { addUserPath, requireGitBash } from './install/windows.mjs';
import { installClaude } from './install/cli.mjs';
import * as tools from './install/tools.mjs';

/** The home/ items linked into ~/.claude (doctor.sh checks the same list). */
export const LINKS = ['CLAUDE.md', 'lead.md', 'rules', 'skills', 'agents', 'standards', 'hooks', 'tools', 'project-notes', 'modes', 'workflows', 'statusline.mjs'];
// Tools with npm dependencies: ui-check (odiff-bin, pngjs) and env-names (yaml). scripts/lane-new.sh reads this line.
export const TOOLS_WITH_DEPS = ['ui-check', 'env-names'];

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function enableGitHooks(ctx) {
  if (ctx.dryRun) return;
  const run = spawnSync('git', ['-C', ctx.repo, 'config', 'core.hooksPath', '.githooks'], { encoding: 'utf8' });
  if (run.status === 0) note(ctx, 'git hooksPath = .githooks');
}

function install(ctx, record) {
  if (ctx.os === 'windows') requireGitBash(ctx);
  ctx.newMachine = isNewMachine(ctx, record);
  ensureDir(ctx, record, ctx.claudeDir);
  ctx.root = ctx.to ? tagRoot(ctx, record) : ctx.repo;
  Object.assign(record, { repo: ctx.repo, root: ctx.root, tag: ctx.to ?? null });
  linkHomeItems(ctx, record, LINKS);
  const pathFolders = linkLaunchers(ctx, record);
  if (ctx.os === 'windows') for (const folder of pathFolders.slice(1)) addUserPath(ctx, folder);
  else checkPath(ctx, pathFolders);
  addStartupLines(ctx, record);
  enableGitHooks(ctx);
  if (ctx.project) projectWorkflows(ctx, record);
  if (ctx.claudeVersion) installClaude(ctx); // before the plugin commands, which use the new CLI
  if (!ctx.noPlugins) tools.installPlugins(ctx);
  // Settings after plugins; tool dependencies after settings (header).
  buildSettings(ctx, record);
  if (!ctx.noTools) tools.installToolDeps(ctx, TOOLS_WITH_DEPS);
}

function printSummary(ctx, write) {
  write('');
  write('Completed so far:');
  for (const line of ctx?.done?.length ? ctx.done : ['nothing']) write(`  - ${line}`);
}

/**
 * Runs the installer.
 * @param {string[]} argv the arguments after the script name
 * @param {NodeJS.ProcessEnv} [env] the environment (tests give a fake HOME)
 * @returns {number} the exit code: 0 done, 1 a step failed, 2 bad usage
 */
export function main(argv, env = process.env) {
  let ctx;
  let record;
  try {
    ctx = makeContext(parseArgs(argv), REPO, env);
    if (ctx.uninstall) uninstall(ctx);
    else {
      record = loadRecord(ctx);
      install(ctx, record);
    }
  } catch (error) {
    console.error(`FAILED: ${error instanceof InstallError ? error.message : error.stack}`);
    printSummary(ctx, console.error);
    return error instanceof InstallError ? error.exitCode : 1;
  } finally {
    if (ctx && record) saveRecord(ctx, record);
  }
  if (ctx.dryRun) console.log('(dry-run: nothing changed)');
  printSummary(ctx, console.log);
  if (ctx.failures.length === 0) return 0;
  console.error(`FAILED plugin steps: ${ctx.failures.join(', ')}`);
  return 1;
}

// realpath: install.sh may name this file through a linked folder.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = main(process.argv.slice(2));
