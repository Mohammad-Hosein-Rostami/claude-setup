// Purpose: the render map of a check plan and whether the proof records hold it. Exports: renderMap, runFiles, planProofProblem (all
// re-exported by ui-plan.mjs).
// The map: the widths, locales and states a same or render proof covers (the lane matrix's widths and locales, else 360, 768, 1280 and
// the repo's own locales, found as locale folder names, else en) and the sha256 of the run matrix `ui-proof plan --write-run` writes.
// none: nothing to prove. visual and pixel: today's chain, a visual-qa PASS for the tip's UI tree. same and render: the newest runner or
// visual-qa run at the tip (head and UI tree) that ran `ui-check run --matrix <the plan's matrix> --same <base run>`, whose base ledger
// (by sha256) is a runner or visual-qa run at the base (head and UI tree): a row for every state, locale and width of the map on every
// planned surface; same needs identical or equal renders, render needs no new finding and no more page errors; a state with no base
// render needs the visual plan; old findings are follow-up lines. A visual-qa PASS on the tip proves render, never same: a surface
// whose needs hold same is proved by identical renders whatever else it needs.
// Invariants (P3, P14, F1, F2): zero rows, a missing row, a run of another matrix, a missing record at either end, a record of another
// tree or head, a run by any other agent (a writer's own run, the lead's) or a refused or other-renderer base is a problem, never a
// pass; pure apart from uiTreeAt (git).
import crypto from 'node:crypto';
import { keyOf } from '../../ui-check/lib/ledger.mjs';
import { PROOF_AGENT, RENDER_PROOF_AGENTS, findPass } from './records.mjs';
import { uiTreeAt } from './ui-files.mjs';

const MAX_LISTED = 8; // states named per problem line
const SHORT_SHA = 12;
const DEFAULT_WIDTHS = Object.freeze([360, 768, 1280]); // without a lane matrix
const DEFAULT_LOCALE = Object.freeze({ tag: 'en', dir: 'ltr' });
const RUN_STATES = Object.freeze(['rest']); // the run renders each surface whole, with no control states
const RUN_REASON = 'rendered whole by the ui plan (ui-proof plan --write-run): no control states';
const LOCALE_FOLDERS = new Set(['locales', 'locale', 'i18n', 'l10n', 'lang', 'langs', 'languages', 'translations', 'messages']);
const LOCALE_TAG = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i;
const RTL_LANGUAGES = new Set(['ar', 'fa', 'he', 'iw', 'ur', 'ps', 'yi', 'dv', 'ckb', 'sd', 'ug']);
const TEST_PART = /^(?:test|tests|__tests__|__mocks__|fixtures|e2e|cypress)$/i;

const newest = (records, test) => [...records].reverse().find(test) ?? null;
const listed = (keys) => `${keys.slice(0, MAX_LISTED).join(', ')}${keys.length > MAX_LISTED ? ` (and ${keys.length - MAX_LISTED} more)` : ''}`;
const byRenderAgent = (record) => typeof record?.agentType === 'string' && RENDER_PROOF_AGENTS.includes(record.agentType);
const proofNeeds = (surface) => surface.needs.some((need) => need === 'same' || need === 'render');

/** The locale tags named by locale folders (`locales/fa/`, `i18n/fa.json`) outside test folders, lower case, sorted, once each. */
function repoLocales(paths) {
  const tags = new Set();
  for (const file of paths) {
    const parts = file.split('/');
    if (parts.some((part) => TEST_PART.test(part))) continue;
    const at = parts.findIndex((part, i) => i < parts.length - 1 && LOCALE_FOLDERS.has(part.toLowerCase()));
    const name = at < 0 ? '' : parts[at + 1].replace(/\.[^.]+$/, '');
    if (LOCALE_TAG.test(name)) tags.add(name.toLowerCase().replace(/_/g, '-'));
  }
  return [...tags].sort().map((tag) => ({ tag, dir: RTL_LANGUAGES.has(tag.split('-')[0]) ? 'rtl' : 'ltr' }));
}

/** The lane matrix's usable widths and locales (each list or null when it has none). */
function laneLists(matrix) {
  const widths = Array.isArray(matrix?.widths) ? matrix.widths.filter((w) => Number.isInteger(w) && w > 0) : [];
  const locales = Array.isArray(matrix?.locales) ? matrix.locales.filter((l) => typeof l?.tag === 'string' && ['ltr', 'rtl'].includes(l.dir)) : [];
  return { widths: widths.length > 0 ? widths : null, locales: locales.length > 0 ? locales.map(({ tag, dir }) => ({ tag, dir })) : null };
}

/**
 * The ui-coverage matrix and ui-check states of the surfaces a runner renders (a need of same or render, with a url), and the
 * sha256 of the matrix text: the exact bytes `--write-run` writes, so a run's matrixHash names this matrix.
 * @param {{id: string, needs: string[], url: string|null}[]} surfaces the plan's surfaces
 * @param {{widths: number[], locales: {tag: string, dir: string}[], states: string[]}} map the plan's render map
 * @returns {{matrixText: string, statesText: string, count: number, hash: string|null}} hash: null when no surface is rendered
 */
export function runFiles(surfaces, map) {
  const run = surfaces.filter((s) => proofNeeds(s) && typeof s.url === 'string');
  const { widths, locales, states } = map;
  const matrix = {
    locales, widths,
    searched: { backend: [RUN_REASON], siblings: [RUN_REASON], reference: [RUN_REASON] },
    deliverable: { reviewUrl: '.', mockExcluded: `not a deliverable: ${RUN_REASON}` },
    surfaces: run.map((s) => ({ id: s.id, kind: 'screen', source: s.url, controls: `none: ${RUN_REASON}` })),
    cells: run.flatMap((s) => states.flatMap((state) => locales.flatMap((l) => widths.map((width) => ({ surface: s.id, state, locale: l.tag, width, status: 'todo', evidence: '', reason: '' }))))),
  };
  const runStates = { defaults: { widths }, states: run.flatMap((s) => states.flatMap((state) => locales.map((l) => ({ surface: s.id, state, locale: l.tag, url: s.url })))) };
  const matrixText = `${JSON.stringify(matrix, null, 2)}\n`;
  const hash = run.length === 0 ? null : crypto.createHash('sha256').update(matrixText).digest('hex');
  return { matrixText, statesText: `${JSON.stringify(runStates, null, 2)}\n`, count: run.length, hash };
}

/**
 * The render map of a plan: what a same or render proof covers.
 * @param {{paths: string[], laneMatrix: object|null, surfaces: object[]}} input paths: the files at the tip (for its locale folders)
 * @returns {{widths: number[], locales: {tag: string, dir: string}[], states: string[], source: string, hash: string|null}}
 *   source: where the widths and locales came from, in words; hash: the run matrix's sha256 (runFiles), null when nothing renders
 */
export function renderMap({ paths, laneMatrix, surfaces }) {
  const lane = laneLists(laneMatrix);
  const found = lane.locales ? null : repoLocales(paths);
  const locales = lane.locales ?? (found.length > 0 ? found : [DEFAULT_LOCALE]);
  const localeSource = lane.locales ? 'locales of the lane matrix' : found.length > 0 ? "locales of the repository's locale folders" : 'locale en: the repository has no locale folder';
  const map = { widths: lane.widths ?? [...DEFAULT_WIDTHS], locales, states: [...RUN_STATES] };
  const source = `${lane.widths ? 'widths of the lane matrix' : 'default widths'}, ${localeSource}`;
  return { ...map, source, hash: runFiles(surfaces, map).hash };
}

/** The tip and base records of a same/render proof, or the reason one is missing. */
function proofPair(records, { tip, base, tipTree, baseTree, matrixHash }) {
  const tipRun = (r) => byRenderAgent(r) && r.head === tip && r.uiTree === tipTree && Array.isArray(r.same?.rows);
  const tipRecord = newest(records, (r) => tipRun(r) && r.matrixHash === matrixHash);
  if (!tipRecord) {
    const other = newest(records, tipRun);
    if (other) return { why: `the tip run rendered matrix sha256 ${String(other.matrixHash).slice(0, SHORT_SHA)}, not the plan's ${matrixHash.slice(0, SHORT_SHA)}: render the matrix of ui-proof plan --write-run (the same --request and --matrix as the check)` };
    return { why: `no ${RENDER_PROOF_AGENTS.join(' or ')} run at ${tip.slice(0, SHORT_SHA)} (UI tree ${tipTree.slice(0, SHORT_SHA)}) with --same <base run>: the runner runs ui-check run --same in the lane worktree (a record lost to a run at the same time: run it again)` };
  }
  if (tipRecord.same.refused) return { why: `the tip run's --same base was refused: ${tipRecord.same.refused}` };
  if (tipRecord.same.mismatch) return { why: `the tip run's --same base used another renderer or comparator: ${tipRecord.same.mismatch}` };
  const ledgerSha = tipRecord.same.ref?.sha256;
  const baseRecord = newest(records, (r) => byRenderAgent(r) && typeof ledgerSha === 'string' && r.ledgerSha256 === ledgerSha && r.head === base && r.uiTree === baseTree);
  if (!baseRecord) return { why: `the tip run's base ledger (sha256 ${String(ledgerSha).slice(0, SHORT_SHA)}) is no ${RENDER_PROOF_AGENTS.join(' or ')} run at ${base.slice(0, SHORT_SHA)} (UI tree ${baseTree.slice(0, SHORT_SHA)}): run the base in the base checkout at the base tip` };
  return { tipRecord, baseRecord };
}

/** Every row key the map asks of the surfaces: each state, locale and width. */
const expectedKeys = (surfaces, map) => surfaces.flatMap((s) => map.states.flatMap((state) => map.locales.flatMap((l) => map.widths.map((width) => keyOf({ surface: s.id, state, locale: l.tag, width })))));

/** Problems and follow-ups of the rows of the planned surfaces. `visualPass`: a visual-qa PASS on the tip covers new states. */
function judgeRows(surfaces, map, tipRecord, visualPass) {
  const rows = tipRecord.same.rows;
  if (rows.length === 0) return { problems: ['zero rows: the tip run rendered nothing to compare'], followUps: [] };
  const rowsOf = (id) => rows.filter((row) => typeof row?.key === 'string' && row.key.startsWith(`${id} / `));
  const captureOf = new Map((tipRecord.captures ?? []).map((c) => [c.key, c]));
  const found = { changed: [], fresh: [], missing: [], blocked: [], findings: [], pageErrors: [], followUps: [] };
  const rendered = new Set(rows.map((row) => row?.key));
  const missingRows = expectedKeys(surfaces, map).filter((key) => !rendered.has(key));
  for (const surface of surfaces) for (const row of rowsOf(surface.id)) sortRow(row, surface.needs.includes('same'), captureOf.get(row.key), found);
  const problems = [
    missingRows.length > 0 ? `missing row: no render of ${listed(missingRows)}` : null,
    found.missing.length > 0 ? `missing: ${listed(found.missing)} (in the base run, not in the tip run)` : null,
    found.blocked.length > 0 ? `not compared: ${listed(found.blocked)}` : null,
    found.changed.length > 0 ? `unexpected visual change: ${listed(found.changed)}` : null,
    found.fresh.length > 0 && !visualPass ? `new state with no base render (the visual plan: a visual-qa PASS on the tip): ${listed(found.fresh)}` : null,
    found.findings.length > 0 ? `new finding: ${listed(found.findings)}` : null,
    found.pageErrors.length > 0 ? `more page errors: ${listed(found.pageErrors)}` : null,
  ].filter(Boolean);
  return { problems, followUps: found.followUps };
}

/** Sort one row into the found lists; old findings and old page errors of the state become follow-up lines. */
function sortRow(row, same, capture, found) {
  const newFindings = Array.isArray(row.newFindings) ? row.newFindings : [];
  const newPageErrors = Array.isArray(row.newPageErrors) ? row.newPageErrors : [];
  if (row.verdict === 'missing') found.missing.push(row.key);
  else if (row.verdict === 'new') found.fresh.push(row.key);
  else if (row.verdict === 'changed' && same) found.changed.push(row.key);
  else if (!['identical', 'equal', 'changed'].includes(row.verdict)) found.blocked.push(`${row.key} (${String(row.verdict)})`);
  if (newFindings.length > 0) found.findings.push(`${row.key}: ${newFindings.join(', ')}`);
  if (newPageErrors.length > 0) found.pageErrors.push(`${row.key}: ${newPageErrors.length} more`);
  if (row.verdict === 'new') return; // no base render: nothing on it is old
  const old = (capture?.findings ?? []).filter((id) => !newFindings.includes(id));
  for (const id of old) found.followUps.push(`follow-up: ${row.key}: ${id} (on the base and the tip)`);
  const oldErrors = (capture?.pageErrors ?? []).length - newPageErrors.length;
  if (oldErrors > 0) found.followUps.push(`follow-up: ${row.key}: ${oldErrors} page error(s) on the base and the tip`);
}

/**
 * Does the plan hold on the records?
 * @param {{depth: string, surfaces: {id: string, need: string, needs: string[]}[], map: object|null}} plan planChecks result
 * @param {{records: object[], repoDir: string, base: string, tip: string}} input records: readRecords of the repo's store (the caller
 *   fails closed when it cannot be read); base and tip: full commit shas
 * @returns {{problem: string|null, followUps: string[]}} problem: null when the plan is proved, else the reasons joined by `; `;
 *   followUps: `follow-up:` lines for findings on both the base and the tip (never a problem)
 * @throws {Error} when git cannot read a commit's UI tree (the caller fails closed)
 */
export function planProofProblem(plan, { records, repoDir, base, tip }) {
  if (plan.depth === 'none') return { problem: null, followUps: [] };
  if (!Array.isArray(records)) return { problem: 'the proof records cannot be read', followUps: [] };
  const tipTree = uiTreeAt(repoDir, tip);
  const visualPass = findPass(records, tipTree, [PROOF_AGENT]) !== null;
  if (['visual', 'pixel'].includes(plan.depth) && !visualPass) {
    return { problem: `no ${PROOF_AGENT} PASS for the UI files of ${tip} (plan ${plan.depth}: a ui-implementer's own PASS, or a record without an agent type, does not count)`, followUps: [] };
  }
  // A visual-qa PASS proves every need up to render; a surface whose needs hold same is proved by identical renders only.
  const open = plan.surfaces.filter((s) => s.needs.includes('same') || (s.need === 'render' && !visualPass));
  if (open.length === 0) return { problem: null, followUps: [] };
  if (typeof plan.map?.hash !== 'string') return { problem: 'the plan has no render map to prove (no runnable surface): run ui-proof plan again', followUps: [] };
  const pair = proofPair(records, { tip, base, tipTree, baseTree: uiTreeAt(repoDir, base), matrixHash: plan.map.hash });
  if (pair.why) return { problem: pair.why, followUps: [] };
  const { problems, followUps } = judgeRows(open, plan.map, pair.tipRecord, visualPass);
  return { problem: problems.length > 0 ? problems.join('; ') : null, followUps };
}
