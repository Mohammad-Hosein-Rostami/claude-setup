// Test helper: runs one home/workflows/*.js script against stubs of the Workflow runtime (not a test file).
// Exports: runScript(name, args, { replies, children }) -> { result, error, meta, calls, events, children };
//          readScript(name) -> the script text; WORKFLOWS_DIR.
// Invariants: the script runs in an async function with `agent`, `pipeline`, `parallel`, `phase`, `log`, `workflow`,
// `args` and `budget` stubbed; `Date.now`, `Math.random` and an argless `new Date()` throw, as in the real runtime.
// `agent` answers from `replies` (first entry whose `label` regex matches wins; a reply is a value or a function
// (call, ctx) -> value | Promise); no match throws. `ctx.started(regex)` resolves once an agent with that label started,
// so a test can hold one agent back until another begins. `events` lists `start:<label>`, `end:<label>`, `child:<file>`
// in the order they happened.
// Note: this is the lean copy lane W2 needed before lane W1's tests/workflow-sandbox.mjs landed; when that file is on
// main, switch tests/workflow-scripts-more.test.mjs to it and delete this one.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const WORKFLOWS_DIR = fileURLToPath(new URL('../home/workflows/', import.meta.url));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const RUNTIME_NAMES = ['agent', 'pipeline', 'parallel', 'phase', 'log', 'workflow', 'args', 'budget', 'Date', 'Math', '__out'];

/** The script text of `home/workflows/<name>.js`. */
export function readScript(name) {
  return readFileSync(`${WORKFLOWS_DIR}${name}.js`, 'utf8');
}

function forbiddenClock() {
  const real = globalThis.Date;
  function ClockedDate(...parts) {
    if (parts.length === 0) throw new Error('new Date() without arguments is not available in a workflow script');
    return new real(...parts);
  }
  ClockedDate.now = () => { throw new Error('Date.now() is not available in a workflow script'); };
  return ClockedDate;
}

function forbiddenRandom() {
  const guarded = Object.create(Math);
  guarded.random = () => { throw new Error('Math.random() is not available in a workflow script'); };
  return guarded;
}

function makeRuntime(replies, children) {
  const calls = [];
  const events = [];
  const childCalls = [];
  const waiting = [];
  const ctx = {
    started: (pattern) => new Promise((resolve) => {
      if (events.some((event) => pattern.test(event) && event.startsWith('start:'))) resolve();
      else waiting.push({ pattern, resolve });
    }),
  };
  const record = (event) => {
    events.push(event);
    for (const entry of waiting.filter((w) => event.startsWith('start:') && w.pattern.test(event))) entry.resolve();
  };
  const runtime = {
    agent: async (prompt, opts = {}) => {
      const call = { prompt, ...opts };
      calls.push(call);
      record(`start:${opts.label}`);
      const entry = replies.find((r) => r.label.test(opts.label ?? ''));
      if (!entry) throw new Error(`no scripted reply for label ${opts.label}`);
      const reply = typeof entry.reply === 'function' ? await entry.reply(call, ctx) : entry.reply;
      record(`end:${opts.label}`);
      return reply;
    },
    pipeline: (items, ...stages) => Promise.all(items.map(async (item, index) => {
      try {
        let value = item;
        for (const stage of stages) value = await stage(value, item, index);
        return value;
      } catch (error) {
        if (/^no scripted reply/.test(error.message)) throw error;
        return null;
      }
    })),
    parallel: (thunks) => Promise.all(thunks.map(async (thunk) => {
      try { return await thunk(); } catch (error) {
        if (/^no scripted reply/.test(error.message)) throw error;
        return null;
      }
    })),
    phase: () => {},
    log: () => {},
    workflow: async (ref, childArgs) => {
      const file = String(ref.scriptPath ?? ref).split('/').pop();
      childCalls.push({ file, args: childArgs });
      record(`child:${file}`);
      const handler = children[file];
      if (handler === undefined) throw new Error(`no scripted child ${file}`);
      return typeof handler === 'function' ? handler(childArgs, ctx) : handler;
    },
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
  };
  return { runtime, calls, events, childCalls };
}

/**
 * Runs home/workflows/<name>.js once with stubbed runtime.
 * @param {string} name script name without `.js`
 * @param {object} args the Workflow `args` value
 * @param {{ replies?: {label: RegExp, reply: unknown}[], children?: Record<string, unknown> }} [scripted]
 * @returns {Promise<{ result: unknown, error: Error|null, meta: object, calls: object[], events: string[], children: object[] }>}
 */
export async function runScript(name, args, { replies = [], children = {} } = {}) {
  const body = readScript(name).replace(/^export const meta =/m, '__out.meta =');
  const { runtime, calls, events, childCalls } = makeRuntime(replies, children);
  const out = {};
  const run = new AsyncFunction(...RUNTIME_NAMES, body);
  let result = null;
  let error = null;
  try {
    result = await run(runtime.agent, runtime.pipeline, runtime.parallel, runtime.phase, runtime.log, runtime.workflow, args, runtime.budget, forbiddenClock(), forbiddenRandom(), out);
  } catch (caught) {
    error = caught;
  }
  return { result, error, meta: out.meta, calls, events, children: childCalls };
}
