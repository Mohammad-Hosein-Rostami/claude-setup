// Round 5 of the guard audit (final): find that deletes, the git top-level as project root, gh/commit text as data, heredoc readers,
// more hidden-execution triggers, "guard error" on an exception, secrets piped into --with-token / --password-stdin.
// Every repro of the final audit is a case here; the harmless commands must stay silent (a false positive costs an unattended run up to 3 minutes).
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { decide } from '../home/hooks/pre-bash-guard.mjs';

const PROJECT = resolve('/work/proj');
const ctx = { cwd: PROJECT, project: PROJECT, prodHosts: [] };
const DESTRUCTIVE = /^DESTRUCTIVE: /;

const FIND_ASKS = [
  'find ~ -name "*.tmp" -exec rm -rf {} +',
  'find $HOME -name "*.tmp" -exec rm -rf {} +',
  'find /Users/x -type d -name node_modules -prune -exec rm -rf {} +',
  'find /var/log -name "*.log" -delete',
  'find .. -name "*.tmp" -delete',
  'find "$UNKNOWN" -name "*.tmp" -exec rm -r {} \;',
  'find ~ -name x -execdir rm -fr {} +',
  'find -L /etc -name x -exec rm -rf {} +',
];

const FIND_SILENT = [
  'find . -name node_modules -prune -exec rm -rf {} +',
  'find src -name "*.tmp" -delete',
  'find . -name "*.tmp" -exec rm -f {} +',
  'find ~ -name "*.tmp"',
  'find /var/log -name "*.log" -exec ls -l {} +',
  'find ~ -name "*.tmp" -exec rm {} +',
  `find ${PROJECT}/dist -type f -delete`,
  'find /tmp/x -name "*.tmp" -exec rm -rf {} +',
];

for (const command of FIND_ASKS) {
  test(`find that deletes outside the project asks: ${command}`, () => {
    const r = decide(command, ctx);
    assert.equal(r.ask, true, command);
    assert.match(r.reason, DESTRUCTIVE);
  });
}
for (const command of FIND_SILENT) {
  test(`find inside the project or without deleting stays silent: ${command}`, () => {
    assert.equal(decide(command, ctx).allow, true, command);
  });
}

test('the git top-level counts as the project root from inside the project', () => {
  assert.equal(decide('rm -rf "$(git rev-parse --show-toplevel)/dist"', ctx).allow, true);
  assert.equal(decide('rm -rf `git rev-parse --show-toplevel`/dist', ctx).allow, true);
  assert.equal(decide('rm -rf "$(git rev-parse --show-toplevel)/dist"', { ...ctx, cwd: `${PROJECT}/packages/a` }).allow, true);
});

test('the git top-level is unknown from outside the project, and ../ leaves it', () => {
  assert.equal(decide('rm -rf "$(git rev-parse --show-toplevel)/dist"', { ...ctx, cwd: resolve('/elsewhere') }).ask, true);
  assert.equal(decide('rm -rf "$(git rev-parse --show-toplevel)/../x"', ctx).ask, true);
  assert.equal(decide('rm -rf "$(git rev-parse --show-toplevel)"', ctx).ask, true);
});
