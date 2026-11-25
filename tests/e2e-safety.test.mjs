// Tests of the e2e harness's safety parts (owner rules for Lane C): claudeArgs is the one argv builder and refuses a missing or
// non-subscription model; the redactor masks every token shape in printed lines, results.json and child logs; the child env
// drops API keys and refuses a scenario that sets one; cleanup removes only a root this run made; a usage limit gives exit 3;
// the settings copy moves the real ~/.claude paths to the temp HOME; `--real-home` gives the real HOME to a scenario that
// needs it (E9) and to no other, and E11's real guard log line is NOT RUN then. No real `claude` runs.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanEnv } from './clean-env.mjs';
import { madeUpToken } from './e2e-fixtures.mjs';
import { childEnv, LOGIN_ENV, REMOVED_ENV } from './e2e/lib/env.mjs';
import { loginRefusal } from './e2e/lib/login.mjs';
import { makeContext, makeRunState } from './e2e/lib/context.mjs';
import { claudeMdCopy, homePaths, settingsCopy } from './e2e/lib/home.mjs';
import { ALLOWED_MODELS, claudeArgs, modelOfArgs } from './e2e/lib/models.mjs';
import { ProcessRegistry } from './e2e/lib/processes.mjs';
import { redact, REDACTED, redactJson } from './e2e/lib/redact.mjs';
import { EXIT, exitCodeOf, formatLine, notRunLine, writeResults } from './e2e/lib/report.mjs';
import { assertInside, makeRunRoot, MARKER_FILE, removeProjectFolders, removeRunRoot, RUN_PREFIX } from './e2e/lib/scratch.mjs';
import { runDetached } from './e2e/lib/spawn.mjs';
import { limitOf, resetText } from './e2e/lib/stream.mjs';
import { projectKey } from './e2e/lib/transcripts.mjs';
import * as E9 from './e2e/scenarios/E9.mjs';
import * as E11 from './e2e/scenarios/E11.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const PROMPT = 'Reply ok.';
const RESETS_AT_S = 1_795_000_000; // a reset time in the stream's epoch seconds
const PASS_LINE = { check: 'c', expected: 'e', observed: 'o', pass: true };
const FAIL_LINE = { ...PASS_LINE, pass: false };
const LOGIN_VALUE = 'made-up-login-value-0000'; // not sk-ant- shaped: only the value mask can catch it
const SPEC = { home: '/h', tmp: '/t', path: '/bin', quietLog: '/q', longRunState: '/l' };

/** Runs `body` with the runner env names set (undefined: unset), then puts the old values back. */
function withRunnerEnv(values, body) {
  const kept = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  const put = (entries) => { for (const [name, value] of Object.entries(entries)) if (value === undefined) delete process.env[name]; else process.env[name] = value; };
  try {
    put(values);
    return body();
  } finally {
    put(kept);
  }
}

test('claudeArgs: an allowed model gives exactly one --model; no model, Fable or a run-time alias throws', () => {
  for (const model of ALLOWED_MODELS) assert.equal(modelOfArgs(claudeArgs({ prompt: PROMPT, model })), model);
  assert.deepEqual(claudeArgs({ prompt: PROMPT, model: 'opus' }).slice(0, 4), ['-p', PROMPT, '--model', 'opus']);
  assert.throws(() => claudeArgs({ prompt: PROMPT }), /must name --model/);
  assert.throws(() => claudeArgs({ prompt: PROMPT, model: '' }), /must name --model/);
  for (const model of ['fable', 'claude-fable-5-2', 'best', 'default', 'opusplan', 'haiku']) {
    assert.throws(() => claudeArgs({ prompt: PROMPT, model }), /is not allowed/, model);
  }
  assert.throws(() => claudeArgs({ prompt: ' ', model: 'sonnet' }), /needs the owner words/);
});

test('redact: keys, OAuth tokens, Bearer values and secret-named fields are masked; apiKeySource is kept; it is idempotent', () => {
  const text = [
    `key ${madeUpToken('api03')} and ${madeUpToken('oat01')}`, 'Authorization: Bearer abc.def-123', '"accessToken": "xyz-123"',
    'CLAUDE_CODE_OAUTH_TOKEN=plain-value', '"apiKeySource": "none"',
  ].join('\n');
  const out = redact(text);
  for (const secret of [madeUpToken('api03'), madeUpToken('oat01'), 'abc.def-123', 'xyz-123', 'plain-value']) assert.ok(!out.includes(secret), secret);
  assert.match(out, /"apiKeySource": "none"/);
  assert.equal(out.split(REDACTED).length - 1, 5);
  assert.equal(redact(out), out);
});

test('the printed line and results.json are redacted; results.json is owner-only', () => {
  const line = { check: 'login', expected: 'no token', observed: `saw ${madeUpToken()}`, pass: false };
  assert.ok(!formatLine('E0', line).includes(madeUpToken()));
  const out = makeTempDir('harness-results-');
  const file = writeResults(out, { lines: [line] });
  assert.ok(!readFileSync(file, 'utf8').includes(madeUpToken()));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!redactJson({ token: 'abc' }).includes('abc'));
});

test('runDetached: a child that prints a token leaves only the masked text in its log', async () => {
  const dir = makeTempDir('harness-spawn-');
  const outFile = join(dir, 'out.log');
  const exit = await runDetached({ command: process.execPath, args: ['-e', `console.log(${JSON.stringify(madeUpToken())})`],
    env: cleanEnv(), cwd: dir, outFile, errFile: join(dir, 'err.log'), timeoutMs: 30_000, registry: new ProcessRegistry() });
  assert.equal(exit.code, 0);
  assert.equal(readFileSync(outFile, 'utf8'), `${REDACTED}\n`);
});

test('childEnv: API key, auth token, base URL and model remaps of the runner are dropped; a scenario cannot set them', () => {
  const names = [...REMOVED_ENV, 'ANTHROPIC_DEFAULT_OPUS_MODEL'];
  const kept = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = 'from-the-runner';
    const env = childEnv({ home: '/h', tmp: '/t', path: '/bin', quietLog: '/q', longRunState: '/l' });
    for (const name of names) assert.equal(env[name], undefined, name);
    assert.deepEqual([env.HOME, env.TMPDIR, env.PATH, env.CLAUDE_CONFIG_DIR], ['/h', '/t', '/bin', undefined]);
    const remap = childEnv({ home: '/h', tmp: '/t', path: '/bin', quietLog: '/q', longRunState: '/l', extra: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'x' } });
    assert.equal(remap.ANTHROPIC_DEFAULT_OPUS_MODEL, 'x', 'E4 sets one alias target on purpose');
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR']) {
      assert.throws(() => childEnv({ home: '/h', tmp: '/t', path: '/bin', quietLog: '/q', longRunState: '/l', extra: { [name]: 'x' } }), /may not set/, name);
    }
  } finally {
    for (const [name, value] of Object.entries(kept)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('childEnv: the runner login token is passed on by its one name; other CLAUDE_* stay dropped; a scenario cannot set it', () => {
  withRunnerEnv({ [LOGIN_ENV]: LOGIN_VALUE, CLAUDE_GUARD_ASK: 'allow', CLAUDE_CODE_SESSION_ID: 'boss-session' }, () => {
    const env = childEnv(SPEC);
    assert.equal(env[LOGIN_ENV], LOGIN_VALUE);
    // the harness's own switches (the wait ceiling, cleanEnv's notes switch) and the login are the only CLAUDE_* names
    assert.deepEqual(Object.keys(env).filter((name) => name.startsWith('CLAUDE')).sort(),
      [LOGIN_ENV, 'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS', 'CLAUDE_LONG_RUN_DESKTOP_NOTES'].sort());
    assert.equal(env.CLAUDE_GUARD_ASK, undefined);
    assert.throws(() => childEnv({ ...SPEC, extra: { [LOGIN_ENV]: 'from-a-scenario' } }), /may not set CLAUDE_CODE_OAUTH_TOKEN/);
  });
  withRunnerEnv({ [LOGIN_ENV]: undefined }, () => assert.equal(LOGIN_ENV in childEnv(SPEC), false, 'no token in the runner env: none in the child'));
});

test('redact: the runner login token is masked by its value, whatever its shape, in lines and results.json', () => {
  withRunnerEnv({ [LOGIN_ENV]: LOGIN_VALUE }, () => {
    const out = redact(`stderr: token ${LOGIN_VALUE} was refused; again:${LOGIN_VALUE}`);
    assert.equal(out, `stderr: token ${REDACTED} was refused; again:${REDACTED}`);
    assert.ok(!formatLine('E0', { ...FAIL_LINE, observed: LOGIN_VALUE }).includes(LOGIN_VALUE));
    assert.ok(!redactJson({ note: `x ${LOGIN_VALUE}` }).includes(LOGIN_VALUE));
    assert.equal(redact(out), out);
  });
});

test('assertInside: a path inside the root passes; one outside it, or a link out of it, is refused', () => {
  const root = makeRunRoot(makeTempDir('harness-inside-'));
  const outside = makeTempDir('harness-outside-');
  assert.equal(assertInside(join(root, 'a', 'b'), root).startsWith(root), true);
  assert.throws(() => assertInside(join(outside, 'x'), root), /refused: .* outside the run root/);
  assert.throws(() => assertInside(join(root, '..', 'x'), root), /outside the run root/);
  symlinkSync(outside, join(root, 'escape'));
  assert.throws(() => assertInside(join(root, 'escape', 'x'), root), /outside the run root/);
});

test('removeRunRoot: removes a root this run made; refuses one it did not make, one without the prefix or the marker', () => {
  const temp = makeTempDir('harness-remove-');
  const root = makeRunRoot(temp);
  assert.ok(root.split('/').at(-1).startsWith(RUN_PREFIX));
  assert.deepEqual(removeRunRoot(root, new Set()), { removed: false, reason: `refused: ${root} was not made by this run` });
  assert.ok(existsSync(root));
  const plain = join(temp, 'not-a-run-root');
  mkdirSync(plain);
  const plainReal = realpathSync(plain);
  writeFileSync(join(plain, MARKER_FILE), '{}');
  assert.match(removeRunRoot(plainReal, new Set([plainReal])).reason, /does not start with/);
  assert.ok(existsSync(plain));
  const unmarked = makeRunRoot(temp);
  writeFileSync(join(unmarked, MARKER_FILE), JSON.stringify({ uid: -1 }));
  assert.match(removeRunRoot(unmarked, new Set([unmarked])).reason, /no marker of this user/);
  assert.ok(existsSync(unmarked));
  assert.deepEqual(removeRunRoot(root, new Set([root])), { removed: true, reason: 'removed' });
  assert.equal(existsSync(root), false);
});

test('removeProjectFolders: only the project folders of folders inside the root are removed', () => {
  const temp = makeTempDir('harness-projects-');
  const root = makeRunRoot(temp);
  const projects = join(temp, 'projects');
  const ours = join(projects, `${projectKey(root)}-E0-repo`);
  const theirs = join(projects, '-Users-someone-work');
  for (const dir of [ours, theirs]) mkdirSync(dir, { recursive: true });
  assert.deepEqual(removeProjectFolders(projects, root), { removed: [ours], refused: [] });
  assert.equal(existsSync(ours), false);
  assert.ok(existsSync(theirs));
});

test('a usage limit in the stream (rejected, 429, printed text or credits in use) is found, and gives exit 3', () => {
  const rejected = [{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: RESETS_AT_S, rateLimitType: 'five_hour' } }];
  const limit = limitOf(rejected);
  assert.deepEqual([limit.kind, limit.resetsAtMs], ['limit', RESETS_AT_S * 1000]);
  assert.equal(resetText(limit), new Date(RESETS_AT_S * 1000).toISOString());
  assert.equal(limitOf([{ type: 'result', is_error: true, api_error_status: 429, result: 'rate limited' }]).kind, 'limit');
  assert.equal(limitOf([], "You've hit your session limit · resets 3pm").kind, 'limit');
  assert.equal(limitOf([{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', isUsingOverage: true } }]).kind, 'credits');
  assert.equal(limitOf([{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } }, { type: 'result', is_error: false, result: 'ok' }]), null);
  assert.equal(exitCodeOf({ lines: [PASS_LINE], limit }), EXIT.limit);
});

test('exitCodeOf: 0 only when every line passed; a FAIL, a NOT RUN or no line at all gives 1', () => {
  assert.equal(exitCodeOf({ lines: [PASS_LINE], limit: null }), EXIT.pass);
  assert.equal(exitCodeOf({ lines: [PASS_LINE, FAIL_LINE], limit: null }), EXIT.fail);
  assert.equal(exitCodeOf({ lines: [PASS_LINE, notRunLine('E9', 'needs --real-home')], limit: null }), EXIT.fail);
  assert.equal(exitCodeOf({ lines: [], limit: null }), EXIT.fail);
  assert.match(formatLine('E9', notRunLine('long-run', 'needs --real-home')), /\| NOT RUN$/);
});

test('a login stop gives exit 2 before a limit; loginRefusal reads the error result or stderr, never a good result', () => {
  assert.equal(exitCodeOf({ lines: [PASS_LINE], limit: { kind: 'limit' }, login: { name: 'preflight' } }), EXIT.usage);
  assert.equal(loginRefusal({ result: { is_error: true, result: 'Not logged in · Please run /login' }, stderrTail: '' }), 'Not logged in · Please run /login');
  assert.match(loginRefusal({ result: null, stderrTail: 'API Error: 401 authentication_error' }), /401/);
  assert.equal(loginRefusal({ result: { is_error: true, result: 'API Error: 500' }, stderrTail: '' }), null, 'another error is no login stop');
  assert.equal(loginRefusal({ result: { is_error: false, result: 'the docs say: not logged in' }, stderrTail: '' }), null, 'a good result is never one');
});

test('settingsCopy: hook paths move to the temp HOME, the guard switch is dropped, auto-continue at a limit is off', () => {
  const real = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'node "/Users/o/.claude/hooks/pre-bash-guard.mjs"' }] }] },
    statusLine: { command: 'node /Users/o/.claude/statusline.mjs' }, env: { CLAUDE_GUARD_ASK: 'allow', KEEP: '1' }, autoContinueAtUsageLimit: true });
  const copy = JSON.parse(settingsCopy(real, '/Users/o', '/tmp/run/home'));
  assert.equal(copy.hooks.PreToolUse[0].hooks[0].command, 'node "/tmp/run/home/.claude/hooks/pre-bash-guard.mjs"');
  assert.equal(copy.statusLine.command, 'node /tmp/run/home/.claude/statusline.mjs');
  assert.deepEqual(copy.env, { KEEP: '1' });
  assert.equal(copy.autoContinueAtUsageLimit, false);
  assert.equal(claudeMdCopy('@/real/setup/home/CLAUDE.md\n@/real/personal/CLAUDE.md', '/real/setup', '/lane'), '@/lane/home/CLAUDE.md\n@/real/personal/CLAUDE.md');
});

const RUN_ROOT = '/made-up/cs-test-e2e-run';
const REAL_HOME = '/made-up/real-home';

/** A dry run state with the temp HOME and, in `--real-home` mode, the real HOME's paths beside it. */
const runState = (realHomeMode) => makeRunState({ dry: true, root: RUN_ROOT, setupFrom: '/made-up/setup', realHome: REAL_HOME, realHomeMode,
  paths: homePaths(RUN_ROOT, REAL_HOME), realPaths: realHomeMode ? homePaths(RUN_ROOT, REAL_HOME, true) : null, childPath: '/bin' });

test('makeContext: --real-home gives the real HOME only to a scenario with needsRealHome (E9); the rest keep the temp HOME', () => {
  const tempHome = join(RUN_ROOT, 'home');
  assert.equal(E9.needsRealHome, true);
  const real = runState(true);
  const e9 = makeContext(real, E9);
  assert.equal(e9.paths.home, REAL_HOME);
  assert.equal(e9.realHomeMode, true);
  assert.equal(e9.env().HOME, REAL_HOME);
  const other = makeContext(real, { id: 'E0' });
  assert.equal(other.paths.home, tempHome);
  assert.equal(other.realHomeMode, false);
  assert.equal(other.env().HOME, tempHome);
  assert.equal(makeContext(runState(false), E9).env().HOME, tempHome, 'without --real-home E9 keeps the temp HOME too');
});

test("E11: with --real-home the real guard log line is NOT RUN, never a pass; without it the line is checked", () => {
  const lineIn = (realHomeMode) => E11.check({ run: { before: null, sessionIds: new Set(), shimDirs: [], realHomeMode, root: RUN_ROOT },
    notes: { after: { realGuardSessions: new Set() }, tools: {} }, paths: { guardLog: join(RUN_ROOT, 'none.jsonl') } }).at(-1);
  const real = lineIn(true);
  assert.equal(real.notRun, true);
  assert.equal(real.pass, false);
  assert.match(real.observed, /real-home/);
  assert.equal(lineIn(false).notRun, undefined);
  assert.equal(lineIn(false).pass, true);
});
