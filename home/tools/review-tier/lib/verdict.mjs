// Purpose: the per-round review checks of the lead as rules (they lived in home/workflows/review.js): is a round complete, what must be
//   fixed, what moves to a follow-up, what the lead does next. The CLI `../verdict.mjs` reads and hashes the files and prints.
// Exports: decide(input), priorFileText(result, ...), ROUND_LIMIT.
// Invariants: pure (no file, no clock); inputs are the tier JSON and parsed reports (`parseReport`), never text. Fail closed (P3): a missing or
//   malformed part is `incomplete`, never clean. Report text is never printed: only lens numbers, ids and class slugs that matched their
//   pattern reach the result. A usage mistake (report count, wrong tier, unknown drop) throws UsageError (exit 2).
import { UsageError } from '../../git-tidy/lib/git.mjs';
import { ORIGINS } from './report-lines.mjs';

export const ROUND_LIMIT = 2; // a lane with findings after its round 2 goes back to the architect instead of another fix
const MUST_FIX = new Set(['blocking', 'should-fix']);
const CLASS_SLUG = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const PRIOR_LINE = /^prior: (\d+) fixed, (\d+) open$/;
const FULL_RANGE = /needs the full range/i;
const EXPLOITABLE_NO = /^no: \S/;
const REQUIRED_FIELDS = ['class', 'proof', 'siblings'];
const KNOWN_AGENTS = new Set(['reviewer', 'security-auditor', 'skill']);
const SECURITY_AGENT = 'security-auditor';
const MAX_WHY_CHARS = 300;
const NO_LANE = '(none)'; // what the prior file names as its lane when the lead gave no --lane

const isMustFix = (finding) => MUST_FIX.has(finding.severity);
const unique = (list) => [...new Set(list)];

/** The number of files the tier read: its `files` is a count (an array is accepted too). */
function fileCountOf(tier) {
  if (Number.isInteger(tier.files)) return tier.files;
  if (Array.isArray(tier.files)) return tier.files.length;
  throw new UsageError('the tier JSON has no `files` count');
}

/** The lenses this round expects reports from, checked: a list of known agents. */
function lensesOf(tier, waived) {
  const lenses = waived ? tier.waivable?.reviews : tier.reviews;
  if (!Array.isArray(lenses)) throw new UsageError(waived ? 'the tier JSON has no waivable.reviews: nothing is waived for this range' : 'the tier JSON has no `reviews` list');
  if (!lenses.every((lens) => KNOWN_AGENTS.has(lens?.agent))) throw new UsageError('the tier JSON names a lens agent that is not reviewer, security-auditor or skill');
  return lenses;
}

/** The problems of the final line, the head and the read count of one report (empty list: fine). */
function finalProblems(report, lens, tier) {
  const { final } = report;
  const expected = lens.agent === SECURITY_AGENT ? 'exploitable' : 'verified';
  if (report.endsInFence) return ['the report ends inside a fenced block'];
  if (final === null) return ['no final line'];
  if (final.kind !== expected) return [`the final line is \`${final.kind}:\`, a ${lens.agent} writes \`${expected}:\``];
  if (final.problem !== null) return [`malformed final line: ${final.problem}`];
  const problems = [];
  if (final.head !== String(tier.tip).toLowerCase()) problems.push('head: is not the tier tip');
  const [read, of] = final.read;
  if (read < of) problems.push(`read ${read}/${of}: not every file was read`);
  else if (read !== of || of !== fileCountOf(tier)) problems.push(`read ${read}/${of} does not match the ${fileCountOf(tier)} files of the tier`);
  return problems;
}

/** The problems of the must-fix finding lines of one report. */
function findingProblems(report) {
  const mustFix = report.findings.filter(isMustFix);
  const problems = [];
  if (mustFix.length !== report.counted) problems.push('a blocking or should-fix finding is not a well-formed finding line');
  for (const finding of mustFix) {
    if (finding.problem !== null) problems.push(`finding ${finding.id}: ${finding.problem}`);
    else if (REQUIRED_FIELDS.some((name) => (finding.fields[name] ?? '') === '')) problems.push(`finding ${finding.id} lacks class:, proof: or siblings:`);
    else if (!CLASS_SLUG.test(finding.fields.class)) problems.push(`finding ${finding.id}: class is no slug`);
  }
  return problems;
}

/** The problems of the P/F checklist of one report against the road's ids. */
function checklistProblems(report, roadIds) {
  if (roadIds === null) return [];
  const problems = [];
  for (const id of roadIds) {
    const lines = report.checklist.filter((entry) => entry.id === id);
    if (lines.length === 0) problems.push(`checklist has no line for ${id}`);
    else if (lines.length > 1) problems.push(`checklist has ${lines.length} lines for ${id}`);
    else if (lines[0].status === 'bad') problems.push(`checklist ${id} has no file:line or no finding id`);
    else if (lines[0].status === 'not-met' && !report.findings.some((finding) => finding.id === lines[0].findingId)) problems.push(`checklist ${id} is not met and names no finding of this report`);
  }
  return problems;
}

/** The problems of a delta round's prior line, mutants and open count for one report. */
function deltaProblems(report, prior) {
  const problems = [];
  if (FULL_RANGE.test(`${report.restText}\n${report.final?.problem ?? ''}`) || report.priorLines.some((line) => FULL_RANGE.test(line))) return ['the lens says it needs the full range'];
  if (report.priorLines.length !== 1) return [report.priorLines.length === 0 ? 'no `prior: <n> fixed, <m> open` line' : 'more than one `prior:` line'];
  const counts = PRIOR_LINE.exec(report.priorLines[0]);
  if (counts === null) return ['the prior: line is not `prior: <n> fixed, <m> open`'];
  const [fixed, open] = [Number(counts[1]), Number(counts[2])];
  if (fixed + open !== prior.report.counted) problems.push(`prior: ${fixed} fixed, ${open} open does not add up to the ${prior.report.counted} prior findings`);
  const returned = report.findings.filter((finding) => isMustFix(finding) && finding.fields.origin === 'prior').length;
  if (open > returned) problems.push(`prior: counts ${open} open but only ${returned} findings have origin: prior`);
  const ran = new Set(report.mutants.map((mutant) => mutant.id));
  const missing = unique(prior.report.mutants.map((mutant) => mutant.id)).filter((id) => !ran.has(id));
  if (missing.length > 0) problems.push(`prior mutants not re-run: ${missing.slice(0, 5).join(', ')}`);
  return problems;
}

/** Every problem of one report as `{lens, why}`; a wrong-base report has that one problem only. */
function reportProblems(report, index, context) {
  const { tier, lenses, roadIds, prior } = context;
  const lens = index + 1;
  const found = report.wrongBase ? ['wrong base'] : [
    ...finalProblems(report, lenses[index], tier),
    ...findingProblems(report),
    ...checklistProblems(report, roadIds),
    ...(report.badMutantLines > 0 ? ['a line of the mutants block is malformed'] : []),
    ...(prior !== null && tier.deltaOf ? deltaProblems(report, prior) : []),
  ];
  return found.map((why) => ({ lens, why }));
}

/** A finding id used by two must-fix findings of the round (in one report or two) is ambiguous for `--drop` and `fix <ids>`. */
function duplicateIdProblems(reports) {
  const seen = new Map();
  const problems = [];
  reports.forEach((report, index) => {
    for (const finding of report.findings.filter(isMustFix)) {
      if (seen.has(finding.id)) problems.push({ lens: index + 1, why: `finding id ${finding.id} is already used by lens ${seen.get(finding.id)}: ids are unique in a round` });
      else seen.set(finding.id, index + 1);
    }
  });
  return problems;
}

/** Splits the must-fix findings into what stays and what is only a follow-up (D-RL2 and the delta origin rule). */
function moveFindings(reports, lenses, isDelta) {
  const stays = [];
  const followUp = [];
  reports.forEach((report, index) => {
    const agent = lenses[index].agent;
    for (const finding of report.findings.filter(isMustFix)) {
      const entry = { ...finding, lens: index + 1, agent };
      const notExploitable = agent === SECURITY_AGENT && EXPLOITABLE_NO.test(finding.fields.exploitable ?? '');
      const noOrigin = isDelta && finding.severity === 'should-fix' && agent !== SECURITY_AGENT && !ORIGINS.has(finding.fields.origin);
      if (notExploitable || noOrigin) followUp.push(entry);
      else stays.push(entry);
    }
  });
  return { stays, followUp };
}

/** True for a lens that is Sonnet: its finding may be dropped by the lead (a skill lens runs as a Sonnet reviewer). */
const isSonnetLens = (lens) => lens.agent === 'skill' || (lens.agent === 'reviewer' && lens.model === 'sonnet');

/**
 * Applies the drop requests. A Sonnet lens's finding goes on `--drop`; an Opus lens's only with a `not-real` ruling; a security-auditor
 * finding never (the owner is asked).
 * @returns {{kept: object[], dropped: string[], owner: string[]}}
 */
function applyDrops(stays, lenses, dropIds, rulings) {
  const requested = unique([...dropIds, ...[...rulings].filter(([, ruling]) => ruling === 'not-real').map(([id]) => id)]);
  const dropped = [];
  const owner = [];
  for (const id of requested) {
    const finding = stays.find((entry) => entry.id === id);
    if (finding === undefined) {
      if (dropIds.includes(id)) throw new UsageError(`--drop ${id} names no blocking or should-fix finding of this round`);
      continue;
    }
    if (finding.agent === SECURITY_AGENT) owner.push(id);
    else if (isSonnetLens(lenses[finding.lens - 1]) || rulings.get(id) === 'not-real') dropped.push(id);
    else throw new UsageError(`--drop ${id}: lens ${finding.lens} is not Sonnet, so only a judge's \`ruling: ${id} not-real\` (--judged) drops it`);
  }
  return { kept: stays.filter((entry) => !dropped.includes(entry.id)), dropped, owner };
}

/** The file of a `file:line` location. */
const fileOf = (location) => location.replace(/:\d+(-\d+)?$/, '');

/** The first file with a blocking finding now and in the prior file, or null. */
function debugFile(kept, prior) {
  if (prior === null) return null;
  const before = new Set(prior.report.findings.filter((finding) => finding.severity === 'blocking').map((finding) => fileOf(finding.location)));
  return kept.filter((finding) => finding.severity === 'blocking').map((finding) => fileOf(finding.location)).find((file) => before.has(file)) ?? null;
}

/** The `next:` text of the lead's one action. */
function nextOf(verdict, round, kept, rerun) {
  if (verdict === 'incomplete') return `rerun ${rerun.join(',')}`;
  if (verdict === 'clean') return 'land';
  if (round >= ROUND_LIMIT) return `re-spec ${unique(kept.map((finding) => finding.fields.class)).join(',')}`;
  return `fix ${kept.map((finding) => finding.id).join(',')}`;
}

/**
 * Judges one review round.
 * @param {object} input
 * @param {object} input.tier the review-tier JSON of the round
 * @param {boolean} input.waived read the waivable set
 * @param {object[]} input.reports parseReport of each report, in the order of the lenses
 * @param {object|null} input.prior `{round, lane, tip, sha256, report}` of the prior file (parsePriorFile plus its hash), or null
 * @param {string|null} input.lane the lane name the lead gave, for the header check
 * @param {string[]|null} input.roadIds the lane's P and F ids from the road, or null without a road
 * @param {string[]} input.drops ids the lead drops
 * @param {Map<string, string>} input.rulings the judge's `ruling: <id> real|not-real`
 * @returns {{verdict: 'clean'|'findings'|'incomplete', why: string, round: number, ids: string[], followUp: string[], debug: string|null,
 *   owner: string[], dropped: string[], next: string, kept: object[], lenses: object[], reports: object[]}}
 * @throws {UsageError} for a usage mistake: no or too few reports, a delta tier without its prior file, a prior file of another round or
 *   lane, a drop of an unknown finding, a drop of an Opus finding without a ruling
 */
export function decide({ tier, waived, reports, prior, lane, roadIds, drops, rulings }) {
  const lenses = lensesOf(tier, waived);
  if (reports.length === 0) throw new UsageError('no report was given: a round with no report is never clean');
  if (reports.length !== lenses.length) throw new UsageError(`the tier expects ${lenses.length} reports (one per lens, in order) and ${reports.length} were given`);
  const isDelta = Boolean(tier.deltaOf);
  checkPrior(tier, prior, lane, isDelta);
  const round = prior === null ? 0 : prior.round + 1;
  const context = { tier, lenses, roadIds, prior };
  const problems = [...reports.flatMap((report, index) => reportProblems(report, index, context)), ...duplicateIdProblems(reports)];
  if (problems.length > 0) {
    const why = unique(problems.map((problem) => `lens ${problem.lens}: ${problem.why}`)).join('; ').slice(0, MAX_WHY_CHARS);
    const rerun = unique(problems.map((problem) => problem.lens)).sort((a, b) => a - b);
    return { verdict: 'incomplete', why, round, ids: [], followUp: [], debug: null, owner: [], dropped: [], next: nextOf('incomplete', round, [], rerun), kept: [], lenses, reports };
  }
  const { stays, followUp } = moveFindings(reports, lenses, isDelta);
  const { kept, dropped, owner } = applyDrops(stays, lenses, drops, rulings);
  const verdict = kept.length === 0 ? 'clean' : 'findings';
  return { verdict, why: '', round, ids: kept.map((finding) => finding.id), followUp: followUp.map((finding) => finding.id), debug: debugFile(kept, prior), owner, dropped, next: nextOf(verdict, round, kept, []), kept, lenses, reports };
}

/** Refuses a prior file that does not belong to this tier or lane, and a delta tier without one. */
function checkPrior(tier, prior, lane, isDelta) {
  if (isDelta && prior === null) throw new UsageError('the tier is a delta round (deltaOf is set): it needs --prior and --prior-sha256 of the file the last round wrote');
  if (prior === null) return;
  if (lane !== null && prior.lane !== NO_LANE && prior.lane !== lane) throw new UsageError(`the prior file is for lane ${prior.lane}, not ${lane}`);
  if (!isDelta) return;
  if (prior.tip !== String(tier.deltaOf).toLowerCase()) throw new UsageError('the prior file was written for another tip than the delta base (deltaOf) of the tier');
  const files = tier.prior?.files;
  if (!Array.isArray(files) || files.length !== 1 || files[0].sha256 !== prior.sha256 || tier.prior.findings !== prior.report.counted) {
    throw new UsageError('the tier was made for another prior file: its prior file hash or finding count is not this one\'s');
  }
}

/**
 * The text of the prior file for the next round: header, round, every must-fix finding line as written, one mutants block.
 * @param {object} result decide's result (a complete round)
 * @param {string|null} lane the lane name, `(none)` when unknown
 * @param {string} tip the full sha the tier read
 * @returns {string}
 */
export function priorFileText(result, lane, tip) {
  const mutants = result.reports.flatMap((report) => report.mutants.map((mutant) => mutant.raw));
  return [`# prior findings: lane ${lane ?? NO_LANE}, round ${result.round}, tip ${tip}`, `round: ${result.round}`, ...result.kept.map((finding) => finding.raw), '```mutants', ...mutants, '```', ''].join('\n');
}
