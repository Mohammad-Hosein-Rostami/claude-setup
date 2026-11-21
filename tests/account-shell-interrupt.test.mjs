// Tests for the hidden prompt of home/shell/claude-as.sh in an interactive /bin/bash 3.2 and zsh on a pseudo-terminal
// (review 1: R1, S3, S4, H7, H9): Ctrl-C at the prompt ends the call and leaves echo on, and the line typed next is a
// shell command, not the paste; Ctrl-C during the check stores nothing and leaves no shell variable holding the paste;
// a normal paste leaves echo on and no such variable. The store is the 0600 file store under a temp HOME; K10: after
// each test the token is only in the store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readRegistry } from '../home/tools/account/lib/registry.mjs';
import { PTY_PLATFORM, SHELLS, accountSandbox, assertNoLeak, fakeToken, filesHolding, runInPty } from './account-helpers.mjs';

const SNIPPET = fileURLToPath(new URL('../home/shell/claude-as.sh', import.meta.url));
const TOKEN = fakeToken('Interrupt');
const PROMPT = 'Paste the token for';
const READY = 'READY> ';
const CTRL_C = '\x03';
const INTERACTIVE = { bash: ['--norc', '--noprofile', '-i'], zsh: ['-f', '-i'] };
// Typed first: a prompt the steps can wait for (put together by the shell, so the echoed line never matches it), then the call.
const START = `PS1='RE''ADY> '; . "$SNIPPET"; claude-as fresh\n`;
// Typed after the call: its exit code, whether a variable still holds the paste or the token, the echo state; then leave.
// The marker is put together by printf, so the typed line itself (echoed by the terminal) never matches it.
const REPORT = `rc=$?; case "$(stty -a < /dev/tty)" in *' -echo '*) e=off ;; *) e=on ;; esac; printf 'S%sE rc=%s paste=%s token=%s echo=%s\\n' TAT "$rc" "\${_claude_as_paste+set}" "\${CLAUDE_CODE_OAUTH_TOKEN:+set}" "$e"; exit\n`;
const state = (output) => output.match(/STATE rc=(\d+) paste=(\w*) token=(\w*) echo=(\w+)/)?.slice(1) ?? null;

function sandbox(t, options) {
  const box = accountSandbox(options);
  box.env = { ...box.env, SNIPPET, BASH_SILENCE_DEPRECATION_WARNING: '1' };
  t.after(() => assertNoLeak(box, [TOKEN]));
  return box;
}

const session = (shell, label, box, steps) => runInPty([shell, ...INTERACTIVE[label]], { env: box.env, steps: [{ wait: '', send: START }, ...steps, { wait: READY, send: REPORT }] });

function assertNothingStored(box) {
  assert.deepEqual(readRegistry(box.env).accounts, {});
  assert.deepEqual(filesHolding(box.dir, TOKEN), []);
}

if (PTY_PLATFORM) {
  for (const [label, shell] of SHELLS) {
    test(`${label}: Ctrl-C at the hidden prompt ends the call with echo on; the next line is a command, not the paste`, async (t) => {
      const box = sandbox(t);
      const result = await session(shell, label, box, [{ wait: PROMPT, send: CTRL_C }]);
      const [rc, paste, token, echo] = state(result.output) ?? [];
      assert.notEqual(rc, undefined, result.output.slice(-600));
      assert.notEqual(rc, '0', 'the call failed');
      assert.deepEqual([paste, token, echo], ['', '', 'on'], result.output.slice(-600));
      assert.doesNotMatch(result.output, /that is not a token/, 'the typed command was not taken as the paste');
      assertNothingStored(box);
      assert.deepEqual(box.claudeCalls(), [], 'no check was started');
    });

    test(`${label}: Ctrl-C during the check stores nothing, sets nothing and leaves no variable holding the paste`, async (t) => {
      const box = sandbox(t, { claudeMode: 'slow' });
      const result = await session(shell, label, box, [{ wait: PROMPT, send: `${TOKEN}\n` }, { wait: 'CHECK-STARTED', send: CTRL_C }]);
      const [rc, paste, token, echo] = state(result.output) ?? [];
      assert.notEqual(rc, '0', result.output.slice(-600));
      assert.deepEqual([paste, token, echo], ['', '', 'on'], result.output.slice(-600));
      assert.ok(!result.output.includes(TOKEN), 'the paste was never shown');
      assertNothingStored(box);
    });

    test(`${label}: after a normal paste echo is on again and no shell variable holds the paste`, async (t) => {
      const box = sandbox(t);
      const result = await session(shell, label, box, [{ wait: PROMPT, send: `${TOKEN}\n` }]);
      assert.deepEqual(state(result.output), ['0', '', 'set', 'on'], result.output.slice(-600));
      assert.ok(!result.output.includes(TOKEN), 'the paste was never shown');
    });
  }
}
