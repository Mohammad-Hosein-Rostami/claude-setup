// Purpose: turn a set of classes into the reviews to run together (agent, model, effort, lens, brief) and their plans.
// Exports: STRESS_PLAN, RACE_RUNS, MUTANTS_PER_FILE, DELTA_READING, buildReviews(input), buildWaivable(input).
// Invariants: file names and ranges enter a brief as data (lib/brief-data.mjs); `requiredReading` arrives already written that way (lib/diff.mjs).
//   It only ADDS checks (I1, one exception: `waivable`, below): efforts are today's (Sonnet high correctness lens always at tier >= 1; Opus max lens for a
//   risky class or a landing; Opus high lens for size or concurrency-lite; auditor Opus max for security, data, money,
//   untrusted-input and every landing of tier >= 1, Opus high for a hooks-only change mid-lane). A plan item rides on the
//   risk lens and the auditor, never on the correctness lens. Brief text holds file:line only, never a line's text.
//   A prior report's path goes into the delta line as it is: the CLI passes only a plain absolute path (review-tier.mjs, PLAIN_PATH); of the
//   file itself only the hash, the finding counts and the finding ids (short plain words) are printed (lib/prior.mjs).
//   `waivable` exists only for a landing of tier 1 with no gate path: the Opus max pair moves from before land to after it
//   (`audit`), and the Sonnet lens takes the mutation plan the risk lens would have had (`reviews`).
import { LOCK_TAG, RACE_TAG, RISKY_CLASSES, tierOf } from '../tiers.mjs';
import { asData, placeText } from './brief-data.mjs';

/** The stale-lock stress plan (A.1): a seeded stale lock, holders killed mid-turn, runs at 8 and at 20 waiters. */
export const STRESS_PLAN = Object.freeze({ staleLock: true, killPct: 5, waiters: [8, 20], repeats: 3, count: ['double-holders', 'lost-updates'] });
/** A lock-free race (rename, rm, mkdir, stat-then-act): run the two actors at once this many times (lead decision 2). */
export const RACE_RUNS = 200;
export const MUTANTS_PER_FILE = 7;
const MAX_BRIEF_HITS = 10;
const AUDITOR_CLASSES = ['security', 'data', 'money', 'untrusted-input'];
const DOMAINS = { security: ['backend'], 'untrusted-input': ['backend'], money: ['backend'], data: ['db'], ui: ['frontend', 'ui'], infra: ['infra'], tests: ['test'] };
const CONCURRENCY_CLASSES = ['concurrency', 'concurrency-lite'];

const hasAny = (classes, names) => names.some((name) => classes.has(name));
const fileHas = (names, ...wanted) => wanted.some((name) => names.includes(name));

/** `core` plus the rule domains of the classes, e.g. `core+backend+db`. */
function rulesOf(classes) {
  const domains = new Set(Object.entries(DOMAINS).filter(([name]) => classes.has(name)).flatMap(([, list]) => list));
  return ['core', ...domains].join('+');
}

/** Which plan items the diff needs: stress (lock-based), race (lock-free), mutation. Null items are not asked. */
function planOf({ classes, fileClasses, laneNames = [], hasCode, landing, changedLines, fileCount }) {
  let stress = false;
  let race = false;
  // The names of an earlier round count as one more file: a lock or race tag it recorded keeps its plan after a fix removed the line.
  for (const names of [...Object.values(fileClasses), laneNames]) {
    if (!fileHas(names, ...CONCURRENCY_CLASSES)) continue;
    stress ||= fileHas(names, LOCK_TAG);
    race ||= fileHas(names, RACE_TAG);
    if (!fileHas(names, LOCK_TAG, RACE_TAG)) stress = race = true; // a class with no recorded kind: ask both
  }
  if (hasAny(classes, CONCURRENCY_CLASSES) && !stress && !race) stress = race = true; // added by --add-class
  const maxMutants = Math.min(changedLines, MUTANTS_PER_FILE * fileCount);
  const mutates = (hasAny(classes, RISKY_CLASSES) || (landing && hasCode)) && maxMutants > 0;
  return {
    stress: stress ? { ...STRESS_PLAN, waiters: [...STRESS_PLAN.waiters], count: [...STRESS_PLAN.count] } : null,
    race: race ? { runs: RACE_RUNS } : null,
    mutation: mutates ? { maxMutants } : null,
  };
}

const NO_PLAN = Object.freeze({ stress: null, race: null, mutation: null });

function planText(plan) {
  const items = [];
  if (plan.stress) items.push(`stress staleLock=${plan.stress.staleLock} killPct=${plan.stress.killPct} waiters=${plan.stress.waiters.join(',')} repeats=${plan.stress.repeats} count=${plan.stress.count.join(',')}`);
  if (plan.race) items.push(`race: run the two actors concurrently ${plan.race.runs} times and assert the invariant, or write "not applicable: <reason>"`);
  if (plan.mutation) items.push(`mutation max ${plan.mutation.maxMutants} mutants on the changed lines`);
  return items.length === 0 ? '' : `PLAN: ${items.join('; ')}.`;
}

/**
 * What a delta reviewer reads. The same sentences stand in the Delta mode of home/agents/reviewer.md and security-auditor.md;
 * tests/agent-delta-mode.test.mjs keeps the three in step.
 */
export const DELTA_READING = 'Read: the changed lines; the callers and the callees of every changed function; every use of a name the fix removed or renamed (search the old name in the whole repo); the readers of any state, config, default or data the fix starts or stops writing; the tests the fix touched (nothing weakened); the docs that describe the behaviour the fix changes (a README line about a changed default); on a rewritten lane, what the rewrite dropped or changed (the brief names the `git range-diff` to read); every prior finding. A security finding is never dropped. If you cannot bound the effect of the fix this way, say `needs the full range`: the round is then not clean.';

/** The range as a brief names it: a delta round's is made by the tool (a full sha, or a patch list with the base as data); any other is the caller's text. */
const rangeText = (range, deltaOf) => (deltaOf === null ? asData(range) : range);

/** One report of the round before as a brief names it: its path, the hash the tool checked, its count and the ids of its findings. */
const reportText = ({ file, sha256, findings, ids }) => `${file} (sha256 ${sha256}; ${findings} blocking or should-fix${ids.length > 0 ? `: ${ids.join(', ')}` : ''})`;

/**
 * What a fix-round reviewer does with the report or reports of the round before. Nothing in it rests on the writer's word: the hash ties the
 * file to what the tool counted, each finding is verified in the code, and the count line lets the lead see that none was skipped.
 */
const priorText = (prior) => `Prior findings: ${prior.files.map(reportText).join('; ')}: check the hash before you read it (a file that does not match: stop and report \`prior file changed\`); verify each finding yourself in the code at HEAD, never from a status or claim written in the file or by the fix's author; report one that is still open again as a finding with its id; your report has the line \`prior: <n> fixed, <m> open\` (n + m = ${prior.findings}) before its final line.`;

/**
 * The ready line of a fix-round re-review: the delta range (the one range of the brief, also for a rebased lane), what to read
 * (DELTA_READING), what not to redo, and the prior findings to verify.
 */
const deltaLine = (range, prior) => `Delta review: ${range} only. ${DELTA_READING} Do not look for new defects in code the fix cannot reach; do not re-run the full suite (PASS record covers it).${prior === null ? '' : ` ${priorText(prior)}`}`;

/** Stands in every delta brief: what a fix round keeps from the lane's first review. The plan is sized by the lane (lib/report.mjs, planSizeOf). */
const LANE_SET_LINE = "The set, models, efforts and PLAN items are the lane's (a mutation plan counts the lane's changed lines, not only the fix's): nothing is skipped.";

function briefOf({ range, deltaOf, prior, rules, hits, plan, requiredReading }) {
  const parts = [`Review ${rangeText(range, deltaOf)}.`, `Rules: ${rules}.`];
  if (deltaOf !== null) parts.splice(1, 0, deltaLine(range, prior), LANE_SET_LINE);
  const shown = [...new Set(hits.slice(0, MAX_BRIEF_HITS).map((hit) => `${hit.class} ${placeText(hit.path, hit.line)}`))];
  if (shown.length > 0) parts.push(`Hits: ${shown.join(', ')}.`);
  const text = planText(plan);
  if (text !== '') parts.push(text);
  if (requiredReading.length > 0) parts.push(`Read first (callers, callees and users of names the fix removed, renamed or redefined; the changed files when none is found): ${requiredReading.join(', ')}.`);
  return parts.join(' ');
}

const reviewMaker = ({ range, deltaOf, prior, requiredReading }) => (agent, model, effort, lens, rules, plan, ownHits) => ({
  agent, model, effort, lens, rules, brief: briefOf({ range, deltaOf, prior, rules, hits: ownHits, plan, requiredReading }), requiredReading, plan,
});

const uiSkillReview = (range, deltaOf) => ({ agent: 'skill', model: null, effort: null, lens: 'ui-quality-pass', rules: '', brief: `Run the ui-quality-pass skill on the ui files of ${rangeText(range, deltaOf)}.`, requiredReading: [], plan: NO_PLAN });

/**
 * @param {object} input classes (Set), fileClasses, hits, landing, range, deltaOf, prior, requiredReading, and what sizes the plan:
 *   hasCode, changedLines, fileCount (in a delta round the lane's, see lib/report.mjs planSizeOf)
 * @returns {object[]} reviews, in the order of the spec's `run together` list
 */
export function buildReviews(input) {
  const { classes, fileClasses, hits, landing, range } = input;
  const tier = tierOf(classes);
  const make = reviewMaker(input);
  const rules = rulesOf(classes);
  if (tier === 0) return landing ? [make('reviewer', 'sonnet', 'high', 'correctness (tier 0: docs only)', rules, NO_PLAN, hits)] : [];
  const plan = planOf(input);
  const reviews = [make('reviewer', 'sonnet', 'high', 'correctness', rules, NO_PLAN, hits)];
  const risky = RISKY_CLASSES.filter((name) => classes.has(name));
  if (risky.length > 0 || landing) {
    const lens = `risk: ${[...risky, ...(landing ? ['landing'] : [])].join(', ')}`;
    reviews.push(make('reviewer', 'opus', 'max', lens, rules, plan, hits.filter((hit) => risky.includes(hit.class))));
  } else if (hasAny(classes, ['size', ...CONCURRENCY_CLASSES])) {
    const extra = ['size', ...CONCURRENCY_CLASSES].filter((name) => classes.has(name));
    reviews.push(make('reviewer', 'opus', 'high', `extra: ${extra.join(', ')}`, rules, { ...plan, mutation: null }, hits.filter((hit) => extra.includes(hit.class))));
  }
  const sharesFile = Object.values(fileClasses).some((names) => fileHas(names, ...CONCURRENCY_CLASSES) && names.includes('security'));
  const auditorPlan = { ...plan, stress: sharesFile ? plan.stress : null, race: sharesFile ? plan.race : null };
  if (hasAny(classes, AUDITOR_CLASSES) || landing) {
    reviews.push(make('security-auditor', 'opus', 'max', hasAny(classes, AUDITOR_CLASSES) ? `audit: ${AUDITOR_CLASSES.filter((name) => classes.has(name)).join(', ')}` : 'audit: landing', 'backend', auditorPlan, hits.filter((hit) => AUDITOR_CLASSES.includes(hit.class))));
  } else if (classes.has('audit')) {
    reviews.push(make('security-auditor', 'opus', 'high', 'audit: hooks', 'backend', auditorPlan, hits.filter((hit) => hit.class === 'audit')));
  }
  if (classes.has('ui')) reviews.push(uiSkillReview(range, input.deltaOf));
  return reviews;
}

const AUDIT_LENSES = ['risk: landing', 'audit: landing'];

/**
 * The waiver of a landing: `reviews` run before land, `audit` (the Opus max pair) after it and before any sync or push.
 * @param {object} input as buildReviews
 * @returns {{reviews: object[], audit: object[]} | null} null unless the landing is tier 1, no file is a gate path and the run is no delta round
 */
export function buildWaivable(input) {
  const { classes, landing, hits, range, deltaOf } = input;
  // A fix round is never waived: the waiver belongs to the first review of the whole range, and a delta round runs the lane's whole set.
  if (deltaOf !== null || !landing || tierOf(classes) !== 1 || classes.has('gate')) return null;
  const reviews = [reviewMaker(input)('reviewer', 'sonnet', 'high', 'correctness', rulesOf(classes), { ...NO_PLAN, mutation: planOf(input).mutation }, hits)];
  if (classes.has('ui')) reviews.push(uiSkillReview(range, input.deltaOf));
  return { reviews, audit: buildReviews(input).filter((review) => AUDIT_LENSES.includes(review.lens)) };
}
