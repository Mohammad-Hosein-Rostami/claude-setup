// A fake `claude` for the long-run tests (not a test file): it replays scripted outcomes per step and records every call.
// Exports: FAKE_CLAUDE_SOURCE, installFakeClaude(bin) -> path.
// Script: $FAKE_LR_DIR/script.json maps a step id (LONG_RUN_STEP) to a list of modes, one per call (the last repeats; no entry:
// `done`). Modes: done, say:<text>, echo (replies with the last line of its stdin), blocked, needs-owner, no-verdict, crash, limit,
// weekly-limit, auth, max-turns, no-conversation, leak, sleep:<ms>, hang, deaf (ignores SIGINT and SIGTERM), tool:<ms> (a tool call
// and its result, then `done` after <ms>). Every call appends one JSON line to $FAKE_LR_DIR/calls.jsonl: {step, mode, args, stdin, cwd,
// envNames, account, tokenHash, pid, start, end, ended} (`end` and `ended` on a second line kind `end`), never the token itself;
// each session writes its transcript to $CLAUDE_CONFIG_DIR/projects/fake-project/<session id>.jsonl (the open-session check).
// The stream is real `--output-format stream-json` shapes: a system init line, assistant lines, user tool_result lines, a result line.
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FAKE_CLAUDE_SOURCE = `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const dir = process.env.FAKE_LR_DIR;
const step = process.env.LONG_RUN_STEP ?? 'none';
const args = process.argv.slice(2);
const flagAt = args.includes('--session-id') ? args.indexOf('--session-id') : args.indexOf('--resume');
const sessionId = args[flagAt + 1];
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const script = existsSync(join(dir, 'script.json')) ? JSON.parse(readFileSync(join(dir, 'script.json'), 'utf8')) : {};
const counter = join(dir, 'count-' + step);
const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
writeFileSync(counter, String(n + 1));
const modes = script[step] ?? ['done'];
const mode = modes[Math.min(n, modes.length - 1)];
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '';
const record = (extra) => appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ step, sessionId, pid: process.pid, ...extra }) + '\\n');
record({ kind: 'start', mode, args, stdin, cwd: process.cwd(), envNames: Object.keys(process.env).sort(), account: process.env.CLAUDE_ACCOUNT ?? null,
  tokenHash: token ? createHash('sha256').update(token).digest('hex') : null, start: Date.now() });
const transcriptDir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'fake-project');
mkdirSync(transcriptDir, { recursive: true });
appendFileSync(join(transcriptDir, sessionId + '.jsonl'), JSON.stringify({ step, n }) + '\\n');
const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
const usage = { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 };
const finish = (code, ended = 'exit') => { record({ kind: 'end', end: Date.now(), ended }); process.exit(code); };
const result = (text, extra = {}) => out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId, usage, total_cost_usd: 0.01, ...extra });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
process.on('SIGINT', () => { if (mode !== 'deaf') finish(130, 'SIGINT'); });
process.on('SIGTERM', () => { if (mode !== 'deaf') finish(143, 'SIGTERM'); });
out({ type: 'system', subtype: 'init', session_id: sessionId, model: args[args.indexOf('--model') + 1] });
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on ' + step + '.' }] } });
const [name, value] = [mode.split(':')[0], mode.slice(mode.indexOf(':') + 1)];
if (name === 'done') { result('Did ' + step + '.\\nSTEP-RESULT: done'); finish(0); }
if (name === 'say') { result(value + '\\nSTEP-RESULT: done'); finish(0); }
if (name === 'echo') { result('You said: ' + stdin.trim().split('\\n').at(-1) + '\\nSTEP-RESULT: done'); finish(0); }
if (name === 'blocked') { result('Stuck.\\nSTEP-RESULT: blocked: the API key is missing'); finish(0); }
if (name === 'needs-owner') { result('Half done.\\nSTEP-RESULT: needs-owner: Which colour should the button be?'); finish(0); }
if (name === 'no-verdict') { result('I forgot the verdict line.'); finish(0); }
if (name === 'crash') { process.stderr.write('boom\\n'); finish(1); }
if (name === 'limit') { result("You've hit your session limit · resets 3:45pm", { is_error: true }); finish(1); }
if (name === 'weekly-limit') { result("You've hit your weekly limit · resets Mon 12:00am", { is_error: true }); finish(1); }
if (name === 'auth') { result('Failed to authenticate. API Error: 401 OAuth token has been revoked.', { is_error: true }); finish(1); }
if (name === 'max-turns') { out({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['max turns'], session_id: sessionId, usage }); finish(1); }
if (name === 'no-conversation') { process.stderr.write('No conversation found with session ID: ' + sessionId + '\\n'); finish(1); }
if (name === 'leak') {
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'my token is ' + token }] } });
  process.stderr.write('debug token ' + token + '\\n');
  result('Done.\\nSTEP-RESULT: done');
  finish(0);
}
if (name === 'sleep') { await sleep(Number(value)); result('Slept.\\nSTEP-RESULT: done'); finish(0); }
if (name === 'tool') {
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } });
  await sleep(Number(value));
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
  await sleep(Number(value));
  result('Tooled.\\nSTEP-RESULT: done');
  finish(0);
}
if (name === 'hang' || name === 'deaf') { for (;;) await sleep(1000); }
process.stderr.write('unknown fake mode ' + mode + '\\n');
finish(2);
`;

/** Writes the fake as `<bin>/claude` (and a `claude.cmd` shim for Windows). @returns {string} the fake's path. */
export function installFakeClaude(bin) {
  const path = join(bin, 'claude');
  writeFileSync(path, FAKE_CLAUDE_SOURCE);
  chmodSync(path, 0o755);
  writeFileSync(join(bin, 'claude.cmd'), '@node "%~dp0claude" %*\r\n');
  return path;
}
