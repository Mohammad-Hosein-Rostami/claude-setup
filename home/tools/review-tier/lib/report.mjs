// Purpose: assemble the review-tier report (classes, tier, reviews) from parsed diffs, and print it as text or JSON.
// Exports: FIX_ROUND_COMMAND, fixRoundCommand(report), buildReport(input), formatText(report), formatJson(report), logRecord(report, repoName, now).
// Invariants: pure (no git, no files); never holds or prints a line's text, only class, path and line number. The text output writes
//   paths and a caller's range as data (lib/brief-data.mjs); the JSON keeps them as they are (JSON strings).
//   `principles` are the ids the hits ask the brief to carry (sorted by number); `weakened` lists lines that weaken a check;
//   `waivable` is null unless the landing is tier 1 with no gate path, and always null in a delta round.
//   A delta round (`laneFiles` given) is never lighter than the lane: its classes are those of the whole lane, of the earlier rounds
//   (`--lane-classes`: the names the round before printed, which hold what a fix removed and what the lead added) and of the delta;
//   files, lines and hits are the delta's, and the plan is sized by the lane's files and lines, as in the lane's first review (planSizeOf).
//   `--lane-classes` and `--add-class` only raise: a name is unioned into the set, never removed. `laneClasses` is what the next round
//   is given: every class of this round and the lock or race tag of its concurrency lines; `base` and `tip` are that round's two shas.
import { CLASS_TIER, LOCK_TAG, PRINCIPLES_BY_TRIGGER, RACE_TAG, classifyFiles, isCodeFile, isSizeable, tierOf } from '../tiers.mjs';
import { asData, placeText } from './brief-data.mjs';
import { buildReviews, buildWaivable } from './reviews.mjs';
import { weakenedChecks } from './weakened.mjs';
import { readFileSync } from 'node:fs';

// What the lead does with a set (the review procedure that left the always-loaded home/CLAUDE.md, spec-p6 r9-text-procedures):
// review-steps.md beside the tool, read once and printed with every text report, before its `prior:` and `fix round:` lines. A missing file prints a line saying so, never throws.
const STEPS_FILE = new URL('../review-steps.md', import.meta.url);
const HTML_COMMENT = /<!--[\s\S]*?-->\n?/g;
const readSteps = () => {
  try {
    return readFileSync(STEPS_FILE, 'utf8').replace(HTML_COMMENT, '').trim();
  } catch (error) {
    return `(review steps unreadable: ${error.code ?? error.message}; see home/tools/review-tier/review-steps.md)`;
  }
};
const REVIEW_STEPS = readSteps();

const TAGS = [LOCK_TAG, RACE_TAG];
/**
 * The whole command of a fix round's re-review; home/CLAUDE.md names the same one (a test keeps them in step). Every part is required:
 * the two commits are full shas (no name is looked up in a fix round), without `--lane-classes` a round after a fix that removed a
 * class's lines would be lighter than the lane's first review, and without the recorded hash a report edited after the review would
 * pass as the reviewer's. `--prior` and its hash repeat once per report.
 */
export const FIX_ROUND_COMMAND = 'node ~/.claude/tools/review-tier/review-tier.mjs --delta <reviewed-sha> --base <base-sha> --prior <findings-file> --prior-sha256 <its-sha256> --lane-classes <classes>';

/**
 * The command as a round prints it for its own fix round: the commit it read, the lane start it resolved and its classes are filled in,
 * so the lead copies shas and names the tool itself resolved; the report file and its hash stay for the lead to fill.
 */
export const fixRoundCommand = ({ tip, base, laneClasses }) => FIX_ROUND_COMMAND
  .replace('<reviewed-sha>', tip ?? '<reviewed-sha>').replace('<base-sha>', base ?? '<base-sha>').replace('<classes>', laneClasses.join(',') || '<classes>');
const KEPT_FROM_LANE = ' (kept from the lane)';

/** Union of two class lists, in display order (classes first, then tags). */
const union = (a, b) => [...Object.keys(CLASS_TIER), ...TAGS].filter((name) => a.includes(name) || b.includes(name));

/** Two path -> classes maps as one: a path in both gets the union of its lists. */
const mergedClasses = (a, b) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((path) => [path, union(a[path] ?? [], b[path] ?? [])]));

const principleNumber = (id) => Number(id.slice(1));

/** The principle ids of the triggers, unique and sorted by number (P2 before P12). */
const principlesOf = (triggers) => [...new Set([...triggers].flatMap((trigger) => PRINCIPLES_BY_TRIGGER[trigger]))].sort((a, b) => principleNumber(a) - principleNumber(b));

/**
 * The classes of a run and where each file's come from.
 * @param {object} fresh the run's own classification (classifyFiles of its files)
 * @param {object | null} lane the classification of the whole lane, null outside a delta round
 * @param {string[]} laneNames the class and tag names of an earlier round (`--lane-classes`)
 * @returns {{fileClasses: object, classes: Set<string>, own: Set<string>}} `own`: the classes the run's own files and lines give
 */
function classesOf(fresh, lane, laneNames) {
  // Outside a delta round only the files of the range count; a delta round keeps every file the lane has.
  const fileClasses = lane === null ? fresh.fileClasses : mergedClasses(fresh.fileClasses, lane.fileClasses);
  const own = new Set(Object.values(fresh.fileClasses).flat().filter((name) => Object.hasOwn(CLASS_TIER, name)));
  if (isSizeable(fresh.changedLines)) own.add('size');
  const classes = new Set([...own, ...[...Object.values(fileClasses).flat(), ...laneNames].filter((name) => Object.hasOwn(CLASS_TIER, name))]);
  return { fileClasses, classes, own };
}

/**
 * What the plan is sized by (`hasCode`, `changedLines`, `fileCount`: whether mutants are asked, and how many). In a delta round these
 * are the lane's, as in its first review: a docs-only or tests-only fix of a code lane keeps the mutation plan, where a rewritten test
 * must still kill the lane's mutants (review B1b of lane r7-delta). The fix's own numbers count when they are larger (a file the fix
 * removed altogether is in no lane diff any more).
 */
function planSizeOf(files, changedLines, laneFiles, lane) {
  const all = [...files, ...(laneFiles ?? [])];
  return { hasCode: all.some((file) => isCodeFile(file.path)), changedLines: Math.max(changedLines, lane?.changedLines ?? 0), fileCount: Math.max(files.length, laneFiles?.length ?? 0) };
}

/**
 * @param {object} input files (parsed diff of the range or delta), laneFiles (parsed diff of the whole lane in a delta round, else
 *   null), readNewFile, landing, addClasses, laneNames (the class and tag names of an earlier round, `--lane-classes`), range, deltaOf,
 *   prior (lib/prior.mjs readPriors of the `--prior` files, or null), requiredReading, base and tip (the shas a fix round of this run is given)
 * @returns {object} the JSON of section 9, plus `kept` (classes of a delta round that come from the lane, not from the fix), `prior` and `priorFiles` (their paths)
 */
export function buildReport({ files, laneFiles = null, readNewFile, landing, addClasses, laneNames = [], range, deltaOf, prior = null, requiredReading, base = null, tip = null }) {
  const fresh = classifyFiles(files, readNewFile);
  const { hits, changedLines, triggers } = fresh;
  const lane = laneFiles === null ? null : classifyFiles(laneFiles, readNewFile);
  const { fileClasses, classes, own } = classesOf(fresh, lane, laneNames);
  const added = addClasses.filter((name) => !classes.has(name));
  const kept = [...classes].filter((name) => !own.has(name));
  for (const name of addClasses) classes.add(name);
  const reviewInput = { classes, fileClasses, laneNames, hits, landing, range, deltaOf, prior, requiredReading, ...planSizeOf(files, changedLines, laneFiles, lane) };
  const tags = TAGS.filter((tag) => laneNames.includes(tag) || Object.values(fileClasses).some((names) => names.includes(tag)));
  const inOrder = (names) => Object.keys(CLASS_TIER).filter((name) => names.includes(name));
  return {
    tier: tierOf(classes),
    classes: inOrder([...classes]),
    added,
    kept: inOrder(kept),
    landing,
    range,
    files: files.length,
    changedLines,
    hits,
    fileClasses,
    laneClasses: [...inOrder([...classes]), ...tags],
    base,
    tip,
    reviews: buildReviews(reviewInput),
    waivable: buildWaivable(reviewInput),
    weakened: weakenedChecks(files).map((entry) => ({ ...entry, place: placeText(entry.path, entry.line) })),
    principles: principlesOf(triggers),
    deltaOf,
    prior,
    priorFiles: prior === null ? [] : prior.files.map((report) => report.file),
  };
}

/** The text output of A.1: summary line, `why:` (first hit per class, or where a class without one comes from), `run together:` and the fix-round command. */
export function formatText(report) {
  const lines = [`review-tier: tier ${report.tier} (${report.classes.join(', ') || 'none'}), ${report.files} files, ${report.changedLines} changed lines, ${report.deltaOf === null ? asData(report.range) : report.range}`];
  lines.push('why:');
  for (const name of report.classes) {
    const hit = report.hits.find((candidate) => candidate.class === name);
    lines.push(`  ${name}${hit ? ` ${placeText(hit.path, hit.line)}` : report.added.includes(name) ? ' (added by --add-class)' : report.kept.includes(name) ? KEPT_FROM_LANE : ''}`);
  }
  if (report.reviews.length === 0) lines.push('run: none (docs only); checks still run');
  else {
    lines.push('run together:');
    for (const review of report.reviews) {
      const who = review.agent === 'skill' ? 'skill' : `${review.agent} ${review.model} ${review.effort}`;
      lines.push(`- ${who}, lens ${review.lens}: ${review.brief}`);
    }
  }
  lines.push(report.waivable === null ? 'waivable: no' : `waivable: yes (${report.waivable.reviews.length} review before land, ${report.waivable.audit.length} audit after it)`);
  lines.push(`weakened: ${report.weakened.length === 0 ? 'none' : report.weakened.map((entry) => `${entry.place} ${entry.kind}`).join(', ')}`);
  lines.push(`principles: ${report.principles.join(', ') || 'none'}`);
  lines.push(`steps: ${REVIEW_STEPS.replace(/^- Reviews: /, '')}`);
  for (const file of report.prior?.files ?? []) lines.push(`prior: ${file.file} sha256 ${file.sha256}, ${file.blocking} blocking, ${file.shouldFix} should-fix${file.ids.length > 0 ? `, ids ${file.ids.join(', ')}` : ''}`);
  // The line carries the round's own shas and every class it had (one the lead added by hand too): copied as it is, the fix round loses nothing.
  lines.push(`fix round: ${fixRoundCommand(report)}`);
  return lines.join('\n');
}

export const formatJson = (report) => JSON.stringify(report, null, 2);

/** The one log line of a run (no paths, no line text). */
export const logRecord = (report, repoName, now) => ({
  ts: now.toISOString(), repo: repoName, range: report.range, tier: report.tier, classes: report.classes,
  files: report.files, changedLines: report.changedLines, landing: report.landing, added: report.added,
});
