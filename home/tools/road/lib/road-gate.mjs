// Purpose: the checkpoint between steps (spec-stages section 5): one PASS, FAIL or INFO line per check, a FAIL on any line fails it.
// Exports: gateStep(road, items, step, run, { isUiPath }) -> { lines, pass }, GIT_TIMEOUT_MS, TOOL_TIMEOUT_MS.
// `run(file, argv, timeoutMs)` -> { exit, out } runs one program with argv (no shell); `file` is one of 'git', 'git-tidy', 'ui-proof'
//   (the CLI maps them to the tools), so tests inject it. Every git call names shas with fixed flags (P2).
// Lines: 1 rows done (no lanes landed and none carried = FAIL; an open UI lane = FAIL, never carried; a carried lane a later lane needs =
//   FAIL); 2 landing ranges of every close row of the road (`landed <to> on <base> from <from>`: `git cherry` empty, `<to>` new in this road,
//   no repeat, `<from>` the road-start tip or another row's `<to>`, both on the base's first-parent line, ranges disjoint, every commit of
//   `<start>..<tip>` in exactly one range; a done close row with no landed line of its own takes the line of a done `<close row id>.landed`
//   row (for an id ending in `-land` also `<id without -land>.landed`; both present = FAIL), never used when the close row has its own line
//   or is not done);
//   a FIX row (no road entry) whose done `<close row id>.landed` row says `landed within <other close row id>` (at the start of the evidence
//   or after "; ") gets no range of its own: the named row must be another close row of the road with a valid range of its own (no self, no
//   chain), and the coverage check of this line shows no unlanded commit is hidden. The text takes no `as <sha>` (a fix row has no one
//   sha for its work; any `as` part is a FAIL, never ignored). A road lane (any entry) never lands within another row:
//   lanes land one at a time, each in its own fast-forward, so it needs its own range (its own line or its `.landed` correction) and a
//   `landed within` row of a lane is a FAIL naming the row; this also leaves no stacked-lane case to prove;
//   3 `git-tidy check` exit 0; 4 UI: when a range of the step changes UI files or a lane has a matrix, `ui-proof check --tip <tip>
//   --against-step <road>.s<N>` exit 0 and the step-start record taken at or before every `<from>` (UI checks always run, owner
//   decision CR5); 5 the measure (INFO). No test, review or audit line: the gate asks that every lane of the step landed, cleanly.
// Invariants: any exit other than the expected ones is FAIL (fail closed, P3); untrusted shas from rows are hex-checked before argv, then
//   resolved once to the full commit sha (`rev-parse --verify --quiet <sha>^{commit}`; unknown or ambiguous = FAIL naming the row, and so is
//   an answer that does not start with the row's hex, which is what a branch or tag named like hex gives), and only full shas are compared
//   or passed on afterwards (a row may hold 7-40 hex, rev-list prints 40).
import { rowIds } from './road-file.mjs';
import { isUiLane, landedLine, roadStartTip } from './road-state.mjs';

export const GIT_TIMEOUT_MS = 5_000;
export const TOOL_TIMEOUT_MS = 30_000;
const HEX = /^[0-9a-f]{7,40}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
// Anchored: `never landed within X` or `done, landed within X` is not a within row. `as` is captured only to refuse it.
const WITHIN = /^(?:.*; )?landed within ([\w.-]*[\w-])(\s+as\b)?/;
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

const LAND_SUFFIX = '-land';

/**
 * The correction rows of a close row: `<id>.landed`, and for an id ending in `-land` also `<id without -land>.landed` (row ids are at most
 * 40 characters, so the long form may not fit). Both lookups are case-insensitive; the rows found are returned in that order.
 */
function correctionRows(rows, id) {
  const low = id.toLowerCase();
  const ids = [`${low}.landed`];
  if (low.endsWith(LAND_SUFFIX)) ids.push(`${low.slice(0, -LAND_SUFFIX.length)}.landed`);
  return ids.map((key) => rows.get(key)).filter((found) => found !== undefined);
}

/** The one done correction row of a close row, or null: none, not done, or two of them (`ambiguousCorrection` reports that case). */
function correctionRow(rows, row) {
  const found = correctionRows(rows, row.id);
  return found.length === 1 && found[0].done != null ? found[0] : null;
}

/** The ids of both correction rows when a close row without a landed line of its own has one under each id, else null. */
function ambiguousCorrection(rows, row) {
  if (landedLine(row.evidence) !== null) return null;
  const found = correctionRows(rows, row.id);
  return found.length === 2 ? found.map((correction) => correction.id) : null;
}

/**
 * The landed line of a done close row: its own evidence, else the evidence of its done correction row (STATUS done cells are never
 * changed, so a close row marked done without the line is corrected by that row). Both are parsed by landedLine, so the same hex checks apply.
 */
function landedOfCloseRow(rows, row) {
  const own = landedLine(row.evidence);
  if (own !== null) return own;
  const correction = correctionRow(rows, row);
  return correction === null ? null : landedLine(correction.evidence);
}

/**
 * `{ id, hasAs }` of a done correction row that says `landed within <close row id>` (`hasAs` when an `as` part follows, which the gate
 * refuses), or null. It applies only to a done close row with no landed line, and only when the correction row has no landed line either:
 * such a close row landed inside the fast-forward of the named one (one range for both) and carries no range of its own.
 */
function withinOfCloseRow(rows, row) {
  if (landedLine(row.evidence) !== null) return null;
  const correction = correctionRow(rows, row);
  if (correction === null || landedLine(correction.evidence) !== null) return null;
  const match = WITHIN.exec(String(correction.evidence ?? '').trim());
  return match === null ? null : { id: match[1], hasAs: match[2] !== undefined };
}

const closeRange = (rows, row, entry) => ({ entry, row: row.id, landed: landedOfCloseRow(rows, row), within: withinOfCloseRow(rows, row), both: ambiguousCorrection(rows, row), unknown: [] });

/** The done close rows of the road, as ranges (`landed` null when the row has no landed line; `within` `{ id, hasAs }` of the named close row or null; `both` the two correction row ids when it has two). */
function closeRanges(road, rows) {
  return laneEntries(road).flatMap((entry) => {
    const row = rows.get(entry.ids.close.toLowerCase());
    if (row?.done == null) return [];
    return [closeRange(rows, { ...row, id: entry.ids.close }, entry)];
  }).concat([...rows.values()].filter((row) => /\.s\d+\.fix-[a-z0-9-]+-land$/.test(row.id) && row.done != null && row.id.startsWith(`${road.road}.`))
    .map((row) => closeRange(rows, row, null)));
}

/** The full commit sha of a row's sha text (hex-checked, 7-40 characters), or null when git does not know it, finds it ambiguous, or answers with a commit it does not start with. */
function fullSha(run, repo, text) {
  const found = git(run, repo, ['rev-parse', '--verify', '--quiet', `${text}^{commit}`]);
  const sha = found.out.trim();
  // A branch or tag named like hex wins over a short sha in rev-parse: the answer must still start with what the row wrote.
  return found.exit === 0 && FULL_SHA.test(sha) && sha.startsWith(text.toLowerCase()) ? sha : null;
}

/**
 * The range with every sha taken from its rows (`to` and `from`) resolved to its full sha, once. A sha git
 * cannot resolve stays as written and adds a FAIL text to `unknown`, naming the row; a text that is not hex is left for rangeRowFails.
 */
function resolveRange(run, ctx, range) {
  const unknown = [];
  const resolve = (text, owner, what) => {
    if (text === null || !HEX.test(text)) return text;
    const sha = fullSha(run, ctx.repo, text);
    if (sha === null) unknown.push(`2 range: ${owner} cites ${text} as ${what}, which is not one known commit of the repo (unknown or ambiguous)`);
    return sha ?? text;
  };
  const landed = range.landed === null ? null : { ...range.landed, to: resolve(range.landed.to, range.row, 'to'), from: resolve(range.landed.from, range.row, 'from') };
  return { ...range, landed, unknown };
}

/** Per-row checks of line 2 of a row with its own range; returns the FAIL texts. */
function rangeRowFails(run, ctx, range, seenTo) {
  const { repo, base, start, firstParent } = ctx;
  if (range.both !== null) return [`2 range: ${range.row} has a correction row under both ids (${range.both.join(' and ')}); keep one`];
  if (range.unknown.length > 0) return range.unknown;
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
  return fails;
}

const namedRange = (ranges, range) => ranges.find((other) => other.row.toLowerCase() === range.within.id.toLowerCase());

/**
 * The checks of a `landed within` row that the named row's own checks do not cover. Only a fix row may land within another row: a road lane
 * (an entry) lands alone, so it needs its own range. An `as` part is refused for both, since nothing reads the sha it names.
 */
function withinRowFails(range) {
  const said = `2 range: ${range.row} says "landed within ${range.within.id}"`;
  if (range.entry !== null) return [`${said}: a road lane needs its own range; lanes land one at a time`];
  if (range.within.hasAs) return [`${said} with an "as" part: a fix row names no sha (the named row's range is the proof)`];
  return [];
}

/** The FAIL texts of the `landed within` rows: the named row is another close row of the road with a valid range of its own, never a chain. */
function withinFails(ranges, rowFails) {
  return ranges.filter((range) => range.within !== null).flatMap((range) => {
    const said = `2 range: ${range.row} says "landed within ${range.within.id}"`;
    const named = namedRange(ranges, range);
    if (range.within.id.toLowerCase() === range.row.toLowerCase()) return [`${said}: a row cannot name itself`];
    if (named === undefined) return [`${said}, but ${range.within.id} is not a done close row of this road`];
    if (named.within !== null) return [`${said}, but ${named.row} itself landed within ${named.within.id} (no chains)`];
    if (named.landed === null || rowFails.get(named).length > 0) return [`${said}, but ${named.row} has no valid range of its own`];
    return [];
  });
}

/** Line 2: every close row of the road, then the cover of `<start>..<tip>` by the ranges. */
function rangeLines(run, ranges, ctx) {
  const seenTo = new Set();
  const rowFails = new Map(ranges.map((range) => [range, range.within === null ? rangeRowFails(run, ctx, range, seenTo) : withinRowFails(range)]));
  const fails = [...rowFails.values()].flat().concat(withinFails(ranges, rowFails));
  const good = ranges.filter((range) => range.unknown.length === 0 && range.landed?.from && HEX.test(range.landed.from));
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

/** Line 4: UI proof for the tip when a range of the step changed UI files or a lane has a matrix. */
function uiLine(run, road, ranges, step, ctx) {
  const own = ranges.filter((range) => range.entry?.step === step && range.unknown.length === 0 && range.landed?.from);
  const matrix = road.steps[step - 1].lanes.some((lane) => typeof lane.matrix === 'string');
  const changed = own.map((range) => run('ui-proof', ['changed', '--from', range.landed.from, '--to', range.landed.to, '--repo', ctx.repo], TOOL_TIMEOUT_MS));
  if (changed.some((result) => result.exit !== 0 && result.exit !== 1)) return fail('4 ui: ui-proof changed could not answer');
  if (!matrix && changed.every((result) => result.exit === 0)) return pass('4 ui: no UI file changed in the step');
  const label = `${road.road}.s${step}`;
  const proof = run('ui-proof', ['check', '--tip', ctx.tip, '--against-step', label, '--repo', ctx.repo], TOOL_TIMEOUT_MS);
  if (proof.exit !== 0) return fail(`4 ui: ui-proof check --against-step ${label} exited ${proof.exit}`);
  const at = RECORD_AT.exec(run('ui-proof', ['has', '--step', label, '--repo', ctx.repo], TOOL_TIMEOUT_MS).out)?.[1];
  if (at === undefined || own.some((range) => isAncestor(run, ctx.repo, at, range.landed.from) !== 0)) return fail(`4 ui: the step-start record ${label} was not taken at or before every from`);
  return pass(`4 ui: visual-qa PASS at ${ctx.tip}, no state worse than ${label}`);
}

const exitLine = (n, name, result, okText) => (result.exit === 0 ? pass(`${n} ${name}: ${okText}`) : fail(`${n} ${name}: exit ${result.exit}: ${result.out.split('\n').find(Boolean) ?? ''}`.trim()));

/**
 * Runs the gate for one step.
 * @param {object} road a checked road
 * @param {object[]} items parseWorkItems(...).items
 * @param {number} step 1-based
 * @param {(file: string, argv: string[], timeoutMs: number) => { exit: number, out: string }} run
 * @param {{ isUiPath: (path: string) => boolean }} options the UI file test
 * @returns {{ lines: string[], pass: boolean }}
 */
export function gateStep(road, items, step, run, { isUiPath }) {
  const rows = new Map(items.map((item) => [item.id.toLowerCase(), item]));
  const start = roadStartTip(road, items);
  const tipRead = git(run, road.repo, ['rev-parse', '--verify', `refs/heads/${road.base}^{commit}`]);
  const tip = tipRead.out.trim();
  if (start === null || tipRead.exit !== 0 || !HEX.test(tip)) return { lines: [fail(`road start tip or base tip unreadable (run rows first; git exit ${tipRead.exit})`)], pass: false };
  const firstParentList = git(run, road.repo, ['rev-list', '--first-parent', `${start}..${tip}`]).out.split('\n').filter(Boolean);
  const ctx = { repo: road.repo, base: road.base, start, tip, firstParentList, firstParent: new Set(firstParentList) };
  const ranges = closeRanges(road, rows).map((range) => resolveRange(run, ctx, range));
  const lines = [
    ...rowsLine(road, rows, step, isUiPath),
    ...rangeLines(run, ranges, ctx),
    exitLine(3, 'one git line', run('git-tidy', ['check', road.repo, '--base', road.base], TOOL_TIMEOUT_MS), 'git-tidy check clean'),
    uiLine(run, road, ranges, step, ctx),
    `INFO 5 measure: ${road.steps[step - 1].measure ?? 'none named'}`,
  ];
  return { lines, pass: !lines.some((line) => line.startsWith('FAIL')) };
}
