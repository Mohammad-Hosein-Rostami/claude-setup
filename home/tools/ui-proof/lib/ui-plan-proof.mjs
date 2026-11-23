// Purpose: does a check plan (ui-plan.mjs planChecks) hold on the proof records? Exports: planProofProblem (re-exported by ui-plan.mjs).
// none: nothing to prove. visual and pixel: today's chain, a visual-qa PASS for the tip's UI tree. same and render: the newest runner or
// visual-qa run at the tip (head and UI tree) that ran `ui-check run --same <base run>`, whose base ledger (by sha256) is a runner or
// visual-qa run at the base (head and UI tree): per state of every planned surface, same needs identical or equal renders, render needs
// no new finding and no more page errors; a state with no base render needs the visual plan; old findings are follow-up lines.
// A visual-qa PASS on the tip proves render, never same.
// Invariants (P3, P14, F1, F2): zero rows, a missing record at either end, a record of another tree or head, a run by any other agent
// (a writer's own run, the lead's) or a refused or other-renderer base is a problem, never a pass; pure apart from uiTreeAt (git).
import { PROOF_AGENT, RENDER_PROOF_AGENTS, findPass } from './records.mjs';
import { uiTreeAt } from './ui-files.mjs';

const MAX_LISTED = 8; // states named per problem line
const SHORT_SHA = 12;

const newest = (records, test) => [...records].reverse().find(test) ?? null;
const listed = (keys) => `${keys.slice(0, MAX_LISTED).join(', ')}${keys.length > MAX_LISTED ? ` (and ${keys.length - MAX_LISTED} more)` : ''}`;
const byRenderAgent = (record) => typeof record?.agentType === 'string' && RENDER_PROOF_AGENTS.includes(record.agentType);

/** The tip and base records of a same/render proof, or the reason one is missing. */
function proofPair(records, { tip, base, tipTree, baseTree, matrixHash }) {
  const tipRecord = newest(records, (r) => byRenderAgent(r) && r.head === tip && r.uiTree === tipTree && Array.isArray(r.same?.rows)
    && (matrixHash === null || r.matrixHash === matrixHash));
  if (!tipRecord) {
    return { why: `no ${RENDER_PROOF_AGENTS.join(' or ')} run at ${tip.slice(0, SHORT_SHA)} (UI tree ${tipTree.slice(0, SHORT_SHA)}) with --same <base run>: the runner runs ui-check run --same in the lane worktree (a record lost to a run at the same time: run it again)` };
  }
  if (tipRecord.same.refused) return { why: `the tip run's --same base was refused: ${tipRecord.same.refused}` };
  if (tipRecord.same.mismatch) return { why: `the tip run's --same base used another renderer or comparator: ${tipRecord.same.mismatch}` };
  const ledgerSha = tipRecord.same.ref?.sha256;
  const baseRecord = newest(records, (r) => byRenderAgent(r) && typeof ledgerSha === 'string' && r.ledgerSha256 === ledgerSha && r.head === base && r.uiTree === baseTree);
  if (!baseRecord) return { why: `the tip run's base ledger (sha256 ${String(ledgerSha).slice(0, SHORT_SHA)}) is no ${RENDER_PROOF_AGENTS.join(' or ')} run at ${base.slice(0, SHORT_SHA)} (UI tree ${baseTree.slice(0, SHORT_SHA)}): run the base in the base checkout at the base tip` };
  return { tipRecord, baseRecord };
}

/** Problems and follow-ups of the rows of the planned surfaces. `visualPass`: a visual-qa PASS on the tip covers new states. */
function judgeRows(surfaces, tipRecord, visualPass) {
  const rows = tipRecord.same.rows;
  if (rows.length === 0) return { problems: ['zero rows: the tip run rendered nothing to compare'], followUps: [] };
  const rowsOf = (id) => rows.filter((row) => typeof row?.key === 'string' && row.key.startsWith(`${id} / `));
  const captureOf = new Map((tipRecord.captures ?? []).map((c) => [c.key, c]));
  const found = { changed: [], fresh: [], missing: [], blocked: [], findings: [], pageErrors: [], followUps: [] };
  const missingSurfaces = surfaces.filter((s) => rowsOf(s.id).length === 0).map((s) => s.id);
  for (const surface of surfaces) for (const row of rowsOf(surface.id)) sortRow(row, surface.need, captureOf.get(row.key), found);
  const problems = [
    missingSurfaces.length > 0 ? `missing row: no render of ${listed(missingSurfaces)}` : null,
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
function sortRow(row, need, capture, found) {
  const newFindings = Array.isArray(row.newFindings) ? row.newFindings : [];
  const newPageErrors = Array.isArray(row.newPageErrors) ? row.newPageErrors : [];
  if (row.verdict === 'missing') found.missing.push(row.key);
  else if (row.verdict === 'new') found.fresh.push(row.key);
  else if (row.verdict === 'changed' && need === 'same') found.changed.push(row.key);
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
 * @param {{depth: string, surfaces: {id: string, need: string}[]}} plan planChecks result
 * @param {{records: object[], repoDir: string, base: string, tip: string, matrixHash?: string|null}} input records: readRecords of the
 *   repo's store (the caller fails closed when it cannot be read); base and tip: full commit shas; matrixHash: when given, the tip run
 *   must have used that matrix
 * @returns {{problem: string|null, followUps: string[]}} problem: null when the plan is proved, else the reasons joined by `; `;
 *   followUps: `follow-up:` lines for findings on both the base and the tip (never a problem)
 * @throws {Error} when git cannot read a commit's UI tree (the caller fails closed)
 */
export function planProofProblem(plan, { records, repoDir, base, tip, matrixHash = null }) {
  if (plan.depth === 'none') return { problem: null, followUps: [] };
  if (!Array.isArray(records)) return { problem: 'the proof records cannot be read', followUps: [] };
  const tipTree = uiTreeAt(repoDir, tip);
  const visualPass = findPass(records, tipTree, [PROOF_AGENT]) !== null;
  if (['visual', 'pixel'].includes(plan.depth) && !visualPass) {
    return { problem: `no ${PROOF_AGENT} PASS for the UI files of ${tip} (plan ${plan.depth}: a ui-implementer's own PASS, or a record without an agent type, does not count)`, followUps: [] };
  }
  // A visual-qa PASS proves every need up to render; a same need is proved by identical renders only.
  const open = plan.surfaces.filter((s) => s.need === 'same' || (s.need === 'render' && !visualPass));
  if (open.length === 0) return { problem: null, followUps: [] };
  const pair = proofPair(records, { tip, base, tipTree, baseTree: uiTreeAt(repoDir, base), matrixHash });
  if (pair.why) return { problem: pair.why, followUps: [] };
  const { problems, followUps } = judgeRows(open, pair.tipRecord, visualPass);
  return { problem: problems.length > 0 ? problems.join('; ') : null, followUps };
}
