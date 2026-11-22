// Purpose: the checkpoint between steps (spec-stages section 5): one PASS, FAIL, WARN or INFO line per check, a FAIL on any line fails it.
// Exports: gateStep(road, items, step, run, { isUiPath, checkOn }) -> { lines, pass }, GIT_TIMEOUT_MS, TOOL_TIMEOUT_MS.
// `run(file, argv, timeoutMs)` -> { exit, out } runs one program with argv (no shell); `file` is one of 'git', 'git-tidy', 'test-pass',
//   'audit-log', 'ui-proof' (the CLI maps them to the tools), so tests inject it. Every git call names shas with fixed flags (P2).
// Lines: 1 rows done (no lanes landed and none carried = FAIL; an open UI lane = FAIL, never carried; a carried lane a later lane needs =
//   FAIL); 2 landing ranges of every close row of the road (`landed <to> on <base> from <from>`: `git cherry` empty, `<to>` new in this road,
//   no repeat, `<from>` the road-start tip or another row's `<to>`, both on the base's first-parent line, ranges disjoint, every commit of
//   `<start>..<tip>` in exactly one range; a done close row with no landed line of its own takes the line of a done `<close row id>.landed`
//   row, never used when the close row has its own line or is not done; a steered step's lanes also need `reviewed <sha> clean` with every
//   commit of their range in that sha); 3 `git-tidy check` exit 0; 4 `test-pass check <tip> --suite` exit 0; 5 `audit-log gate --tip <tip>` exit 0; 6 UI: when a range of
//   the step changes UI files or a lane has a matrix, `ui-proof check --tip <tip> --against-step <road>.s<N>` exit 0 and the step-start
//   record taken at or before every `<from>`; 7 the measure (INFO).
// Lines 4 (test), 5 and a steered step's `reviewed` line (review) and 6 (ui) are checks: each runs only when `checkOn(category)` says the
//   owner turned it on with /check (spec r9-checks-off); off, the line is `INFO <n> <name>: not checked: <category> off`.
// Invariants: any exit other than the expected ones is FAIL (fail closed, P3); untrusted shas from rows are hex-checked before argv.
import { rowIds } from './road-file.mjs';
import { isUiLane, landedLine, reviewedLine, roadStartTip } from './road-state.mjs';

export const GIT_TIMEOUT_MS = 5_000;
export const TOOL_TIMEOUT_MS = 30_000;
const HEX = /^[0-9a-f]{7,40}$/;
const RECORD_AT = /\bat ([0-9a-f]{7,40})\b/;

const pass = (text) => `PASS ${text}`;
const fail = (text) => `FAIL ${text}`;

function laneEntries(road) {
  return road.steps.flatMap((step, at) => step.lanes.map((lane) => ({ lane, step: at + 1, ids: rowIds(road.road, at + 1, lane.name) })));
}

/** Line 1: the step's rows. */
function rowsLine(road, rows, step, isUiPath) {
  const entries = laneEntries(road);
  const own = entries.filter((entry) => entry.step === step);
  const open = own.filter((entry) => rows.get(entry.ids.close.toLowerCase())?.done == null);
  const landed = own.length - open.length;
  if (landed === 0) return [fail('1 rows: no lane of the step landed')];
  const lines = [];
  for (const entry of open) {
    if (isUiLane(entry.lane, isUiPath)) lines.push(fail(`1 rows: ${entry.lane.name} lists a UI file or a matrix and is open: a UI lane is never carried`));
    else if (entries.some((later) => later.step > step && (later.lane.needs ?? []).includes(entry.lane.name))) lines.push(fail(`1 rows: ${entry.lane.name} is open and a later lane needs it`));
    else lines.push(`INFO 1 rows: carried: ${entry.lane.name}`);
  }
  return lines.some((line) => line.startsWith('FAIL')) ? lines : [pass(`1 rows: ${landed} landed`), ...lines];
}

const git = (run, repo, args) => run('git', ['-C', repo, ...args], GIT_TIMEOUT_MS);
const isAncestor = (run, repo, a, b) => git(run, repo, ['merge-base', '--is-ancestor', a, b]).exit;

/**
 * The landed line of a done close row: its own evidence, else the evidence of a done `<close row id>.landed` row (STATUS done cells are
 * never changed, so a close row marked done without the line is corrected by that row). Both are parsed by landedLine, so the same hex checks apply.
 */
function landedOfCloseRow(rows, row) {
  const own = landedLine(row.evidence);
  if (own !== null) return own;
  const correction = rows.get(`${row.id}.landed`.toLowerCase());
  return correction?.done == null ? null : landedLine(correction.evidence);
}

/** The close rows of the road with a landed line, as ranges. */
function closeRanges(road, rows) {
  return laneEntries(road).flatMap((entry) => {
    const row = rows.get(entry.ids.close.toLowerCase());
    if (row?.done == null) return [];
    return [{ entry, row: entry.ids.close, landed: landedOfCloseRow(rows, row), reviewed: reviewedLine(rows.get(entry.ids.lane.toLowerCase())?.evidence) }];
  }).concat([...rows.values()].filter((row) => /\.s\d+\.fix-[a-z0-9-]+-land$/.test(row.id) && row.done != null && row.id.startsWith(`${road.road}.`))
    .map((row) => ({ entry: null, row: row.id, landed: landedOfCloseRow(rows, row), reviewed: null })));
}

/** Per-row checks of line 2; returns the FAIL texts. */
function rangeRowFails(run, ctx, range, seenTo) {
  const { repo, base, start, firstParent } = ctx;
  const { landed } = range;
  if (landed === null || !HEX.test(landed.to)) return [`2 range: ${range.row} has no "landed <to> on <base> from <from>" evidence`];
  if (landed.from === null || !HEX.test(landed.from)) return [`2 range: ${range.row} has no from`];
  const fails = [];
  if (seenTo.has(landed.to)) fails.push(`2 range: ${range.row} cites ${landed.to}, which another close row cites too`);
  seenTo.add(landed.to);
  const cherry = git(run, repo, ['cherry', base, landed.to]);
  if (cherry.exit !== 0) fails.push(`2 range: git cherry for ${range.row} exited ${cherry.exit}`);
  else if (/^\+/m.test(cherry.out)) fails.push(`2 range: ${range.row}: a patch of ${landed.to} is not on ${base}`);
  const newHere = isAncestor(run, repo, landed.to, start);
  if (newHere !== 1) fails.push(newHere === 0 ? `2 range: ${range.row}: ${landed.to} is an old base sha (at or before the road start)` : `2 range: ${range.row}: git exited ${newHere}`);
  if (!firstParent.has(landed.to) || (landed.from !== start && !firstParent.has(landed.from))) fails.push(`2 range: ${range.row}: ${landed.from}..${landed.to} is not on the base's first-parent line`);
  if (isAncestor(run, repo, landed.from, landed.to) !== 0) fails.push(`2 range: ${range.row}: ${landed.from} is not an ancestor of ${landed.to}`);
  if (range.entry !== null && ctx.steered(range.entry.step)) {
    if (range.reviewed === null) fails.push(`2 range: ${range.entry.ids.lane} has no "reviewed <sha> clean" line`);
    else if (range.reviewed === start) fails.push(`2 range: ${range.entry.ids.lane} names the road-start tip as reviewed`);
    else {
      const unreviewed = git(run, repo, ['cherry', range.reviewed, landed.to, landed.from]);
      const extra = unreviewed.out.split('\n').filter((line) => line.startsWith('+')).map((line) => line.slice(2));
      if (unreviewed.exit !== 0 || extra.length > 0) fails.push(`2 range: ${range.entry.lane.name}: ${extra.length > 0 ? `commit ${extra.join(', ')} is not in the reviewed ${range.reviewed}` : `git cherry exited ${unreviewed.exit}`}`);
    }
  }
  return fails;
}

/** Line 2: every close row of the road, then the cover of `<start>..<tip>` by the ranges. */
function rangeLines(run, road, rows, ctx) {
  const ranges = closeRanges(road, rows);
  const seenTo = new Set();
  const fails = ranges.flatMap((range) => rangeRowFails(run, ctx, range, seenTo));
  const good = ranges.filter((range) => range.landed?.from && HEX.test(range.landed.from));
  const tos = new Set(good.map((range) => range.landed.to));
  for (const range of good) if (range.landed.from !== ctx.start && !tos.has(range.landed.from)) fails.push(`2 range: ${range.row}: from ${range.landed.from} is neither the road-start tip nor another row's to`);
  const owner = new Map();
  for (const range of good) {
    const listed = git(run, ctx.repo, ['rev-list', '--first-parent', `${range.landed.from}..${range.landed.to}`]);
    for (const sha of listed.out.split('\n').filter(Boolean)) {
      if (owner.has(sha)) fails.push(`2 range: ${range.row} and ${owner.get(sha)} overlap at ${sha}`);
      owner.set(sha, range.row);
    }
  }
  for (const sha of ctx.firstParentList) if (!owner.has(sha)) fails.push(`2 range: commit ${sha} lies in no close row's range`);
  return fails.length === 0 ? [pass(`2 range: ${ranges.length} close rows, every commit in one range`)] : fails.map(fail);
}

/** Line 6: UI proof for the tip when a range of the step changed UI files or a lane has a matrix. */
function uiLine(run, road, rows, step, ctx) {
  const own = closeRanges(road, rows).filter((range) => range.entry?.step === step && range.landed?.from);
  const matrix = road.steps[step - 1].lanes.some((lane) => typeof lane.matrix === 'string');
  const changed = own.map((range) => run('ui-proof', ['changed', '--from', range.landed.from, '--to', range.landed.to, '--repo', ctx.repo], TOOL_TIMEOUT_MS));
  if (changed.some((result) => result.exit !== 0 && result.exit !== 1)) return fail('6 ui: ui-proof changed could not answer');
  if (!matrix && changed.every((result) => result.exit === 0)) return pass('6 ui: no UI file changed in the step');
  const label = `${road.road}.s${step}`;
  const proof = run('ui-proof', ['check', '--tip', ctx.tip, '--against-step', label, '--repo', ctx.repo], TOOL_TIMEOUT_MS);
  if (proof.exit !== 0) return fail(`6 ui: ui-proof check --against-step ${label} exited ${proof.exit}`);
  const at = RECORD_AT.exec(run('ui-proof', ['has', '--step', label, '--repo', ctx.repo], TOOL_TIMEOUT_MS).out)?.[1];
  if (at === undefined || own.some((range) => isAncestor(run, ctx.repo, at, range.landed.from) !== 0)) return fail(`6 ui: the step-start record ${label} was not taken at or before every from`);
  return pass(`6 ui: visual-qa PASS at ${ctx.tip}, no state worse than ${label}`);
}

const exitLine = (n, name, result, okText) => (result.exit === 0 ? pass(`${n} ${name}: ${okText}`) : fail(`${n} ${name}: exit ${result.exit}: ${result.out.split('\n').find(Boolean) ?? ''}`.trim()));

/**
 * Runs the gate for one step.
 * @param {object} road a checked road
 * @param {object[]} items parseWorkItems(...).items
 * @param {number} step 1-based
 * @param {(file: string, argv: string[], timeoutMs: number) => { exit: number, out: string }} run
 * @param {{ isUiPath: (path: string) => boolean, checkOn?: (category: string) => boolean }} options the UI file test, and the owner's /check switch (default: all off)
 * @returns {{ lines: string[], pass: boolean }}
 */
export function gateStep(road, items, step, run, { isUiPath, checkOn = () => false }) {
  const notChecked = (n, name, category) => `INFO ${n} ${name}: not checked: ${category} off`
  const rows = new Map(items.map((item) => [item.id.toLowerCase(), item]));
  const start = roadStartTip(road, items);
  const tipRead = git(run, road.repo, ['rev-parse', '--verify', `refs/heads/${road.base}^{commit}`]);
  const tip = tipRead.out.trim();
  if (start === null || tipRead.exit !== 0 || !HEX.test(tip)) return { lines: [fail(`road start tip or base tip unreadable (run rows first; git exit ${tipRead.exit})`)], pass: false };
  const firstParentList = git(run, road.repo, ['rev-list', '--first-parent', `${start}..${tip}`]).out.split('\n').filter(Boolean);
  const ctx = { repo: road.repo, base: road.base, start, tip, firstParentList, firstParent: new Set(firstParentList), steered: (n) => checkOn('review') && road.steps[n - 1]?.form === 'agents' };
  const lines = [
    ...rowsLine(road, rows, step, isUiPath),
    ...rangeLines(run, road, rows, ctx),
    exitLine(3, 'one git line', run('git-tidy', ['check', road.repo, '--base', road.base], TOOL_TIMEOUT_MS), 'git-tidy check clean'),
    !checkOn('test') ? notChecked(4, 'suite', 'test') : exitLine(4, 'suite', run('test-pass', ['check', tip, '--repo', road.repo, '--suite'], TOOL_TIMEOUT_MS), `PASS recorded for ${tip}`),
    !checkOn('review') ? notChecked(5, 'audits', 'review') : exitLine(5, 'audits', run('audit-log', ['gate', '--repo', road.repo, '--tip', tip], TOOL_TIMEOUT_MS), 'none open'),
    checkOn('ui') ? uiLine(run, road, rows, step, ctx) : notChecked(6, 'ui', 'ui'),
    `INFO 7 measure: ${road.steps[step - 1].measure ?? 'none named'}`,
  ];
  return { lines, pass: !lines.some((line) => line.startsWith('FAIL')) };
}
