// Test runtime for the saved workflow scripts in home/workflows: runs a script the way the Workflow tool does, but with scripted agents.
// Exports: runScript(path, args, { replies, children }) -> { result, error, calls, started }; readMeta(source) -> the meta literal;
//   scriptFiles() -> the paths of home/workflows/*.js.
// How the real tool treats a script (Claude Code 2.1.326, binary and Workflow tool text): `export const meta = {...}` is a pure literal and
// the first statement; the body is plain JS with top-level await; `agent`, `pipeline`, `parallel`, `phase`, `log`, `workflow`, `args`,
// `budget` are globals; Date.now(), Math.random() and argless new Date() throw; dynamic import() fails; there is no fs or shell.
// The stubs here: `agent` answers from `replies` (first entry whose `match` fits the label; a reply may be a function of
// (prompt, opts) and may return a promise, so a test can hold an agent back); an agent with no reply throws, so a test never passes by
// accident. `pipeline` runs every item through the stages with no barrier; `parallel` is a barrier; a throw gives null, as in the tool.
// `workflow(ref, args)` runs `children[name]` (a function of its args, or a script path run through this same sandbox) one level deep.
// Invariants: every agent call is recorded in `calls` ({ order, label, prompt, opts }) when it STARTS, `started` lists the labels in that order.
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), '..', 'home', 'workflows');
const META_PREFIX = /export\s+const\s+meta\s*=\s*/;

/** @returns {string[]} the paths of every script in home/workflows, probe files included */
export const scriptFiles = () => readdirSync(WORKFLOWS).filter((name) => name.endsWith('.js')).sort().map((name) => join(WORKFLOWS, name));

/**
 * The text of the `{...}` literal after `export const meta =`, found by brace matching that skips quoted text.
 * @returns {{ literal: string, end: number } | null}
 */
function metaLiteral(source) {
  const found = META_PREFIX.exec(source);
  if (found === null) return null;
  const start = found.index + found[0].length;
  let depth = 0;
  let quote = null;
  for (let at = start; at < source.length; at += 1) {
    const char = source[at];
    if (quote !== null) {
      if (char === '\\') at += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return { literal: source.slice(start, at + 1), end: at + 1 };
  }
  return null;
}

/**
 * Reads `meta` the way the tool does: as a literal with nothing to look up, so a variable, a call or a template substitution throws.
 * @param {string} source the script text
 * @returns {{ meta: object, end: number, rest: string }} the meta object, where it ends and the text after the literal
 */
export function readMeta(source) {
  const found = metaLiteral(source);
  if (found === null) throw new Error('no `export const meta = {...}` literal');
  const bare = vm.createContext(Object.create(null)); // no globals at all: not even JSON or Math
  const meta = vm.runInContext(`(${found.literal})`, bare);
  return { meta: JSON.parse(JSON.stringify(meta)), end: found.end, rest: source.slice(found.end) };
}

const FORBIDDEN_CLOCKS = `
  Math.random = () => { throw new Error('Math.random() is not available in a workflow script'); };
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...parts) { if (parts.length === 0) throw new Error('new Date() with no argument is not available in a workflow script'); super(...parts); }
    static now() { throw new Error('Date.now() is not available in a workflow script'); }
  };`;

const matches = (rule, label) => (typeof rule === 'function' ? rule(label) : rule.test(label));

/**
 * Runs one script with scripted agents.
 * @param {string} path the script file
 * @param {unknown} args the value of the script's `args` global
 * @param {{ replies?: { match: RegExp | ((label: string) => boolean), reply: unknown }[], children?: Record<string, Function | string>, depth?: number }} [setup]
 * @returns {Promise<{ result: unknown, error: Error | null, calls: object[], started: string[] }>}
 */
export async function runScript(path, args, { replies = [], children = {}, depth = 0 } = {}) {
  const source = readFileSync(path, 'utf8');
  const { end } = readMeta(source);
  const body = source.slice(end).replace(/^[;\s]*\n/, '');
  const calls = [];
  const outside = (value) => JSON.parse(JSON.stringify(value ?? null)); // objects made inside the context compare equal to plain ones
  const sandbox = {
    args,
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    log: () => {},
    phase: () => {},
    agent: async (prompt, opts = {}) => {
      const call = { order: calls.length, label: opts.label ?? '', prompt, opts: outside(opts) };
      calls.push(call);
      const rule = replies.find((candidate) => matches(candidate.match, call.label));
      if (rule === undefined) throw new Error(`no scripted reply for agent "${call.label}"`);
      return typeof rule.reply === 'function' ? rule.reply(prompt, call.opts, call) : rule.reply;
    },
    pipeline: async (items, ...stages) => Promise.all(items.map(async (item, index) => {
      try {
        let value = item;
        for (const stage of stages) value = await stage(value, item, index);
        return value;
      } catch {
        return null; // a stage that throws drops its item, as in the tool
      }
    })),
    parallel: async (thunks) => Promise.all(thunks.map(async (thunk) => {
      try {
        return await thunk();
      } catch {
        return null;
      }
    })),
    workflow: async (ref, childArgs) => {
      if (depth > 0) throw new Error('workflow() inside a child workflow is not allowed (one level only)');
      const name = typeof ref === 'string' ? ref : basename(ref.scriptPath, '.js');
      const child = children[name];
      if (child === undefined) throw new Error(`no scripted child workflow "${name}"`);
      calls.push({ order: calls.length, label: `workflow:${name}`, prompt: '', opts: {}, workflow: name, args: outside(childArgs) });
      if (typeof child === 'function') return child(childArgs);
      const run = await runScript(child, childArgs, { replies, children, depth: depth + 1 });
      calls.push(...run.calls);
      if (run.error !== null) throw run.error;
      return run.result;
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(FORBIDDEN_CLOCKS, context);
  try {
    const result = await vm.runInContext(`(async () => {\n${body}\n})()`, context, { filename: path });
    return { result: outside(result), error: null, calls, started: calls.map((call) => call.label) };
  } catch (error) {
    return { result: null, error, calls, started: calls.map((call) => call.label) };
  }
}

/**
 * Throws unless every recorded agent call is well formed for the workflow's contract: label `<row>:<step>`, a phase named in meta,
 * and a model and effort (every step names both, so no step silently inherits the lead's).
 * @param {object[]} calls `calls` of runScript (workflow-child entries are skipped)
 * @param {string} row the STATUS row the labels must start with
 * @param {{ phases?: { title: string }[] }} meta the script's meta
 */
export function assertWellFormedCalls(calls, row, meta) {
  const titles = (meta.phases ?? []).map((phase) => phase.title);
  for (const { label, opts, workflow } of calls) {
    if (workflow !== undefined) continue;
    if (!label.startsWith(`${row}:`) || label.length === row.length + 1) throw new Error(`label "${label}" does not start with "${row}:<step>"`);
    if (!titles.includes(opts.phase)) throw new Error(`"${label}": phase ${JSON.stringify(opts.phase)} is not in meta.phases (${titles.join(', ')})`);
    if (!opts.model || !opts.effort) throw new Error(`"${label}": model and effort must both be named`);
  }
}
