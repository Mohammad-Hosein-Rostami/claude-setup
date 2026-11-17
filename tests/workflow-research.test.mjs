// Tests for home/workflows/research.js: Opus scope, Sonnet gatherers, Opus synthesis and critic, URL re-checks, patches.
// Exports: none (node:test file). Runs the script in tests/workflow-sandbox.mjs.
// Invariants: expected shape comes from the spec (section 7 `research`, U9): question counts by depth, synthesis only
// after every gatherer returned, every version/date/price claim re-checked against its URL, every patch applied, claims
// that could not be verified returned as unverified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScript as runPath } from './workflow-sandbox.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'home', 'workflows', 'research.js');
const runScript = (args, setup) => runPath(SCRIPT, args, setup);

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
    { match: /:scope/, reply: SCOPE },
    { match: /:gather:q1/, reply: { id: 'q1', notesPath: '/o/report.md.notes/q1.md', claims: [claim('A holds 10k/s', 'fact', true)] } },
    { match: /:gather:/, reply: { id: 'q', notesPath: '/o/report.md.notes/q.md', claims: [claim('B costs 5 USD', 'price')] } },
    { match: /:synthesize/, reply: { path: '/o/report.md' } },
    { match: /:critic/, reply: CRITIC },
    { match: /:recheck:/, reply: (prompt) => ({ claim: prompt.match(/Claim: (.*?)\. URL/)[1], status: 'holds', correction: '', evidence: 'fetched' }) },
    { match: /:patch/, reply: { path: '/o/report.md', applied: 2 } },
  ];
}

test('research: scope, gather in parallel, synthesis only after every gatherer, critic, re-checks, patch, in that order', async () => {
  const finished = { gather: 0, recheck: 0 };
  let gatheredAtSynthesis = null;
  let rechecksAtPatch = null;
  const run = await runScript(ARGS, {
    replies: replies([
      { match: /:gather:/, reply: async (prompt) => { await new Promise(setImmediate); finished.gather += 1; return { id: 'q', notesPath: '/o/report.md.notes/q.md', claims: [claim(`from ${prompt.length}`, 'fact')] }; } },
      { match: /:synthesize/, reply: () => { gatheredAtSynthesis = finished.gather; return { path: '/o/report.md' }; } },
      { match: /:recheck:/, reply: async (prompt) => { await new Promise(setImmediate); finished.recheck += 1; return { claim: prompt.match(/Claim: (.*?)\. URL/)[1], status: 'holds', correction: '', evidence: '' }; } },
      { match: /:patch/, reply: () => { rechecksAtPatch = finished.recheck; return { path: '/o/report.md', applied: 1 }; } },
    ]),
  });
  assert.equal(run.error, null);
  assert.equal(gatheredAtSynthesis, 3, 'synthesis waits for every gatherer');
  assert.equal(rechecksAtPatch, 3, 'the patch waits for every re-check');
  const order = ['scope', 'gather:q1', 'synthesize', 'critic', 'recheck:1', 'patch'].map((step) => run.started.indexOf(`r1:${step}`));
  assert.deepEqual(order, [...order].sort((x, y) => x - y), 'scope, gather, synthesize, critic, recheck, patch');
  assert.ok(order.every((at) => at >= 0));
  const models = Object.fromEntries(run.calls.map((c) => [c.label.split(':')[1], `${c.opts.model}/${c.opts.effort}`]));
  assert.deepEqual(models, { scope: 'opus/high', gather: 'sonnet/high', synthesize: 'opus/high', critic: 'opus/high', recheck: 'sonnet/high', patch: 'sonnet/high' });
});

test('research: the disputed claim and every version, date and price claim are re-checked against their URL; wrong ones go into the patch', async () => {
  const verdicts = { 'A holds 10k/s': { status: 'wrong', correction: 'A holds 1k/s' }, 'B costs 5 USD': { status: 'unreachable', correction: '' } };
  const run = await runScript(ARGS, {
    replies: replies([{ match: /:recheck:/, reply: (prompt) => { const text = prompt.match(/Claim: (.*?)\. URL/)[1]; return { claim: text, status: 'holds', correction: '', evidence: '', ...verdicts[text] }; } }]),
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
  const run = await runScript(ARGS, {
    replies: replies([{ match: /:critic/, reply: { disputed: [], recheck: [], patches: [] } }]),
  });
  assert.equal(run.calls.some((c) => /:patch/.test(c.label)), false);
  assert.deepEqual(run.result.unverified.map((u) => u.claim), ['A holds 10k/s']);
});

test('research: a version, date or price claim a gatherer found is re-checked even when the critic does not list it', async () => {
  const run = await runScript(ARGS, { replies: replies([{ match: /:critic/, reply: { disputed: [], recheck: [], patches: [] } }]) });
  const rechecked = run.calls.filter((c) => /:recheck:/.test(c.label)).map((c) => c.prompt.match(/Claim: (.*?)\. URL/)[1]);
  assert.deepEqual([...new Set(rechecked)], ['B costs 5 USD'], 'the price claim, once, and not the plain fact');
});

test('research: a gatherer that returns nothing is named in the synthesis prompt and in unverified, never dropped', async () => {
  const run = await runScript(ARGS, { replies: replies([{ match: /:gather:q2/, reply: null }]) });
  assert.match(run.calls.find((c) => /:synthesize/.test(c.label)).prompt, /q2/);
  assert.ok(run.result.unverified.some((u) => /limits of B/.test(u.claim) && /returned nothing/.test(u.why)));
});

test('research: when no gatherer returns notes the run stops before synthesis and says so', async () => {
  const run = await runScript(ARGS, { replies: replies([{ match: /:gather:/, reply: null }]) });
  assert.equal(run.result.error, 'no gatherer returned notes');
  assert.equal(run.started.includes('r1:synthesize'), false);
  assert.equal(run.result.unverified.length, 3);
});

test('research: a patch step that returns nothing is reported as an error, not as a finished report', async () => {
  const run = await runScript(ARGS, { replies: replies([{ match: /:patch/, reply: null }]) });
  assert.match(run.result.error, /patch/);
  assert.equal(run.result.path, '/o/report.md');
});

test('research: the number of questions follows the depth (1-2, 2-4, 5-8)', async () => {
  const sizes = {};
  for (const depth of ['simple', 'compare', 'complex']) {
    const run = await runScript({ ...ARGS, depth }, { replies: replies() });
    const items = run.calls.find((c) => /:scope/.test(c.label)).opts.schema.properties.questions;
    sizes[depth] = [items.minItems, items.maxItems];
  }
  assert.deepEqual(sizes, { simple: [1, 2], compare: [2, 4], complex: [5, 8] });
});

test('research: a bad args object throws the named error before any agent starts', async () => {
  const { question, ...missing } = ARGS;
  const noQuestion = await runScript(missing, { replies: replies() });
  assert.equal(noQuestion.error.message, 'research: args.question must be a string');
  const badDepth = await runScript({ ...ARGS, depth: 'huge' }, { replies: replies() });
  assert.equal(badDepth.error.message, 'research: args.depth must be simple, compare or complex');
  assert.equal(noQuestion.calls.length + badDepth.calls.length, 0);
});
