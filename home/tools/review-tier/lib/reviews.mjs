// Purpose: turn a set of classes into the reviews to run together (agent, model, effort, lens, brief) and their plans.
// Exports: STRESS_PLAN, RACE_RUNS, MUTANTS_PER_FILE, buildReviews(input), buildWaivable(input).
// Invariants: only ADDS checks (I1, one exception: `waivable`, below): efforts are today's (Sonnet high correctness lens always at tier >= 1; Opus max lens for a
//   risky class or a landing; Opus high lens for size or concurrency-lite; auditor Opus max for security, data, money,
//   untrusted-input and every landing of tier >= 1, Opus high for a hooks-only change mid-lane). A plan item rides on the
//   risk lens and the auditor, never on the correctness lens. Brief text holds file:line only, never a line's text.
//   `waivable` exists only for a landing of tier 1 with no gate path: the Opus max pair moves from before land to after it
//   (`audit`), and the Sonnet lens takes the mutation plan the risk lens would have had (`reviews`).
import { LOCK_TAG, RACE_TAG, RISKY_CLASSES, tierOf } from '../tiers.mjs';

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
function planOf({ classes, fileClasses, hasCode, landing, changedLines, fileCount }) {
  let stress = false;
  let race = false;
  for (const names of Object.values(fileClasses)) {
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

const hitText = (hit) => (hit.line > 0 ? `${hit.path}:${hit.line}` : hit.path);

/**
 * The ready line of a fix-round re-review: the delta range, what to read outside it (a fix can break a caller, or a reader of
 * what it writes that never calls it), the prior findings to close, and what not to redo.
 */
const deltaLine = (deltaOf, priorFile) => `Delta review: ${deltaOf}..HEAD only, plus callers of changed lines and the code that reads the shared state, config or data those lines write; prior findings file: ${priorFile ?? 'none'} - mark each closed/open; do not re-review unchanged lines beyond those; do not re-run the full suite (PASS record covers it).`;

function briefOf({ range, deltaOf, priorFile, rules, hits, plan, requiredReading }) {
  const parts = [`Review ${range}.`, `Rules: ${rules}.`];
  if (deltaOf !== null) parts.splice(1, 0, deltaLine(deltaOf, priorFile), "Each file keeps the lane's classes.");
  const shown = [...new Set(hits.slice(0, MAX_BRIEF_HITS).map((hit) => `${hit.class} ${hitText(hit)}`))];
  if (shown.length > 0) parts.push(`Hits: ${shown.join(', ')}.`);
  const text = planText(plan);
  if (text !== '') parts.push(text);
  if (requiredReading.length > 0) parts.push(`Read first (callers and callees): ${requiredReading.join(', ')}.`);
  return parts.join(' ');
}

const reviewMaker = ({ range, deltaOf, priorFile, requiredReading }) => (agent, model, effort, lens, rules, plan, ownHits) => ({
  agent, model, effort, lens, rules, brief: briefOf({ range, deltaOf, priorFile, rules, hits: ownHits, plan, requiredReading }), requiredReading, plan,
});

const uiSkillReview = (range) => ({ agent: 'skill', model: null, effort: null, lens: 'ui-quality-pass', rules: '', brief: `Run the ui-quality-pass skill on the ui files of ${range}.`, requiredReading: [], plan: NO_PLAN });

/**
 * @param {object} input classes (Set), fileClasses, hits, landing, range, deltaOf, priorFile, requiredReading, hasCode, changedLines, fileCount
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
  if (classes.has('ui')) reviews.push(uiSkillReview(range));
  return reviews;
}

const AUDIT_LENSES = ['risk: landing', 'audit: landing'];

/**
 * The waiver of a landing: `reviews` run before land, `audit` (the Opus max pair) after it and before any sync or push.
 * @param {object} input as buildReviews
 * @returns {{reviews: object[], audit: object[]} | null} null unless the landing is tier 1 and no file is a gate path
 */
export function buildWaivable(input) {
  const { classes, landing, hits, range } = input;
  if (!landing || tierOf(classes) !== 1 || classes.has('gate')) return null;
  const reviews = [reviewMaker(input)('reviewer', 'sonnet', 'high', 'correctness', rulesOf(classes), { ...NO_PLAN, mutation: planOf(input).mutation }, hits)];
  if (classes.has('ui')) reviews.push(uiSkillReview(range));
  return { reviews, audit: buildReviews(input).filter((review) => AUDIT_LENSES.includes(review.lens)) };
}
