// Purpose: the checkpoint between steps (spec-stages section 5): one PASS, FAIL or INFO line per check, a FAIL on any line fails it.
// Exports: gateStep(road, items, step, run, { isUiPath, otherRoads, statusFile, statusText, held }) -> { lines, pass }, fullSha(run, repo, text), GIT_TIMEOUT_MS,
//   TOOL_TIMEOUT_MS.
// `run(file, argv, timeoutMs)` -> { exit, out } runs one program with argv (no shell); `file` is one of 'git', 'git-tidy', 'ui-proof'
//   (the CLI maps them to the tools), so tests inject it. Every git call names shas with fixed flags (P2).
// Close row here means a landing row (road-state.mjs landingRowId): a lane's `<lane row>-land` row in an old-form road, else the lane row
//   itself (new form, one row per lane); a fix's `fix-<name>-land` row when it exists, else its `fix-<name>` row. A `rework:` row is never
//   a lane's landing row. Line 1 reads the landed rule of road-state.mjs laneLanded; the correction rows are road-state.mjs correctionRows.
// Lines: 1 rows done (no lanes landed and none carried = FAIL; an open UI lane = FAIL, never carried; a carried lane a later lane needs =
//   FAIL); 2 landing ranges of every close row of the road (`landed <to> on <base> from <from>`: `git cherry` empty, `<to>` new in this road,
//   no repeat, `<from>` the road-start tip or another row's `<to>`, both on the base's first-parent line, ranges disjoint, every commit of
//   `<start>..<tip>` in exactly one range; a done close row with no landed line of its own takes the line of its done correction row
//   (`<lane>-land.landed` or `<lane>.landed` for an old close row, `<id>.landed` for a new-form row; two = FAIL), never used when the
//   close row has its own line or is not done);
//   a FIX row (no road entry) whose done `<close row id>.landed` row says `landed within <other close row id>` (at the start of the evidence
//   or after "; ") gets no range of its own: the named row must be another close row of the road with a valid range of its own (no self, no
//   chain), and the coverage check of this line shows no unlanded commit is hidden. The text takes no `as <sha>` (a fix row has no one
//   sha for its work; any `as` part is a FAIL, never ignored). A road lane (any entry) never lands within another row:
//   lanes land one at a time, each in its own fast-forward, so it needs its own range (its own line or its `.landed` correction) and a
//   `landed within` row of a lane is a FAIL naming the row; this also leaves no stacked-lane case to prove. Two roads in one STATUS.md
//   (`otherRoads` of the same repo and base) land interleaved: the other roads' close ranges that end after this road's start get the
//   same per-row checks and count for the cover, the disjointness and the `<from>` rule (otherRanges), so a commit in no road's range
//   still FAILs;
//   3 `git-tidy check --json` exit 0; on exit 1 a `merged-branch`, `merged-worktree`, `superseded-copy` or `agent-leftover` finding of a
//   lane in flight (row started, not landed; this road or `otherRoads`, the road files beside STATUS.md) or of a worktree an open writer
//   holds (`held`) is INFO, any other finding FAIL (a leftover branch of a landed lane of this step included): road-gate-git.mjs gitLines;
//   4 UI: road-gate-ui.mjs uiLine (the landings' check plans, the web ui-proof path, or the terminal proof row of a terminal UI step);
//   5 the measure (INFO). No test, review or audit line: every lane of the step landed, cleanly.
// Invariants: any exit other than the expected ones is FAIL (fail closed, P3); untrusted shas from rows are hex-checked before argv, then
//   resolved once to the full commit sha (`rev-parse --verify --quiet <sha>^{commit}`; unknown or ambiguous = FAIL naming the row, and so is
//   an answer that does not start with the row's hex, which is what a branch or tag named like hex gives), and only full shas are compared
//   or passed on afterwards (a row may hold 7-40 hex, rev-list prints 40).
import { rowIds } from './road-file.mjs';
import { gitLines } from './road-gate-git.mjs';
import { uiLine } from './road-gate-ui.mjs';
import { correctionRows, isReworkRow, isUiLane, landedLine, laneLanded, landingRowId, roadStartTip } from './road-state.mjs';

export const GIT_TIMEOUT_MS = 5_000;
export const TOOL_TIMEOUT_MS = 30_000;
const HEX = /^[0-9a-f]{7,40}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
// Anchored: `never landed within X` or `done, landed within X` is not a within row. `as` is captured only to refuse it.
const WITHIN = /^(?:.*; )?landed within ([\w.-]*[\w-])(\s+as\b)?/;
// A fix row of `road.mjs rows --fix`: `fix-<name>` (new form, its own landing row) or `fix-<name>-land` (old form, the close row).
const FIX_ROW = /\.s(\d+)\.fix-[a-z0-9-]+$/; // group 1: the step the fix belongs to

const pass = (text) => `PASS ${text}`;
const fail = (text) => `FAIL ${text}`;

function laneEntries(road) {
  return road.steps.flatMap((step, at) => step.lanes.map((lane) => ({ lane, step: at + 1, ids: rowIds(road.road, at + 1, lane.name) })));
}

/** Line 1: the step's rows. */
function rowsLine(road, rows, step, isUiPath) {
  const entries = laneEntries(road);
  const own = entries.filter((entry) => entry.step === step);
  const open = own.filter((entry) => !laneLanded(rows, road.road, entry.step, entry.lane.name));
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

// `step`: the lane's step, or a fix row's step from its id, so line 4 asks the UI proof for every landing of the step (fix rows included).
const closeRange = (rows, row, entry) => ({ entry, step: entry?.step ?? Number(FIX_ROW.exec(row.id)?.[1]), row: row.id, landed: landedOfCloseRow(rows, row), within: withinOfCloseRow(rows, row), both: ambiguousCorrection(rows, row), unknown: [] });

/**
 * The done fix rows of the road that record a landing: a `fix-<name>` row whose `-land` twin is in STATUS.md is not one (old form), and
 * neither is a row a lane of the road already lands through (a lane may itself be named `fix-...`).
 */
function fixLandingRows(road, rows, laneIds) {
  const hasTwin = (row) => { const twin = rows.get(`${row.id.toLowerCase()}${LAND_SUFFIX}`); return twin !== undefined && !isReworkRow(twin); };
  return [...rows.values()].filter((row) => FIX_ROW.test(row.id) && row.id.startsWith(`${road.road}.`) && row.done != null
    && !hasTwin(row) && !laneIds.has(row.id.toLowerCase()));
}

/** The done close rows of the road, as ranges (`landed` null when the row has no landed line; `within` `{ id, hasAs }` of the named close row or null; `both` the two correction row ids when it has two). */
function closeRanges(road, rows) {
  const lanes = laneEntries(road).map((entry) => ({ entry, id: landingRowId(rows, road.road, entry.step, entry.lane.name) }));
  const laneIds = new Set(lanes.map(({ id }) => id.toLowerCase()));
  return lanes.flatMap(({ entry, id }) => {
    const row = rows.get(id.toLowerCase());
    if (row?.done == null || isReworkRow(row)) return [];
    return [closeRange(rows, { ...row, id }, entry)];
  }).concat(fixLandingRows(road, rows, laneIds).map((row) => closeRange(rows, row, null)));
}

/** The full commit sha of a row's sha text (hex-checked, 7-40 characters), or null when git does not know it, finds it ambiguous, or answers with a commit it does not start with. */
export function fullSha(run, repo, text) {
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

/**
 * The close ranges of the other roads (same repo and base, the road files beside STATUS.md) that end after this road's start: two roads
 * land interleaved on one base (owner FR2), so their commits are accounted for here and their `to`s are valid `from`s. A row with no
 * usable landed line or an unknown sha, a `landed within` row and a range that ended at or before the start add no range (a commit of
 * theirs in `<start>..<tip>` then lies in no range: FAIL); the ranges kept get the same per-row checks as this road's.
 */
function otherRanges(run, ctx, rows, others) {
  return others.flatMap((other) => closeRanges(other, rows))
    .filter((range) => range.within === null && range.both === null && HEX.test(range.landed?.to ?? '') && HEX.test(range.landed?.from ?? ''))
    .map((range) => resolveRange(run, ctx, range))
    .filter((range) => range.unknown.length === 0 && isAncestor(run, ctx.repo, range.landed.to, ctx.start) !== 0);
}

/** Line 2: every close row of the road (and the other roads' ranges in its window), then the cover of `<start>..<tip>` by all of them. */
function rangeLines(run, ranges, others, ctx) {
  const seenTo = new Set();
  const all = ranges.concat(others);
  const rowFails = new Map(all.map((range) => [range, range.within === null ? rangeRowFails(run, ctx, range, seenTo) : withinRowFails(range)]));
  const fails = [...rowFails.values()].flat().concat(withinFails(ranges, rowFails));
  const good = all.filter((range) => range.unknown.length === 0 && range.landed?.from && HEX.test(range.landed.from));
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
  const theirs = others.length === 0 ? '' : ` and ${others.length} of other roads`;
  return fails.length === 0 ? [pass(`2 range: ${ranges.length} close rows${theirs}, every commit in one range`)] : fails.map(fail);
}

/**
 * Whether a branch is no landed leftover (line 3's held writers): it has commits not on the base tip, or none yet (its tip is the base
 * tip). A branch git cannot read, or an ancestor-check error, is a leftover (fail closed: FAIL, never INFO).
 */
function branchAhead(run, ctx, branch) {
  const read = git(run, ctx.repo, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
  const head = read.out.trim();
  if (read.exit !== 0 || !HEX.test(head)) return false;
  return head === ctx.tip || isAncestor(run, ctx.repo, head, ctx.tip) === 1;
}

/**
 * Runs the gate for one step.
 * @param {object} road a checked road
 * @param {object[]} items parseWorkItems(...).items
 * @param {number} step 1-based
 * @param {(file: string, argv: string[], timeoutMs: number) => { exit: number, out: string }} run
 * @param {{ isUiPath: (path: string) => boolean, otherRoads?: object[], statusFile?: string, statusText?: string,
 *   held?: object[], live?: Set<string> }} options the UI file test; the other checked roads of the same repo and STATUS.md,
 *   whose started lanes are in flight for line 3 and whose landing ranges on the same base count for line 2; the road's STATUS.md path
 *   and text, which line 4's terminal proof reads (its folder, its owner decisions); the open writer launches and the live session ids
 *   (road-gate-git.mjs openWriterFolders, liveSessions), which line 3 weighs with git's answer of branchAhead
 * @returns {{ lines: string[], pass: boolean }}
 */
export function gateStep(road, items, step, run, { isUiPath, otherRoads = [], statusFile, statusText = '', held = [], live = new Set() }) {
  const rows = new Map(items.map((item) => [item.id.toLowerCase(), item]));
  const start = roadStartTip(road, items);
  const tipRead = git(run, road.repo, ['rev-parse', '--verify', `refs/heads/${road.base}^{commit}`]);
  const tip = tipRead.out.trim();
  if (start === null || tipRead.exit !== 0 || !HEX.test(tip)) return { lines: [fail(`road start tip or base tip unreadable (run rows first; git exit ${tipRead.exit})`)], pass: false };
  const firstParentList = git(run, road.repo, ['rev-list', '--first-parent', `${start}..${tip}`]).out.split('\n').filter(Boolean);
  const ctx = { repo: road.repo, base: road.base, start, tip, firstParentList, firstParent: new Set(firstParentList), isUiPath };
  const ranges = closeRanges(road, rows).map((range) => resolveRange(run, ctx, range));
  const others = otherRanges(run, ctx, rows, otherRoads.filter((other) => other.repo === road.repo && other.base === road.base));
  const uiCtx = { ...ctx, statusFile, statusText, uiProof: (argv) => run('ui-proof', argv, TOOL_TIMEOUT_MS), isAncestor: (a, b) => isAncestor(run, road.repo, a, b) };
  const lines = [
    ...rowsLine(road, rows, step, isUiPath),
    ...rangeLines(run, ranges, others, ctx),
    ...gitLines(run('git-tidy', ['check', road.repo, '--base', road.base, '--json'], TOOL_TIMEOUT_MS), road, items,
      { otherRoads, held, live, branchAhead: (branch) => branchAhead(run, ctx, branch) }),
    uiLine(road, rows, ranges, step, uiCtx),
    `INFO 5 measure: ${road.steps[step - 1].measure ?? 'none named'}`,
  ];
  return { lines, pass: !lines.some((line) => line.startsWith('FAIL')) };
}
