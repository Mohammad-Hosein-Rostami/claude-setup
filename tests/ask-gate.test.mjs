// Tests for home/hooks/ask-gate.mjs: the Stop hook that blocks a run ending with unasked owner decisions.
// Covers the exported matcher `listsDeferredDecisions(text)` and the hook contract (stdin/stdout JSON, exit codes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listsDeferredDecisions } from '../home/hooks/ask-gate.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/ask-gate.mjs', import.meta.url));
const DECISIONS = 'Work is done.\nDecisions you must make:\nD1: what 12-05 means\nD2: which plan to buy';

const CHOICE = '\nA or B?'; // the request phrases only count with an open choice in the closing lines

test('matcher hits English deferred-decision phrasing', () => {
  for (const text of [
    'Decision needed: pick a plan', 'Decisions to make before release', 'decisions pending',
    'This needs your decision.', 'Waiting on your input.', 'Awaiting your approval', 'Needs your approval', 'need your call',
    'You must decide which one.', 'You need to decide soon', 'You have to decide', 'Decisions required before launch',
  ]) assert.equal(listsDeferredDecisions(text + CHOICE), true, text);
});

test('matcher hits a heading on its own line, not the same words inside a sentence', () => {
  for (const text of ['## Open questions\n- a', 'Done.\n**Your call:**\nwhich one', 'Decisions needed:\n- x', '> not quoted\nDecisions\n1. pick']) {
    assert.equal(listsDeferredDecisions(text), true, text);
  }
  for (const text of ['Your call on naming was followed', 'The open questions were answered by the owner.', 'Decisions were made.']) {
    assert.equal(listsDeferredDecisions(text), false, text);
  }
});

test('matcher hits Persian phrasing, with a space or a zero-width joiner', () => {
  for (const text of [
    'نیاز به تصمیم دارد', 'منتظر تأیید شما هستم', 'یک سوال باز مانده', 'سوال‌های باز', 'باید تصمیم بگیری که کدام',
    'تصمیمات لازم', 'تصمیم باز مانده', 'تصمیم هایی که باید بگیرید', 'نیاز‌به تصمیم',
  ]) assert.equal(listsDeferredDecisions(`${text}\nالف یا ب؟`), true, text);
});

test('matcher misses plain statements, including "I decided to use X"', () => {
  for (const text of [
    'I decided to use Postgres.', 'We decided on the simpler option and moved on.', 'All tests pass.', 'Fixed the bug in parser.mjs', '',
    'کار تمام شد', 'The decision you made earlier was applied', 'تصمیم گرفتم از X استفاده کنم', 'Open question', 'That one is your call.',
    'you should decide', 'Decision for me? no',
  ]) assert.equal(listsDeferredDecisions(text), false, text);
});

test('matcher skips negated phrases (no, none, zero, resolved, answered, ندارم, نیست)', () => {
  for (const text of [
    'No open questions remain.\nDecisions needed: none', 'There are no decisions pending.', 'Zero decisions needed', 'resolved decisions needed', 'answered decisions pending', 'سوال باز ندارم', 'تصمیم لازم نیست', 'نیاز به تصمیم ندارم',
  ]) assert.equal(listsDeferredDecisions(text), false, text);
  assert.equal(listsDeferredDecisions('Nothing else. Decisions needed: pick a plan'), true);
  assert.equal(listsDeferredDecisions('I have no doubts. Decision needed: pick a plan'), true);
});

test('matcher ignores quoted lines, inline code and fenced code', () => {
  for (const text of [
    '> Decisions needed: pick a plan', 'Run `needs your decision` to see it', '```\nDecisions needed:\nD1: a\nD2: b\nD3: c\n```\nDone.',
    '```\nunterminated Decisions needed',
  ]) assert.equal(listsDeferredDecisions(text), false, text);
});

test('matcher counts only D-items: 3 alone, 2 after a decision word, never Q-items', () => {
  assert.equal(listsDeferredDecisions('D1: only one line here'), false);
  assert.equal(listsDeferredDecisions('D1: first thing\nD2: second thing'), false);
  assert.equal(listsDeferredDecisions('D1: first thing\nD2: second\nD3: third'), true);
  assert.equal(listsDeferredDecisions('- **D1:** first\n- **D2:** second\n- **D3:** third'), true);
  assert.equal(listsDeferredDecisions('Decisions you must make:\nD1: first\nD2: second'), true);
  assert.equal(listsDeferredDecisions('Decisions you must make\n\n\n\nD1: first\nD2: second'), false, 'word is more than 3 lines away');
  assert.equal(listsDeferredDecisions('Q1: first\nQ2: second\nQ3: third\nQ4: fourth'), false);
  assert.equal(listsDeferredDecisions('Which decision?\nQ1: a\nQ2: b'), false);
});

test('matcher blocks line-start labels with text after the colon (no open choice needed)', () => {
  for (const text of [
    '**Your call:** A or B?', 'Open question: should we use pnpm or npm?', '- Open questions: which one', 'Questions for you: a or b',
    '## Decisions for you:\n- a', 'Decisions required: x', 'Things I need from you: the API key',
  ]) assert.equal(listsDeferredDecisions(text), true, text);
});

test('matcher blocks the new request phrases when an open choice follows', () => {
  for (const text of [
    'I need you to decide which.', 'I need you to choose', 'I need you to pick one', 'I need you to confirm the date',
    'Please let me know which you prefer', 'let me know which option', 'Let me know which one',
    'تصمیم بگیر', 'تصمیم بگیرید', 'تصمیم‌بگیرید', 'لطفا انتخاب کن', 'لطفا یکی را تصمیم',
  ]) assert.equal(listsDeferredDecisions(`${text}\n1. A\n2. B`), true, text);
});

test('matcher ignores bare "decisions for you" in a sentence and a label that is not at the line start', () => {
  for (const text of ['I made the decisions for you: used pnpm.', 'Here are the decisions for you.', 'It was your call: done', 'I did not need you to decide.']) {
    assert.equal(listsDeferredDecisions(text), false, text);
  }
});

test('matcher ignores text inside "..." and curly quotes', () => {
  for (const text of ['He wrote "Decisions needed: pick a plan" in the file', 'The log says “Your call: A or B?”', 'She said "I need you to decide" and left']) {
    assert.equal(listsDeferredDecisions(text), false, text);
  }
  assert.equal(listsDeferredDecisions('Reading "the log". Decisions needed: pick a plan'), true);
});

test('matcher negation also looks after the match: are none, were answered, answered, resolved, none', () => {
  for (const text of [
    'Decisions needed earlier were answered: D1 = A.', 'decisions needed are none', 'Decisions pending: all resolved', 'Open questions: none',
    'Decisions needed: answered above', 'Decision needed is none',
  ]) assert.equal(listsDeferredDecisions(text), false, text);
});

test('matcher: descriptive "needs your call" text passes (regression)', () => {
  for (const text of [
    'The hook fires on text like needs your call, which is a false positive.',
    'ask-gate fires on needs your call',
    'Needs your call is one of the phrases the matcher looks for. Which phrases are those?',
    'The reviewer says it needs your approval flag',
    'Changelog: the report that needs your approval was merged, which one is next?',
    'The report needs your approval to merge.\nIt already asked. A or B?\n' + 'Done line.\n'.repeat(15),
    'Waiting on your input in the doc, now fixed.',
    'The section needs your approval header text.',
    'Needs your call.',
    'This needs your decision.',
  ]) assert.equal(listsDeferredDecisions(text), false, text);
});

test('matcher: a real unasked decision blocks (regression)', () => {
  for (const text of [
    'Done.\nUse pnpm or npm? Needs your call.',
    'All built. Needs your call: A or B',
    'Done.\n\nThis needs your decision:\n1. ship now\n2. wait a day',
    'Work is finished.\n- Needs your approval: merge into main?',
    'Done. Decisions needed:\n- D1 which plan',
    'Done.\nPlease let me know which you prefer: A or B?',
  ]) assert.equal(listsDeferredDecisions(text), true, text);
});

test('matcher: only the last 15 non-empty lines are scanned for request phrases', () => {
  const filler = Array.from({ length: 15 }, (_, i) => `line ${i}`).join('\n');
  assert.equal(listsDeferredDecisions(`Needs your call: A or B?\n${filler}`), false, 'phrase 15+ lines before the end');
  assert.equal(listsDeferredDecisions(`Needs your call: A or B?\n${filler.split('\n').slice(1).join('\n')}`), true, 'phrase in the last 15 lines');
  assert.equal(listsDeferredDecisions(`Decisions needed:\n- x\n${filler}`), true, 'headings keep the whole text');
});

test('matcher: an explicit choice between named alternatives counts as an open choice', () => {
  for (const text of [
    'I need you to decide A or B.', 'Done.\nI need you to choose pnpm vs npm.', 'You must decide X versus Y', 'I need you to pick Postgres or SQLite.',
  ]) assert.equal(listsDeferredDecisions(text), true, text);
  assert.equal(listsDeferredDecisions('I need you to decide.'), false, 'no choice named');
  assert.equal(listsDeferredDecisions('This needs your decision.\nWe chose A or B earlier.'), false, 'alternatives in another sentence');
});

test('matcher tolerates non-string input', () => {
  for (const v of [undefined, null, 42, {}]) assert.equal(listsDeferredDecisions(v), false);
});

const user = (content) => ({ type: 'user', message: { role: 'user', content } });
const assistant = (content) => ({ type: 'assistant', message: { role: 'assistant', content } });
const ASK_CALL = assistant([{ type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: { questions: [] } }]);
const RESULT = user([{ type: 'tool_result', tool_use_id: 't1', content: 'answered' }]);

async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), 'ask-gate-'));
  const transcript = async (entries) => {
    const p = join(dir, 'transcript.jsonl');
    await writeFile(p, entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n');
    return p;
  };
  const run = (input, raw) =>
    spawnSync(process.execPath, [HOOK], {
      input: raw ?? JSON.stringify({ session_id: 's1', hook_event_name: 'Stop', ...input }),
      encoding: 'utf8',
      env: { ...process.env, HOME: dir, USERPROFILE: dir, ASK_GATE_LOG: '' },
    });
  return { dir, transcript, run };
}
const blocked = (r) => {
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /AskUserQuestion/);
  return out;
};
const allowed = (r) => {
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '');
};

test('blocks when the message lists decisions and nothing was asked', async () => {
  const { run, transcript } = await sandbox();
  const p = await transcript([user('please build it'), assistant([{ type: 'text', text: DECISIONS }])]);
  blocked(run({ last_assistant_message: DECISIONS, transcript_path: p }));
});

test('blocks with only the message, no transcript', async () => {
  const { run } = await sandbox();
  blocked(run({ last_assistant_message: DECISIONS }));
});

test('allows a plain "I decided to use X" ending', async () => {
  const { run } = await sandbox();
  allowed(run({ last_assistant_message: 'I decided to use Postgres. Done.' }));
});

test('stop_hook_active allows without output even with decisions listed', async () => {
  const { run } = await sandbox();
  allowed(run({ last_assistant_message: DECISIONS, stop_hook_active: true }));
});

test('allows when AskUserQuestion ran after the last real user prompt', async () => {
  const { run, transcript } = await sandbox();
  const p = await transcript([user('build it'), ASK_CALL, RESULT, assistant([{ type: 'text', text: DECISIONS }])]);
  allowed(run({ last_assistant_message: DECISIONS, transcript_path: p }));
});

test('an AskUserQuestion before the last real prompt does not count', async () => {
  const { run, transcript } = await sandbox();
  const p = await transcript([user('first'), ASK_CALL, RESULT, user('second prompt, new task'), assistant([{ type: 'text', text: DECISIONS }])]);
  blocked(run({ last_assistant_message: DECISIONS, transcript_path: p }));
});

test('text-block user prompts count as real prompts', async () => {
  const { run, transcript } = await sandbox();
  const p = await transcript([ASK_CALL, user([{ type: 'text', text: 'next task please' }])]);
  blocked(run({ last_assistant_message: DECISIONS, transcript_path: p }));
});

test('tool_result, task-notification and system lines are not prompts', async () => {
  const { run, transcript } = await sandbox();
  const p = await transcript([
    user('build it'), ASK_CALL, RESULT,
    user('<task-notification>agent finished</task-notification>'),
    user([{ type: 'text', text: '<system-reminder>note</system-reminder>' }]),
  ]);
  allowed(run({ last_assistant_message: DECISIONS, transcript_path: p }));
});

test('falls back to the last assistant text in the transcript when the message is absent', async () => {
  const { run, transcript } = await sandbox();
  const p = await transcript([user('go'), assistant([{ type: 'text', text: DECISIONS }])]);
  blocked(run({ transcript_path: p }));
  const q = await transcript([user('go'), assistant([{ type: 'text', text: 'All done, nothing pending.' }])]);
  allowed(run({ transcript_path: q }));
});

test('malformed transcript lines are tolerated', async () => {
  const { run, transcript } = await sandbox();
  const p = await transcript([user('go'), '{broken', assistant([{ type: 'text', text: DECISIONS }])]);
  blocked(run({ last_assistant_message: DECISIONS, transcript_path: p }));
});

test('internal errors exit 0 so a session is never trapped', async () => {
  const { run, dir } = await sandbox();
  for (const raw of ['not json', '', '[]', 'null']) {
    const r = run({}, raw);
    assert.equal(r.status, 0, raw);
    assert.equal(r.stdout.trim(), '', raw);
  }
  const missing = run({ last_assistant_message: 'All good.', transcript_path: join(dir, 'nope.jsonl') });
  allowed(missing);
  const withMissing = run({ last_assistant_message: DECISIONS, transcript_path: join(dir, 'nope.jsonl') });
  assert.equal(withMissing.status, 0);
});

test('an image-only prompt and a "[Request interrupted" prompt are not real prompts', async () => {
  const { run, transcript } = await sandbox();
  const image = user([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]);
  const placeholder = user([{ type: 'text', text: '[Image #1]' }, { type: 'image', source: {} }]);
  const interrupted = user([{ type: 'text', text: '[Request interrupted by user]' }]);
  const p = await transcript([user('build it'), ASK_CALL, RESULT, image, placeholder, interrupted]);
  allowed(run({ last_assistant_message: DECISIONS, transcript_path: p }));
  const q = await transcript([user('build it'), ASK_CALL, RESULT, user([{ type: 'text', text: 'now look at this' }, { type: 'image', source: {} }])]);
  blocked(run({ last_assistant_message: DECISIONS, transcript_path: q }));
});

test('odd transcript entries (null, arrays, numbers, missing message) neither throw nor break the prompt index', async () => {
  const { run, transcript } = await sandbox();
  const p = await transcript([user('build it'), ASK_CALL, 'null', '[]', '42', '{"type":"user"}', '{"type":"user","message":null}', user(null), user([null, 7])]);
  allowed(run({ last_assistant_message: DECISIONS, transcript_path: p }));
});

test('a matcher false positive case does not block through the hook: "No open questions remain; I decided to use X."', async () => {
  const { run } = await sandbox();
  allowed(run({ last_assistant_message: 'No open questions remain; I decided to use X.' }));
});

test('through the hook: descriptive "needs your call" text passes, a real unasked decision blocks', async () => {
  const { run, transcript } = await sandbox();
  const p = await transcript([user('go')]);
  allowed(run({ last_assistant_message: 'Fixed. The old matcher fired on text like needs your call.', transcript_path: p }));
  blocked(run({ last_assistant_message: 'Built both.\nUse pnpm or npm? Needs your call.', transcript_path: p }));
});

test('envelopes (agent and cross-session messages, notifications, reminders) are not prompts, even inside typed text', async () => {
  const { run, transcript } = await sandbox();
  const envelopes = [
    '<agent-message from="w">done</agent-message>', '<cross-session-message>hi</cross-session-message>',
    '[SYSTEM NOTIFICATION - NOT USER INPUT] done', '<system-reminder>x</system-reminder>',
  ];
  for (const envelope of envelopes) {
    const p = await transcript([user('build it'), ASK_CALL, RESULT, user(envelope)]);
    allowed(run({ last_assistant_message: DECISIONS, transcript_path: p })); // the ask still counts: the envelope did not start a new prompt
  }
  const q = await transcript([user('build it'), ASK_CALL, RESULT, user('next task <agent-message>x</agent-message>')]);
  blocked(run({ last_assistant_message: DECISIONS, transcript_path: q })); // typed text around an envelope is a prompt
});
