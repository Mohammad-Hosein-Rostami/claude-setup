// Tests for the shell snippet home/shell/claude-as.sh, each under /bin/bash (3.2 on macOS) and zsh: `claude-as <name>`
// sets the token and the account name in that shell only, with `set -x` on in the caller nothing of the token reaches
// stderr, the token is handled with shell builtins only (trap programs named like printf, echo and cat sit first on
// PATH and log their arguments), a token-shaped argument is refused, the paste is read hidden from the terminal (a
// pseudo-terminal from `script`) and never without one, `--once` stores nothing, `--off` clears, the menu refuses Enter.
// The store is the 0600 file store under a temp HOME; K10: after each test the token is only in the store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addAccount, setDefault } from '../home/tools/account/lib/accounts.mjs';
import { fileStore } from '../home/tools/account/lib/file-store.mjs';
import { readRegistry } from '../home/tools/account/lib/registry.mjs';
import { PTY_PLATFORM, SHELLS, accountSandbox, assertNoLeak, fakeToken, filesHolding, runInPty, tokenHash } from './account-helpers.mjs';

const SNIPPET = fileURLToPath(new URL('../home/shell/claude-as.sh', import.meta.url));
const TOKEN_A = fakeToken('ShellA');
const TOKEN_B = fakeToken('ShellB');
const TRAPPED = ['printf', 'echo', 'cat', 'tee', 'sed', 'tr', 'awk', 'grep', 'head', 'cut', 'xargs'];
const PROMPT = 'Paste the token for';
const SHOW_ENV = 'node "$ENV_PRINT"';

/** A sandbox with trap programs first on PATH: each logs its arguments, then runs the real program. */
function sandbox(t, options) {
  const box = accountSandbox(options);
  const traps = join(box.dir, 'traps');
  mkdirSync(traps);
  for (const name of TRAPPED) {
    const real = ['/usr/bin', '/bin'].map((dir) => join(dir, name)).find((path) => existsSync(path));
    writeFileSync(join(traps, name), `#!/bin/sh\necho "${name} $*" >> "$TRAP_LOG"\n${real ? `exec ${real} "$@"` : 'exit 127'}\n`);
    chmodSync(join(traps, name), 0o755);
  }
  box.trapLog = join(box.dir, 'trap.log');
  box.env = { ...box.env, PATH: `${traps}${delimiter}${box.env.PATH}`, TRAP_LOG: box.trapLog, SNIPPET, ENV_PRINT: box.envPrint };
  box.store = fileStore(box.storeDir);
  t.after(() => assertNoLeak(box, [TOKEN_A, TOKEN_B]));
  return box;
}

const stored = (box, name, token) => addAccount(name, token, { env: box.env, store: box.store });
const run = (shell, flags, box, text, env = {}) => spawnSync(shell, [...flags, '-c', text], { env: { ...box.env, ...env }, input: '', encoding: 'utf8' });
const pty = (shell, flags, box, text, steps) => runInPty([shell, ...flags, '-c', text], { env: box.env, steps });
const envLine = (output) => output.match(/ENV (\S+) (\S+)/)?.slice(1) ?? null;

for (const [label, shell, flags] of SHELLS) {
  test(`${label}: claude-as <name> sets the stored token and the name in this shell; with set -x on, stderr holds no token and the trace is on again afterwards`, (t) => {
    const box = sandbox(t);
    stored(box, 'work', TOKEN_A);
    const result = run(shell, flags, box, `. "$SNIPPET"\nset -x\nclaude-as work\nrc=$?\n: marker-after-$rc\nset +x\n${SHOW_ENV}`);
    assert.deepEqual(envLine(result.stdout), [tokenHash(TOKEN_A), 'work'], result.stderr);
    assert.ok(!result.stderr.includes(TOKEN_A) && !result.stdout.includes(TOKEN_A), 'no token on stdout or in the trace');
    assert.match(result.stderr, /marker-after-0/, 'the caller keeps its set -x');
    assert.match(result.stdout, /this terminal now uses account work/);
    assert.ok(!existsSync(box.trapLog) || !readFileSync(box.trapLog, 'utf8').includes(TOKEN_A), 'no program got the token as an argument');
  });

  test(`${label}: a token-shaped argument is refused with a message that names no part of it and says how to clear the history`, (t) => {
    const box = sandbox(t);
    stored(box, 'work', TOKEN_A);
    for (const args of [TOKEN_B, `work ${TOKEN_B}`, `--once ${TOKEN_B}`, `"export CLAUDE_CODE_OAUTH_TOKEN=${TOKEN_B}"`]) {
      const result = run(shell, flags, box, `. "$SNIPPET"\nclaude-as ${args}\necho "RC=$?"\n${SHOW_ENV}`);
      assert.match(result.stdout, /RC=1/);
      assert.deepEqual(envLine(result.stdout), ['none', 'none'], 'nothing was set');
      assert.ok(!`${result.stdout}${result.stderr}`.includes('MadeUp'));
      assert.match(result.stderr, /history/);
      assert.match(result.stderr, /claude-as <name>/);
    }
    assert.deepEqual(box.claudeCalls(), []);
  });

  test(`${label}: with no terminal on stdin (the Bash tool, a pipe, \`!\`) a new name is not prompted for, and --once neither`, (t) => {
    const box = sandbox(t);
    for (const args of ['fresh', '--once']) {
      const result = run(shell, flags, box, `. "$SNIPPET"\nclaude-as ${args}\necho "RC=$?"\n${SHOW_ENV}`);
      assert.match(result.stdout, /RC=1/);
      assert.match(result.stderr, /normal terminal/);
      assert.ok(!result.stdout.includes(PROMPT) && !result.stderr.includes(PROMPT));
      assert.deepEqual(envLine(result.stdout), ['none', 'none']);
    }
    assert.deepEqual(readRegistry(box.env).accounts, {});
  });

  test(`${label}: a hostile name is refused by the tool, and a session of Claude (CLAUDECODE set) gets no token`, (t) => {
    const box = sandbox(t);
    stored(box, 'work', TOKEN_A);
    for (const name of ["'../x'", "'a\"b'", "'A B'"]) {
      const result = run(shell, flags, box, `. "$SNIPPET"\nclaude-as ${name}\necho "RC=$?"\n${SHOW_ENV}`);
      assert.match(result.stdout, /RC=1/);
      assert.deepEqual(envLine(result.stdout), ['none', 'none']);
    }
    const inClaude = run(shell, flags, box, `. "$SNIPPET"\nclaude-as work\necho "RC=$?"\n${SHOW_ENV}`, { CLAUDECODE: '1' });
    assert.match(inClaude.stdout, /RC=1/);
    assert.deepEqual(envLine(inClaude.stdout), ['none', 'none']);
  });

  test(`${label}: claude-as --off clears the token and the name; claude-account passes its arguments to the tool`, (t) => {
    const box = sandbox(t);
    stored(box, 'work', TOKEN_A);
    const result = run(shell, flags, box, `. "$SNIPPET"\nclaude-as work >/dev/null\nclaude-as --off\n${SHOW_ENV}\nclaude-account names`);
    assert.deepEqual(envLine(result.stdout), ['none', 'none']);
    assert.match(result.stdout, /this terminal has no account/);
    assert.match(result.stdout, /^work$/m);
  });

  test(`${label}: a new terminal loads the default account when one is set, else prints one line saying how to pick`, (t) => {
    const box = sandbox(t);
    stored(box, 'work', TOKEN_A);
    const none = run(shell, flags, box, `. "$SNIPPET"\n_claude_as_startup\n${SHOW_ENV}`);
    assert.match(none.stdout, /pick an account: claude-as <name>/);
    assert.deepEqual(envLine(none.stdout), ['none', 'none']);
    setDefault('work', { env: box.env });
    const loaded = run(shell, flags, box, `. "$SNIPPET"\nset -x\n_claude_as_startup\nset +x\n${SHOW_ENV}`);
    assert.deepEqual(envLine(loaded.stdout), [tokenHash(TOKEN_A), 'work']);
    assert.ok(!loaded.stderr.includes(TOKEN_A));
    const kept = run(shell, flags, box, `. "$SNIPPET"\n_claude_as_startup\n${SHOW_ENV}`, { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_B, CLAUDE_ACCOUNT: '-' });
    assert.deepEqual(envLine(kept.stdout), [tokenHash(TOKEN_B), '-'], 'a shell that already has a token keeps it');
  });

  if (PTY_PLATFORM) {
    test(`${label}: a new name asks for the token with hidden input read from the terminal, takes the pasted export line, checks, stores and sets it`, async (t) => {
      const box = sandbox(t);
      const result = await pty(shell, flags, box, `. "$SNIPPET"\nset -x\nclaude-as fresh\nset +x\n${SHOW_ENV}`, [{ wait: PROMPT, send: `export CLAUDE_CODE_OAUTH_TOKEN="${TOKEN_A}"\n` }]);
      assert.ok(!result.output.includes(TOKEN_A), 'the paste is not echoed, and the trace does not show it');
      assert.deepEqual(envLine(result.output), [tokenHash(TOKEN_A), 'fresh'], result.output.slice(-600));
      assert.deepEqual(filesHolding(box.dir, TOKEN_A), [join(box.storeDir, 'fresh.token')]);
      assert.equal(box.claudeCalls()[0].tokenHash, tokenHash(TOKEN_A));
      assert.ok(!existsSync(box.trapLog) || !readFileSync(box.trapLog, 'utf8').includes(TOKEN_A), 'no program got the token as an argument');
    });

    test(`${label}: a revoked token pasted for a new name is refused: nothing stored, nothing set`, async (t) => {
      const box = sandbox(t, { claudeMode: 'revoked' });
      const result = await pty(shell, flags, box, `. "$SNIPPET"\nclaude-as fresh\necho "RC=$?"\n${SHOW_ENV}`, [{ wait: PROMPT, send: `${TOKEN_A}\n` }]);
      assert.match(result.output, /RC=1/);
      assert.match(result.output, /revoked/);
      assert.deepEqual(envLine(result.output), ['none', 'none']);
      assert.deepEqual(filesHolding(box.dir, TOKEN_A), []);
    });

    test(`${label}: claude-as --once sets a pasted token for this shell with the reserved name - and stores nothing`, async (t) => {
      const box = sandbox(t);
      const result = await pty(shell, flags, box, `. "$SNIPPET"\nset -x\nclaude-as --once\nset +x\n${SHOW_ENV}`, [{ wait: PROMPT, send: `${TOKEN_B}\n` }]);
      assert.ok(!result.output.includes(TOKEN_B));
      assert.deepEqual(envLine(result.output), [tokenHash(TOKEN_B), '-'], result.output.slice(-600));
      assert.deepEqual(filesHolding(box.dir, TOKEN_B), [], 'the token is in no file at all');
      assert.deepEqual(readRegistry(box.env).accounts, {});
    });

    test(`${label}: claude-as with no name shows a numbered list; a number picks that account, Enter alone picks nothing`, async (t) => {
      const box = sandbox(t);
      stored(box, 'work', TOKEN_A);
      stored(box, 'home', TOKEN_B);
      const picked = await pty(shell, flags, box, `. "$SNIPPET"\nclaude-as\n${SHOW_ENV}`, [{ wait: 'Number:', send: '2\n' }]);
      assert.match(picked.output, /1\) home[\s\S]*2\) work/);
      assert.deepEqual(envLine(picked.output), [tokenHash(TOKEN_A), 'work']);
      for (const answer of ['\n', '7\n', 'work\n']) {
        const refused = await pty(shell, flags, box, `. "$SNIPPET"\nclaude-as\necho "RC=$?"\n${SHOW_ENV}`, [{ wait: 'Number:', send: answer }]);
        assert.match(refused.output, /RC=1/);
        assert.deepEqual(envLine(refused.output), ['none', 'none'], 'Enter or a wrong answer never picks an account');
      }
    });
  }
}

test('the snippet handles the token with builtins only: every line that expands the token or the paste starts with a builtin', () => {
  const lines = readFileSync(SNIPPET, 'utf8').split('\n').filter((line) => /\$\{?(_claude_as_token|_claude_as_paste)\b/.test(line));
  assert.ok(lines.length >= 3, 'the lines that touch the token were found');
  for (const line of lines) assert.match(line.trim(), /^(builtin printf|_claude_as_token=\$\(builtin printf|export CLAUDE_CODE_OAUTH_TOKEN=|if \[ -n )/, line.trim().slice(0, 60));
});
