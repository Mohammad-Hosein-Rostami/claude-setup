// Purpose: the `long-run view` page: polls /api/runs (runsData() of web-data.mjs) every 2 s and draws each run's job as a flow of
//   boxes (one per step, a parallel group as a row of item boxes), its hold, warnings and last events.
// Exports: none (a page script).
// Invariants: every value from a run is set with textContent, never as HTML (reasons, questions and event details are
//   model-written); one poll in flight at a time (the next starts 2 s after the last answer); a failed poll shows the lost-server
//   banner and polling goes on; `#<run>` in the URL shows that run only; times are shown in the browser's local time.
'use strict';

const REFRESH_MS = 2000; // the rate of `long-run live`
const MS_PER_MINUTE = 60 * 1000;
const FINISHED = new Set(['done', 'abandoned']); // hidden until "Show finished runs" (the rule `live` uses)
// State word -> colour family (view.css `.s-*`); any other word gets the plain outline and its own text. Maps, because the state
// word comes from the run files and must not find an Object property such as `constructor`.
const STATE_STYLES = new Map(Object.entries({
  running: 's-running', done: 's-done', failed: 's-bad', stopped: 's-bad', 'waiting-retry': 's-wait', 'waiting-limit': 's-wait',
  held: 's-owner', 'needs-owner': 's-owner', blocked: 's-owner', guard: 's-owner', paused: 's-quiet', 'taken-over': 's-quiet',
}));
const WAIT_WORDS = new Map([['waiting-retry', 'retries at'], ['waiting-limit', 'resets at']]);
const WHEN = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

let latest = null; // the last answer of /api/runs
let lastUpdate = null; // when it came, as a Date

/** A new element with a class and text (textContent: run values are never read as HTML). */
function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const when = (iso) => (iso ? WHEN.format(new Date(iso)) : '-');
const minutesBetween = (fromIso, toIso) => Math.max(0, Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / MS_PER_MINUTE));

/** `(in N min)`, `(in <1 min)` or `(due)` from `nowIso` until `iso` (as `live` writes it). */
function countdown(iso, nowIso) {
  const ms = Date.parse(iso) - Date.parse(nowIso);
  if (ms <= 0) return '(due)';
  if (ms < MS_PER_MINUTE) return '(in <1 min)';
  return `(in ${Math.floor(ms / MS_PER_MINUTE)} min)`;
}

/** The detail parts of one step box. */
function stepDetails(step, session, state, nowIso) {
  const until = session?.until ?? step.waitUntil;
  const ran = state === 'running' && session?.since ? `running ${minutesBetween(session.since, nowIso)} min` : step.wallMs > 0 ? `ran ${Math.round(step.wallMs / MS_PER_MINUTE)} min` : '';
  return [
    `starts ${step.starts}`, step.attempts > 0 ? `attempts ${step.attempts}` : '', step.startedAt ? `started ${when(step.startedAt)}` : '', ran,
    WAIT_WORDS.has(state) && until ? `${WAIT_WORDS.get(state)} ${when(until)} ${countdown(until, nowIso)}` : '',
    step.question ? 'question waits' : step.reason ?? '',
  ].filter(Boolean);
}

/** The head line of a box: its label and its state word. */
function boxHead(label, state) {
  const head = el('div', 'box-head');
  head.append(el('span', 'label', label), el('span', 'state', state));
  return head;
}

/** One box for a step or a group item; a limit or retry wait shows only on the session, so the box takes the session's state. */
function stepBox(view, step, nowIso) {
  const session = view.sessions.find((one) => one.step === step.id);
  const state = session?.state ?? step.status;
  const box = el('div', `box ${STATE_STYLES.get(state) ?? ''}`);
  box.append(boxHead(step.group ? `${step.group}/${step.id}` : step.id, state), el('p', 'details', stepDetails(step, session, state, nowIso).join(' · ')));
  return box;
}

/** The `next` routes of a job entry as chips, e.g. `failed -> fix`. */
function chips(next) {
  const row = el('div', 'chips');
  for (const [status, target] of Object.entries(next)) row.append(el('span', 'chip', `${status} -> ${target}`));
  return row;
}

/** The box of one job entry: a step box, or a group box holding its item boxes in a row. */
function entryBox(view, entry, nowIso) {
  let box;
  if (entry.kind === 'group') {
    box = el('div', 'box group');
    box.append(boxHead(entry.id, 'parallel group'));
    const items = el('div', 'items');
    for (const item of entry.items) {
      const step = view.steps.find((one) => one.group === entry.id && one.id === item);
      if (step) items.append(stepBox(view, step, nowIso));
    }
    box.append(items);
  } else {
    const step = view.steps.find((one) => one.id === entry.id && !one.group);
    box = step ? stepBox(view, step, nowIso) : el('div', 'box', entry.id);
  }
  if (Object.keys(entry.next).length > 0) box.append(chips(entry.next));
  return box;
}

/** The flow: the job's entries top to bottom with a down arrow between them. */
function flowOf(run, nowIso) {
  const flow = el('div', 'flow');
  run.flow.forEach((entry, index) => {
    if (index > 0) {
      const arrow = el('div', 'arrow', '↓');
      arrow.setAttribute('aria-hidden', 'true'); // the order of the boxes already says it
      flow.append(arrow);
    }
    flow.append(entryBox(run.view, entry, nowIso));
  });
  return flow;
}

/** The last events, newest first: local time, step, event, detail. */
function eventsTable(events) {
  const wrap = el('div', 'events');
  const table = el('table');
  const head = el('tr');
  for (const name of ['Time', 'Step', 'Event', 'Detail']) head.append(el('th', '', name));
  table.append(el('thead'), el('tbody'));
  table.tHead.append(head);
  for (const event of [...events].reverse()) {
    const row = el('tr');
    row.append(el('td', '', when(event.t)), el('td', '', event.step ?? '-'), el('td', '', event.event ?? '-'), el('td', 'detail', event.detail ?? ''));
    table.tBodies[0].append(row);
  }
  wrap.append(table);
  return wrap;
}

/** The title line of a run: `run id - state - account - n/m done`. */
function runTitle(view) {
  const done = view.steps.filter((step) => step.status === 'done').length;
  const title = el('h2');
  title.append(`${view.runId} - `, el('span', `run-state ${STATE_STYLES.get(view.state) ?? ''}`, view.state), ` - ${view.account ?? '-'} - ${done}/${view.steps.length} done`);
  return title;
}

/** One run's card, or its error card when its files could not be read. */
function runCard(run, nowIso) {
  const card = el('section', 'run');
  if (run.error) {
    card.append(el('h2', '', `${run.runId} - unreadable`), el('p', 'warning', run.error));
    return card;
  }
  const { view } = run;
  card.append(runTitle(view));
  if (view.warnings.length > 0) {
    const list = el('ul', 'warning');
    for (const line of view.warnings) list.append(el('li', '', line));
    card.append(list);
  }
  if (view.hold) card.append(el('p', 'hold', `Held at ${view.hold.stepId}: ${view.hold.status}${view.hold.question ? ` - ${view.hold.question}` : ''}`));
  card.append(flowOf(run, nowIso));
  if (run.events.length > 0) card.append(el('h3', '', 'Recent events'), eventsTable(run.events));
  return card;
}

/** The runs to draw and the line to show when there are none. */
function shownRuns(runs) {
  const wanted = location.hash.slice(1); // a run id is plain [a-z0-9-], so no decoding
  if (wanted) return { shown: runs.filter((run) => run.runId === wanted), empty: `Run ${wanted} is not among the newest runs.` };
  if (runs.length === 0) return { shown: [], empty: 'No runs yet. Start one with long-run start <job.json>.' };
  const showFinished = document.getElementById('show-finished').checked;
  return { shown: runs.filter((run) => showFinished || run.error || !FINISHED.has(run.view.state)), empty: 'No live runs. Tick Show finished runs to see the others.' };
}

/** Draws the page from the last answer. */
function render() {
  document.getElementById('all-runs').hidden = location.hash.length <= 1;
  if (!latest) return;
  const { shown, empty } = shownRuns(latest.runs);
  const main = document.getElementById('runs');
  main.replaceChildren(...(shown.length > 0 ? shown.map((run) => runCard(run, latest.now)) : [el('p', 'muted', empty)]));
}

/** One poll; the next one starts REFRESH_MS after this one answered or failed. */
async function poll() {
  const lost = document.getElementById('lost');
  try {
    const response = await fetch('/api/runs', { cache: 'no-store' });
    const answer = await response.json();
    if (!response.ok) throw new Error(answer.error ?? `status ${response.status}`);
    latest = answer;
    lastUpdate = new Date();
    lost.hidden = true;
    document.getElementById('updated').textContent = `Last update ${CLOCK.format(lastUpdate)}`;
    render();
  } catch {
    // The server is gone or failed this once: say so and keep polling, so the page recovers when it answers again.
    lost.textContent = `The view server stopped (last update ${lastUpdate ? CLOCK.format(lastUpdate) : '-'}). Run long-run view again.`;
    lost.hidden = false;
  } finally {
    setTimeout(poll, REFRESH_MS);
  }
}

document.getElementById('show-finished').addEventListener('change', render);
window.addEventListener('hashchange', render);
render();
poll();
