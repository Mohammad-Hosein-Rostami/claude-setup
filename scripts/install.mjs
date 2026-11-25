#!/usr/bin/env node
// Purpose: installs, updates and removes the Claude Code setup on macOS, Linux and Windows; it is the one installer.
//   scripts/install.sh and scripts/install.ps1 only find Node 22.15+ and call this file; install.ps1 also stops when jq is
//   missing, except for -Uninstall. On Windows this file stops without Git Bash (scripts/install/windows.mjs). What each part of
//   scripts/install/ does is in scripts/install/README.md.
// Usage: node scripts/install.mjs [--update [--to <tag>]] [--uninstall] [--dry-run] [--no-plugins] [--no-tools]
//          [--ps-profile <path>] [--claude-version <x.y.z>]
//   (no flag) / --update   link home/ into ~/.claude (and remove the links of the retired modes, workflows and lead rule files and
//                          move, once, the stores of removed parts to the backup folder: scripts/install/retired-state.mjs), make personal/
//                          from personal.example/ when missing; on the layer's first install move the notes of home/project-notes git does not
//                          track (or deleted in a pull) into it; link ~/.claude/project-notes to personal/project-notes, write ~/.claude/CLAUDE.md (the marker line and
//                          @ imports of home/CLAUDE.md and personal/CLAUDE.md; scripts/install/personal.mjs), docs/catalog.md
//                          (git-ignored, from scripts/catalog.mjs; a problem there is only a warning), the claude-as
//                          start-up line, settings.json, plugins, tool dependencies; safe to repeat (a second run changes
//                          nothing). --update is the same run, by name. A repo path an @ import line cannot carry (a space,
//                          @, #, a quote, a non-ASCII letter) stops it with exit 1 before anything changes. It also unsets git's
//                          core.hooksPath when that is still the .githooks an earlier install set. settings.json is built from
//                          the machine's own earlier settings (first layer, new machine only), settings/base.json, <os>.json
//                          and local.json. Plugins: only those the merged settings turn on, and none is ever uninstalled. Tool
//                          dependencies: ui-check, env-names and long-run (TOOLS_WITH_DEPS), installed again only when the
//                          lockfile or the Node ABI changed: the stamp node_modules/.lock-sha256 is <sha256>:<ABI>.
//   --update --to <tag>    the same, with the links on a detached worktree of a phase tag, ~/.claude-setup-at/<tag> (rollback;
//                          the checkout does not move; scripts/install/pin.mjs); a plain --update points them back at this
//                          checkout.
//   --claude-version <v>   install Claude Code <v> (the phase pin, 2.1.326 or newer), run `claude --version` right after and put
//                          the old binary back when it is not <v> (scripts/install/cli.mjs)
//   --dry-run              print each change instead of making it, plus the git hooksPath it would unset and the settings layers it
//                          would merge; changes nothing (no file, no git config, no lock).
//   --uninstall            remove what the install record names, move the moved notes back and put the backed-up files back
//                          (scripts/install/uninstall.mjs); personal/ stays. It then lists what it left in place: a backup whose
//                          path exists again, a link or written file you changed, a folder that is not empty.
// Exports: LINKS, TOOLS_WITH_DEPS, main.
// Invariants: never deletes a file it did not make: anything replaced goes to ~/.claude-backup-<stamp>/ and is named in the
//   install record (~/.claude/.claude-setup-install.json, saved even when a step fails); settings are written after the plugin
//   installs, because `claude plugin install` re-enables plugins in settings.json and the merged repo settings must win; tool
//   dependencies come after settings, so a failed dependency install cannot leave settings.json stale; one install at a time
//   (a lock in ~/.claude from loading the record to saving it, also taken by --uninstall until its record is removed; a second run
//   exits 1 with a message, and a lock whose process still runs is never taken over).
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InstallError, makeContext, note, parseArgs, samePath, warn } from './install/context.mjs';
import { ensureDir, loadRecord, lockInstall, saveRecord } from './install/record.mjs';
import { linkHomeItems, removeRetiredLinks } from './install/links.mjs';
import { removeRetiredState } from './install/retired-state.mjs';
import { PERSONAL_ITEMS, checkImportPath, installPersonal } from './install/personal.mjs';
import { addStartupLines } from './install/startup.mjs';
import { buildSettings, isNewMachine } from './install/settings.mjs';
import { tagRoot } from './install/pin.mjs';
import { uninstall } from './install/uninstall.mjs';
import { requireGitBash } from './install/windows.mjs';
import { installClaude } from './install/cli.mjs';
import * as tools from './install/tools.mjs';
import { buildCatalog } from './catalog.mjs';

/**
 * The items the install makes in ~/.claude: links to home/<name>, except PERSONAL_ITEMS:
 * CLAUDE.md is a written file and project-notes links to personal/project-notes (scripts/install/personal.mjs).
 */
// lead.md and lead-rules.md left the list (plan 2026-11-24): removeRetiredLinks removes their recorded links on the next install.
export const LINKS = ['CLAUDE.md', 'rules', 'skills', 'agents', 'standards', 'hooks', 'tools', 'project-notes', 'statusline.mjs'];
// Tools with npm dependencies: ui-check (odiff-bin, pngjs), env-names (yaml) and long-run (LangGraph.js, its SQLite checkpointer with
// the native better-sqlite3, zod). scripts/lane-new.sh reads the list line below.
export const TOOLS_WITH_DEPS = ['ui-check', 'env-names', 'long-run'];

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const GIT_CONFIG_KEY_MISSING = 1; // `git config --get` exit when the key is not set (git-config(1))
const RETIRED_HOOKS_PATH = '.githooks'; // the commit-hook folder earlier installs set; the hooks were removed (guard-removal plan, 2026-11-25)

/**
 * Unsets the repo's core.hooksPath when an earlier install set it to .githooks, so git stops looking for the removed commit
 * hooks. Any other value is the owner's own and is only named. Reading the value changes nothing, so --dry-run reads it too.
 * @param {object} ctx the run context
 * @returns {void}
 */
function retireGitHooks(ctx) {
  const git = (...args) => spawnSync('git', ['-C', ctx.repo, 'config', '--local', ...args], { encoding: 'utf8' });
  const why = (run) => run.error?.message ?? (run.stderr.trim() || `exit ${run.status}`); // no git at all: error is set, stderr is null
  const current = git('--get', 'core.hooksPath');
  if (current.status === GIT_CONFIG_KEY_MISSING) return; // not set: nothing to undo
  if (current.status !== 0) {
    warn(`could not read git core.hooksPath (${why(current)}); check it with: git config --get core.hooksPath`);
    return;
  }
  const value = current.stdout.trim();
  if (value !== RETIRED_HOOKS_PATH) {
    note(ctx, `git hooksPath left as it is (${value}): not the one this setup set`);
    return;
  }
  if (ctx.dryRun) {
    console.log(`would unset: git config core.hooksPath (${RETIRED_HOOKS_PATH})`);
    return;
  }
  const unset = git('--unset', 'core.hooksPath');
  if (unset.status === 0) note(ctx, `git hooksPath unset (was ${RETIRED_HOOKS_PATH})`);
  else warn(`could not unset git core.hooksPath (${why(unset)}); run: git config --unset core.hooksPath`);
}

/**
 * Writes docs/catalog.md from the checkout's files (scripts/catalog.mjs): the catalog is git-ignored, so a checkout has it only
 * after an install. It is always this checkout's, also under --to <tag>, because a person reads it here. A problem the generator
 * names, or a file it cannot read, is a warning: the catalog is a document, and a broken one must not stop an install.
 * @param {object} ctx the run context
 * @returns {void}
 */
function writeCatalog(ctx) {
  if (ctx.dryRun) {
    console.log('would write docs/catalog.md');
    return;
  }
  const path = join(ctx.repo, 'docs', 'catalog.md');
  try {
    const { text, problems } = buildCatalog(ctx.repo);
    for (const problem of problems) warn(`catalog: ${problem} (fix it, then run: node scripts/catalog.mjs write)`);
    if (existsSync(path) && readFileSync(path, 'utf8') === text) return;
    writeFileSync(path, text);
    note(ctx, 'docs/catalog.md written');
  } catch (error) {
    warn(`docs/catalog.md not written: ${error.message}`);
  }
}

function install(ctx, record) {
  if (ctx.os === 'windows') requireGitBash(ctx);
  ctx.newMachine = isNewMachine(ctx, record);
  ensureDir(ctx, record, ctx.claudeDir);
  ctx.root = ctx.to ? tagRoot(ctx, record) : ctx.repo;
  checkImportPath(ctx.root); // a tag worktree lies under HOME, whose path may hold a space: refused before any link moves
  Object.assign(record, { repo: ctx.repo, root: ctx.root, tag: ctx.to ?? null });
  linkHomeItems(ctx, record, LINKS.filter((name) => !PERSONAL_ITEMS.includes(name)));
  writeCatalog(ctx);
  installPersonal(ctx, record);
  removeRetiredLinks(ctx, record, LINKS);
  removeRetiredState(ctx, record);
  addStartupLines(ctx, record);
  retireGitHooks(ctx);
  if (ctx.claudeVersion) installClaude(ctx); // before the plugin commands, which use the new CLI
  if (!ctx.noPlugins) tools.installPlugins(ctx);
  // Settings after plugins; tool dependencies after settings (header).
  buildSettings(ctx, record);
  if (!ctx.noTools) tools.installToolDeps(ctx, TOOLS_WITH_DEPS);
}

/**
 * Makes ~/.claude when missing (the lock lives there), takes the install lock, then loads the record. Folders this run made
 * go first in the record, where ensureDir would have put them, so --uninstall removes them last. --dry-run takes no lock.
 * @param {object} ctx the run context
 * @returns {{record: object, release: () => void}} the record and the lock's release
 * @throws {InstallError} when another install holds the lock, or the record is not one this installer wrote
 */
function lockAndLoad(ctx) {
  if (ctx.dryRun) return { record: loadRecord(ctx), release: () => {} };
  const firstMade = mkdirSync(ctx.claudeDir, { recursive: true }); // the top folder it made; undefined when ~/.claude was there
  const release = lockInstall(ctx);
  try {
    const record = loadRecord(ctx);
    if (firstMade) {
      const made = [ctx.claudeDir];
      while (!samePath(made[0], firstMade)) made.unshift(dirname(made[0]));
      record.made.unshift(...made.map((path) => ({ kind: 'dir', path })));
    }
    return { record, release };
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * Takes the install lock for --uninstall, so it never runs beside an install that runs (an install would back up again what
 * the uninstall just restored); the lock is never taken from a live holder, however old. No ~/.claude, or --dry-run: nothing to undo or change, no lock.
 * @param {object} ctx the run context
 * @returns {() => void} the lock's release
 * @throws {InstallError} when an install holds the lock
 */
function lockForUninstall(ctx) {
  if (ctx.dryRun || !existsSync(ctx.claudeDir)) return () => {};
  return lockInstall(ctx);
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
  let release;
  try {
    ctx = makeContext(parseArgs(argv), REPO, env);
    if (ctx.uninstall) {
      release = lockForUninstall(ctx);
      uninstall(ctx, release);
    } else {
      checkImportPath(ctx.repo); // before the lock and ~/.claude are made: a refused path changes nothing
      ({ record, release } = lockAndLoad(ctx));
      install(ctx, record);
    }
  } catch (error) {
    console.error(`FAILED: ${error instanceof InstallError ? error.message : error.stack}`);
    printSummary(ctx, console.error);
    return error instanceof InstallError ? error.exitCode : 1;
  } finally {
    try {
      if (ctx && record) saveRecord(ctx, record);
    } finally {
      release?.();
    }
  }
  if (ctx.dryRun) console.log('(dry-run: nothing changed)');
  printSummary(ctx, console.log);
  if (ctx.failures.length === 0) return 0;
  console.error(`FAILED plugin steps: ${ctx.failures.join(', ')}`);
  return 1;
}

// realpath: install.sh may name this file through a linked folder.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = main(process.argv.slice(2));
