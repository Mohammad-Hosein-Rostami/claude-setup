// Round 5 of the guard audit (final): find that deletes, the git top-level as project root, gh/commit text as data, heredoc readers,
// more hidden-execution triggers, "guard error" on an exception, secrets piped into --with-token / --password-stdin.
// Every repro of the final audit is a case here; the harmless commands must stay silent (a false positive costs an unattended run up to 3 minutes).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { riskyWordInExpansion } from '../home/hooks/lib/raw-risk.mjs';
import { decide, decideSafely } from '../home/hooks/pre-bash-guard.mjs';
import { hookEnv, tempLogPath } from './hook-env.mjs';
import { AUDIT_HARMLESS, HEREDOC_READER_ASKS, NOT_COVERED_STILL_ASK, RUNS_TEXT_ASKS } from './pre-bash-guard-final-cases.mjs';

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

const MESSAGE_STILL_SCANNED = [
  'git commit -m "fix $(git push --force origin main)"',
  'git commit -m "fix `git push --force origin main`"',
  "git commit -m \"$(cat <<'EOF'\nok\nEOF\n)$(git push --force origin main)\"",
  "git commit -m \"$(cat <<EOF\n$(git push --force origin main)\nEOF\n)\"",
  "git commit -m \"$(cat <<'EOF'\nok\nEOF\n)\" && git push --force origin main",
  "git commit -m \"$(cat <<'EOF'\nok\nEOF\n)\" && x=$(rm -rf /etc)",
  'gh pr create --title "x" --body "$(git push --force origin main)"',
  "gh pr create --title x --body \"$(cat <<'EOF'\nok\nEOF\n)\"; x=$(gh release create v1)",
  "gh issue comment 1 --body \"$(cat <<'EOF'\nok\nEOF\n | bash)\"",
  'git commit -m "unclosed $(git push --force origin main)',
  'gh pr merge 5 --body "ok"; echo $(date)',
  'echo "$(date)"; gh release create v1',
  'echo "$(date)"; gh -R o/r pr merge 5',
  'echo "$(date)"; gh repo delete o/r --yes',
];

const READER_DATA_SILENT = [
  "cat <<'EOF'\nrm -rf /\ngit push --force\nEOF",
  "sudo tee /etc/motd <<'EOF'\nrm -rf /\nEOF",
  "NAME=x cat > notes.md <<'EOF'\ngit push --force\nEOF",
  "git commit -F - <<'EOF'\nfix: rm -rf / and git push --force origin main\nEOF",
  "gh pr create --title x --body-file - <<'EOF'\nSee gh release and git push --force origin main\nEOF",
  "cat <<'EOF' | kubectl apply -f -\ngit push --force origin main\nEOF",
];

const READER_RUNS_ASKS = [
  "cat <<'EOF' | bash\ngit push --force origin main\nEOF",
  "cat <<'EOF' | sudo sh\nrm -rf /etc\nEOF",
  "cat <<'EOF' | ssh host\nrm -rf /etc\nEOF",
  "bash <<'EOF'\ngit push --force origin main\nEOF",
  "source /dev/stdin <<'EOF'\ngit push --force origin main\nEOF",
  "python3 - <<'EOF'\nimport os; os.system('git push --force origin main')\nEOF",
  "xargs rm -rf <<'EOF'\n/etc\nEOF",
  "crontab - <<'EOF'\n* * * * * rm -rf /etc\nEOF",
];

test('commit and PR message text is data (the auditor cases stay silent, 80+ harmless commands in all)', () => {
  assert.ok(AUDIT_HARMLESS.length >= 80);
  for (const command of AUDIT_HARMLESS) assert.deepEqual(decide(command, ctx), { allow: true }, `should allow: ${JSON.stringify(command)}`);
});

test('a message with another expansion, or a command after it, still asks', () => {
  for (const command of MESSAGE_STILL_SCANNED) assert.equal(decide(command, ctx).ask, true, `should ask: ${JSON.stringify(command)}`);
});

test('a heredoc read by cat, tee, git commit -F - or gh --body-file - is data', () => {
  for (const command of READER_DATA_SILENT) assert.deepEqual(decide(command, ctx), { allow: true }, `should allow: ${JSON.stringify(command)}`);
});

test('a heredoc read by anything else is scanned for dangerous words', () => {
  for (const command of READER_RUNS_ASKS) assert.equal(decide(command, ctx).ask, true, `should ask: ${JSON.stringify(command)}`);
  for (const command of HEREDOC_READER_ASKS) assert.equal(decide(command, ctx).ask, true, `should ask: ${JSON.stringify(command)}`);
});

test('commands that run a text argument count as hidden execution', () => {
  assert.ok(RUNS_TEXT_ASKS.length >= 20);
  for (const command of RUNS_TEXT_ASKS) assert.equal(decide(command, ctx).ask, true, `should ask: ${JSON.stringify(command)}`);
  assert.equal(riskyWordInExpansion("watch -n1 'git push --force origin main'"), 'risky word inside shell expansion');
  assert.equal(riskyWordInExpansion("PROMPT_COMMAND='git push --force origin main' bash -i"), 'risky word inside shell expansion');
  assert.equal(riskyWordInExpansion('node -p "1+1"'), undefined);
  assert.equal(riskyWordInExpansion('pnpm test --watch'), undefined);
});

test('gh is judged by position: the words of a title or body are not a subcommand', () => {
  assert.equal(riskyWordInExpansion('x=$(date); gh pr create --title "fix: delete stale release" --body "merge archive"'), undefined);
  assert.equal(riskyWordInExpansion('x=$(date); gh issue comment 3 --body "gh release soon"'), undefined);
  assert.ok(riskyWordInExpansion('x=$(date); gh release create v1'));
  assert.ok(riskyWordInExpansion('x=$(date); gh pr merge 3'));
  assert.ok(riskyWordInExpansion('x=$(date); gh api -X DELETE repos/o/r'));
});

test('the still-asking rm paths are reported, not silenced', () => {
  for (const command of NOT_COVERED_STILL_ASK) assert.match(decide(command, ctx).reason, DESTRUCTIVE, command);
});

// ---- L2: an exception inside the rules asks "guard error" instead of allowing silently ----
const GUARD = resolve('home/hooks/pre-bash-guard.mjs');

test('decideSafely: a throwing rule set asks with the reason "guard error" and the error class', () => {
  const throwing = () => {
    throw new RangeError('boom');
  };
  assert.deepEqual(decideSafely('pnpm test', ctx, throwing), { allow: false, ask: true, reason: 'guard error', errorClass: 'RangeError' });
  assert.equal(decideSafely('pnpm test', ctx, () => {
    throw 'not an error object';
  }).errorClass, 'string');
  assert.deepEqual(decideSafely('pnpm test', ctx), { allow: true });
});

test('the hook with a throwing lib asks "guard error", logs the error class and never the command text', () => {
  const copy = mkdtempSync(join(tmpdir(), 'guard-copy-'));
  cpSync(resolve('home/hooks'), join(copy, 'hooks'), { recursive: true });
  writeFileSync(join(copy, 'hooks/lib/raw-risk.mjs'), "export const RISKY_REASON = 'x';\nexport function riskyWordInExpansion() { throw new TypeError('injected'); }\n"
    + 'export const unreadableNameReasons = () => [];\n'); // the stub keeps every export the guard imports, so only the throw differs
  const log = tempLogPath();
  const command = 'echo sentinel-command-text';
  const run = spawnSync(process.execPath, [join(copy, 'hooks/pre-bash-guard.mjs')], {
    input: JSON.stringify({ cwd: PROJECT, session_id: 's1', tool_input: { command } }),
    encoding: 'utf8',
    env: hookEnv({ CLAUDE_GUARD_LOG: log, CLAUDE_PROJECT_DIR: PROJECT }),
  });
  const output = JSON.parse(run.stdout).hookSpecificOutput;
  assert.equal(output.permissionDecision, 'ask');
  assert.match(output.permissionDecisionReason, /^guard error: TypeError/);
  const logged = readFileSync(log, 'utf8');
  assert.match(logged, /guard error: TypeError/);
  assert.equal(logged.includes('sentinel-command-text'), false);
});
