// Purpose: the LangGraph of a run (spec 7.1): one node per step, a fan / item / join trio per parallel group (`Send`), a hold node
//   per step that asks the owner (`interrupt`), `next` routing with visit guards (M8), the SQLite checkpointer, and the reads the
//   CLI needs (the open hold, the checkpoint a re-run starts from, M9).
// Exports: nodeOf, buildGraph, graphConfig, openHold, rerunPoint, holdEventOf.
// Invariants: node names are `<kind>/<id>` (LangGraph 1.7 reserves `:` and `|` in node names, so the spec's `step:<id>` is written
//   `step/<id>`); a hold node does nothing but `interrupt()` (it restarts from its first line on resume); a step node is safe to run
//   again after a crash (runUnit reads its journal); a target whose visits reached `maxVisits` is held with a loop-guard reason, never
//   run again without the owner; durability is "sync", so every finished node is on disk before the next starts.
import { Annotation, END, START, Send, StateGraph, interrupt } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { readJournal, writeJournal } from './run-store.mjs';
import { runUnit } from './step.mjs';
import { gitHead } from './step-start.mjs';

const RECURSION_PER_UNIT = 12;
const RECURSION_EXTRA = 10;
const DONE_ORDER = ['taken-over', 'paused', 'needs-owner', 'blocked', 'failed'];
const HOLD_EVENTS = { 'needs-owner': 'needs-owner', blocked: 'blocked', paused: 'paused', 'taken-over': 'taken-over' };

const mergeById = (left, right) => ({ ...left, ...right });
function addVisits(left, right) {
  const sum = { ...left };
  for (const [unitId, count] of Object.entries(right)) sum[unitId] = (sum[unitId] ?? 0) + count;
  return sum;
}
const State = Annotation.Root({
  steps: Annotation({ reducer: mergeById, default: () => ({}) }),
  visits: Annotation({ reducer: addVisits, default: () => ({}) }),
  hold: Annotation({ reducer: (left, right) => right, default: () => null }),
});

/** The node that starts step `entry`: `step/<id>` or, for a group, `fan/<id>`. */
export const nodeOf = (entry) => `${entry.kind === 'group' ? 'fan' : 'step'}/${entry.id}`;

/** The event a hold of this status gets in events.log, or null when the step's own outcome event says it. */
export const holdEventOf = (status) => HOLD_EVENTS[status] ?? null;

function routeTo(job, target) {
  if (target === 'end') return END;
  return nodeOf(job.steps.find((entry) => entry.id === target));
}

/** Where an outcome of `entry` goes (spec 6 `next`, 7.1). */
function outcomeRoute(job, entry, status) {
  if (['paused', 'taken-over', 'guard'].includes(status)) return `hold/${entry.id}`;
  const index = job.steps.indexOf(entry);
  const following = job.steps[index + 1] ? job.steps[index + 1].id : 'end';
  const target = entry.next[status] ?? (status === 'done' ? following : null);
  return target === null ? `hold/${entry.id}` : routeTo(job, target);
}

/** The visit this entry of a node is, or a guard outcome when the visits are used up. */
function visitFor(state, entry) {
  const reply = state.hold?.stepId === entry.id ? state.hold : null;
  const current = state.visits[entry.id] ?? 0;
  if (reply) return { reply, visit: Math.max(current, 1), added: 0 };
  if (current >= entry.maxVisits) return { guard: { status: 'guard', reason: `loop guard: visited ${current} times` } };
  return { reply: null, visit: current + 1, added: 1 };
}

function stepNode(ctx, entry) {
  return async (state) => {
    const slot = visitFor(state, entry);
    if (slot.guard) return { steps: { [entry.id]: slot.guard }, hold: null };
    const outcome = await runUnit(ctx, { ...entry, group: null }, { visit: slot.visit, reply: slot.reply });
    return { steps: { [entry.id]: { ...outcome, visit: slot.visit } }, visits: { [entry.id]: slot.added }, hold: null };
  };
}

function fanNode(ctx, entry) {
  return async (state) => {
    const slot = visitFor(state, entry);
    if (slot.guard) return { steps: { [entry.id]: slot.guard }, hold: null };
    const saved = readJournal(ctx.paths, entry.id);
    if (saved?.visit !== slot.visit) writeJournal(ctx.paths, entry.id, { id: entry.id, kind: 'group', visit: slot.visit, base: gitHead(entry.cwd), startedAt: ctx.now().toISOString() });
    return { steps: { [entry.id]: { status: 'running', visit: slot.visit } }, visits: { [entry.id]: slot.added } };
  };
}

const itemDone = (state, itemId, visit) => state.steps[itemId]?.visit === visit && state.steps[itemId]?.status === 'done';

function fanRoute(entry) {
  return (state) => {
    const group = state.steps[entry.id];
    if (group.status === 'guard') return `hold/${entry.id}`;
    const reply = state.hold?.stepId === entry.id ? state.hold : null;
    const open = entry.items.filter((one) => !itemDone(state, one.id, group.visit));
    if (open.length === 0) return `join/${entry.id}`;
    return open.map((one) => new Send(`item/${entry.id}`, {
      itemId: one.id, visit: group.visit, reply: reply && (reply.item === null || reply.item === one.id) ? reply : reply && { ...reply, action: 'continue', text: null },
    }));
  };
}

function itemNode(ctx, entry) {
  return async ({ itemId, visit, reply }) => {
    const item = entry.items.find((one) => one.id === itemId);
    const outcome = await runUnit(ctx, { ...item, kind: 'item', group: entry }, { visit, reply });
    return { steps: { [itemId]: { ...outcome, visit } } };
  };
}

function joinNode(ctx, entry) {
  return async (state) => {
    const { visit } = state.steps[entry.id];
    const items = entry.items.map((one) => ({ id: one.id, ...state.steps[one.id] }));
    const open = items.filter((one) => !itemDone(state, one.id, visit));
    const status = open.length === 0 ? 'done' : DONE_ORDER.find((kind) => open.some((one) => one.status === kind)) ?? 'failed';
    const listed = open.map(({ id, status: itemStatus, reason, question }) => ({ id, status: itemStatus, reason, question }));
    if (status === 'done') ctx.emit(entry.id, { status });
    return { steps: { [entry.id]: { status, visit, items: listed } }, hold: null };
  };
}

function holdNode(ctx, entry) {
  return async (state) => {
    const outcome = state.steps[entry.id];
    const reply = interrupt({ runId: ctx.runId, stepId: entry.id, status: outcome.status, reason: outcome.reason ?? null, question: outcome.question ?? null, items: outcome.items ?? null });
    if (reply.action === 'skip') return { steps: { [entry.id]: { ...outcome, status: 'skipped' } }, hold: null };
    if (reply.action === 'abandon') return { steps: { [entry.id]: { ...outcome, status: 'abandoned' } }, hold: null };
    return { hold: { ...reply, stepId: entry.id } };
  };
}

function holdRoute(job, entry) {
  return (state) => {
    const { status } = state.steps[entry.id];
    if (status === 'abandoned') return END;
    if (status === 'skipped') return outcomeRoute(job, entry, 'done');
    return nodeOf(entry);
  };
}

function addEntry(graph, ctx, entry, targets) {
  if (entry.kind === 'group') {
    graph.addNode(`fan/${entry.id}`, fanNode(ctx, entry)).addNode(`item/${entry.id}`, itemNode(ctx, entry)).addNode(`join/${entry.id}`, joinNode(ctx, entry));
    graph.addConditionalEdges(`fan/${entry.id}`, fanRoute(entry), [`item/${entry.id}`, `join/${entry.id}`, `hold/${entry.id}`]);
    graph.addEdge(`item/${entry.id}`, `join/${entry.id}`);
    graph.addConditionalEdges(`join/${entry.id}`, (state) => outcomeRoute(ctx.job, entry, state.steps[entry.id].status), targets);
  } else {
    graph.addNode(`step/${entry.id}`, stepNode(ctx, entry));
    graph.addConditionalEdges(`step/${entry.id}`, (state) => outcomeRoute(ctx.job, entry, state.steps[entry.id].status), targets);
  }
  graph.addNode(`hold/${entry.id}`, holdNode(ctx, entry));
  graph.addConditionalEdges(`hold/${entry.id}`, holdRoute(ctx.job, entry), targets);
}

/**
 * Builds and compiles the graph of the run's job.
 * @param {object} ctx the run context (driver.mjs): job, paths, runId and what runUnit needs.
 * @returns {object} the compiled graph with the run's SQLite checkpointer.
 */
export function buildGraph(ctx) {
  const graph = new StateGraph(State);
  const targets = [...ctx.job.steps.flatMap((entry) => [nodeOf(entry), `hold/${entry.id}`]), END];
  for (const entry of ctx.job.steps) addEntry(graph, ctx, entry, targets);
  graph.addEdge(START, nodeOf(ctx.job.steps[0]));
  return graph.compile({ checkpointer: SqliteSaver.fromConnString(ctx.paths.checkpoints) });
}

/** The invoke config of a run (spec 7.1): thread = run id, sync durability, a recursion limit from the job's size. */
export function graphConfig(job, runId, maxParallel = job.maxParallel) {
  const unitCount = job.steps.reduce((sum, entry) => sum + 1 + (entry.items?.length ?? 0), 0);
  return { configurable: { thread_id: runId }, durability: 'sync', recursionLimit: RECURSION_PER_UNIT * unitCount + RECURSION_EXTRA, maxConcurrency: maxParallel };
}

/**
 * @param {object} app the compiled graph.
 * @param {string} runId the run.
 * @returns {Promise<{hold: object | null, fresh: boolean, finished: boolean, values: object}>} the open hold's payload, whether the
 *   run has no checkpoint yet, and whether it reached the end.
 */
export async function openHold(app, runId) {
  const snapshot = await app.getState({ configurable: { thread_id: runId } });
  const fresh = snapshot.config?.configurable?.checkpoint_id === undefined;
  const hold = snapshot.tasks.flatMap((task) => task.interrupts ?? []).map((one) => one.value)[0] ?? null;
  return { hold, fresh, finished: !fresh && snapshot.next.length === 0, values: snapshot.values };
}

/**
 * The newest checkpoint from which step `stepId` runs next (M9; the history is filtered here, langgraphjs #3104).
 * @returns {Promise<{config: object, values: object} | null>}
 */
export async function rerunPoint(app, runId, entry) {
  for await (const snapshot of app.getStateHistory({ configurable: { thread_id: runId } })) {
    if (snapshot.next.includes(nodeOf(entry))) return { config: snapshot.config, values: snapshot.values };
  }
  return null;
}
