// Purpose: the rollback of PLAN section 3: `install --update --to <tag>` points the install at a phase tag (`r9-phase-N`)
//   without moving the repo checkout or rewriting main; a plain `install --update` points it back at the checkout.
// Exports: tagRoot.
// Invariants: the tag gets its own detached worktree, ~/.claude-setup-at/<tag>, made once and recorded (--uninstall removes it);
//   the checkout, its branch and the live home/ of a session that is not re-linked stay as they are. Because ~/.claude's links
//   move to the worktree, every running session reads the tag's home/ from its next file read on (that is the rollback).
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { InstallError, act, note } from './context.mjs';
import { ensureDir, remember } from './record.mjs';

const git = (args) => spawnSync('git', args, { encoding: 'utf8' });

/**
 * The worktree of `tag`, made when missing.
 * @param {object} ctx the run context (repo, home, to)
 * @param {object} record the install record
 * @returns {string} the worktree folder, the new root of the links
 * @throws {InstallError} exit 2 for an unknown tag; 1 when the folder holds another commit or git fails
 */
export function tagRoot(ctx, record) {
  const tag = ctx.to;
  const wanted = git(['-C', ctx.repo, 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]);
  if (wanted.status !== 0) throw new InstallError(`no tag ${tag} in ${ctx.repo} (git tag -l lists them)`, 2);
  const sha = wanted.stdout.trim();
  const dir = join(ctx.home, '.claude-setup-at', tag);
  if (existsSync(dir)) {
    const head = git(['-C', dir, 'rev-parse', 'HEAD']).stdout.trim();
    if (head !== sha) throw new InstallError(`${dir} is at ${head || 'no commit'}, not ${tag} (${sha}); remove it with git worktree remove and run again`);
    note(ctx, `ok worktree of ${tag} at ${dir}`);
    return dir;
  }
  ensureDir(ctx, record, join(ctx.home, '.claude-setup-at'));
  act(ctx, `git worktree add --detach ${dir} ${tag}`, () => {
    const added = git(['-C', ctx.repo, 'worktree', 'add', '--detach', dir, sha]);
    if (added.status !== 0) throw new InstallError(`git worktree add for ${tag} failed: ${added.stderr.trim()}`);
    remember(record, { kind: 'worktree', path: dir, repo: ctx.repo });
    note(ctx, `made a worktree of ${tag} at ${dir}`);
  });
  return dir;
}
