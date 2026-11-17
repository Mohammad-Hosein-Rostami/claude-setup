// Tests for home/workflows/research.js: Opus scope, Sonnet gatherers, Opus synthesis and critic, URL re-checks, patches.
// Exports: none (node:test file). Runs the script against the stubbed runtime of tests/workflow-more-helpers.mjs.
// Invariants: expected shape comes from the spec (section 7 `research`, U9): question counts by depth, synthesis only
// after every gatherer returned, every version/date/price claim re-checked against its URL, every patch applied, claims
// that could not be verified returned as unverified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScript } from './workflow-more-helpers.mjs';

const ARGS = { row: 'r1', question: 'Which queue fits a 10k jobs/day service?', out: '/o/report.md', depth: 'compare' };
const SCOPE = { questions: [{ id: 'q1', question: 'limits of A' }, { id: 'q2', question: 'limits of B' }, { id: 'q3', question: 'price of B' }] };
const claim = (text, kind, unverified = false) => ({ claim: text, url: `https://example.org/${text}`, kind, sources: 2, unverified });
const CRITIC = {
  disputed: [{ claim: 'A holds 10k/s', problem: 'notes say 1k/s', url: 'https://example.org/a' }],
  recheck: [{ claim: 'B costs 5 USD', url: 'https://example.org/b', kind: 'price' }, { claim: 'B is at 2.1', url: 'https://example.org/v', kind: 'version' }],
  patches: [{ where: 'section 2', change: 'name the source of the latency figure' }],
};

function replies(overrides = []) {
  return [
    ...overrides,
    { label: /:scope/, reply: SCOPE },
    { label: /:gather:q1/, reply: { id: 'q1', notesPath: '/o/report.md.notes/q1.md', claims: [claim('A holds 10k/s', 'fact', true)] } },
    { label: /:gather:/, reply: { id: 'q', notesPath: '/o/report.md.notes/q.md', claims: [claim('B costs 5 USD', 'price')] } },
    { label: /:synthesize/, reply: { path: '/o/report.md' } },
    { label: /:critic/, reply: CRITIC },
    { label: /:recheck:/, reply: (call) => ({ claim: call.prompt.match(/Claim: (.*?)\. URL/)[1], status: 'holds', correction: '', evidence: 'fetched' }) },
    { label: /:patch/, reply: { path: '/o/report.md', applied: 2 } },
  ];
}

test('research: scope, gather in parallel, synthesis only after every gatherer, critic, re-checks, patch, in that order', async () => {
  const run = await runScript('research', ARGS, { replies: replies() });
  assert.equal(run.error, null);
  const at = (event) => run.events.indexOf(event);
  assert.ok(at('end:r1:scope') < at('start:r1:gather:q1'));
  assert.ok(['q1', 'q2', 'q3'].every((id) => at(`end:r1:gather:${id}`) < at('start:r1:synthesize')));
  assert.ok(at('end:r1:synthesize') < at('start:r1:critic'));
  assert.ok(at('end:r1:critic') < at('start:r1:recheck:1') && at('end:r1:recheck:3') < at('start:r1:patch'));
  const models = Object.fromEntries(run.calls.map((c) => [c.label.split(':')[1], `${c.model}/${c.effort}`]));
  assert.deepEqual(models, { scope: 'opus/high', gather: 'sonnet/high', synthesize: 'opus/high', critic: 'opus/high', recheck: 'sonnet/high', patch: 'sonnet/high' });
});

test('research: the disputed claim and every version, date and price claim are re-checked against their URL; wrong ones go into the patch', async () => {
  const verdicts = { 'A holds 10k/s': { status: 'wrong', correction: 'A holds 1k/s' }, 'B costs 5 USD': { status: 'unreachable', correction: '' } };
  const run = await runScript('research', ARGS, {
    replies: replies([{ label: /:recheck:/, reply: (call) => { const text = call.prompt.match(/Claim: (.*?)\. URL/)[1]; return { claim: text, status: 'holds', correction: '', evidence: '', ...verdicts[text] }; } }]),
  });
  const rechecked = run.calls.filter((c) => /:recheck:/.test(c.label)).map((c) => c.prompt.match(/Claim: (.*?)\. URL/)[1]);
  assert.deepEqual(rechecked.sort(), ['A holds 10k/s', 'B costs 5 USD', 'B is at 2.1']);
  assert.match(run.calls.find((c) => /:recheck:/.test(c.label)).prompt, /fetch the URL again/i);
  const patch = run.calls.find((c) => /:patch/.test(c.label)).prompt;
  assert.match(patch, /A holds 1k\/s/, 'a wrong claim is corrected');
  assert.match(patch, /name the source of the latency figure/, 'the critic patch is applied');
  assert.deepEqual(run.result.unverified.map((u) => u.claim).sort(), ['A holds 10k/s', 'B costs 5 USD']);
  assert.equal(run.result.path, '/o/report.md');
});

test('research: a clean critic means no patch agent; an out-of-budget gatherer claim comes back unverified', async () => {
  const run = await runScript('research', ARGS, {
    replies: replies([{ label: /:critic/, reply: { disputed: [], recheck: [], patches: [] } }]),
  });
  assert.equal(run.calls.some((c) => /:patch/.test(c.label)), false);
  assert.deepEqual(run.result.unverified.map((u) => u.claim), ['A holds 10k/s']);
});

test('research: the number of questions follows the depth (1-2, 2-4, 5-8)', async () => {
  const sizes = {};
  for (const depth of ['simple', 'compare', 'complex']) {
    const run = await runScript('research', { ...ARGS, depth }, { replies: replies() });
    const items = run.calls.find((c) => /:scope/.test(c.label)).schema.properties.questions;
    sizes[depth] = [items.minItems, items.maxItems];
  }
  assert.deepEqual(sizes, { simple: [1, 2], compare: [2, 4], complex: [5, 8] });
});

test('research: a bad args object throws the named error before any agent starts', async () => {
  const { question, ...missing } = ARGS;
  const noQuestion = await runScript('research', missing, { replies: replies() });
  assert.equal(noQuestion.error.message, 'research: args.question must be string');
  const badDepth = await runScript('research', { ...ARGS, depth: 'huge' }, { replies: replies() });
  assert.equal(badDepth.error.message, 'research: args.depth must be simple, compare or complex');
  assert.equal(noQuestion.calls.length + badDepth.calls.length, 0);
});
