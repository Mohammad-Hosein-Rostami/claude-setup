// Purpose: assemble the review-tier report (classes, tier, reviews) from parsed diffs, and print it as text or JSON.
// Exports: buildReport(input), formatText(report), formatJson(report), logRecord(report, repoName, now).
// Invariants: pure (no git, no files); never holds or prints a line's text, only class, path and line number.
//   `principles` are the ids the hits ask the brief to carry (sorted by number); `weakened` lists lines that weaken a check;
//   `waivable` is null unless the landing is tier 1 with no gate path.
//   `--lane-classes` keeps each file's highest classes (I4): a file's classes are the union of its earlier and new ones.
//   `--add-class` only raises: an added class is unioned into the set, never removed.
import { CLASS_TIER, LOCK_TAG, PRINCIPLES_BY_TRIGGER, RACE_TAG, classifyFiles, isCodeFile, isSizeable, tierOf } from '../tiers.mjs';
import { buildReviews, buildWaivable } from './reviews.mjs';
import { weakenedChecks } from './weakened.mjs';

const TAGS = [LOCK_TAG, RACE_TAG];
const FIX_ROUND_COMMAND = 'node ~/.claude/tools/review-tier/review-tier.mjs --delta <reviewed-sha> --lane-classes <previous-round-json> --landing';

/** Union of two class lists, in display order (classes first, then tags). */
const union = (a, b) => [...Object.keys(CLASS_TIER), ...TAGS].filter((name) => a.includes(name) || b.includes(name));

const principleNumber = (id) => Number(id.slice(1));

/** The principle ids of the triggers, unique and sorted by number (P2 before P12). */
const principlesOf = (triggers) => [...new Set([...triggers].flatMap((trigger) => PRINCIPLES_BY_TRIGGER[trigger]))].sort((a, b) => principleNumber(a) - principleNumber(b));

/**
 * @param {object} input files (parsed diff), readNewFile, landing, addClasses, laneClasses (a previous fileClasses map or null),
 *   range, deltaOf, requiredReading
 * @returns {object} the JSON of section 9
 */
export function buildReport({ files, readNewFile, landing, addClasses, laneClasses, range, deltaOf, requiredReading }) {
  const { fileClasses: fresh, hits, changedLines, triggers } = classifyFiles(files, readNewFile);
  const fileClasses = {};
  for (const [path, names] of Object.entries(fresh)) fileClasses[path] = union(names, laneClasses?.[path] ?? []);
  const classes = new Set(Object.values(fileClasses).flat().filter((name) => name in CLASS_TIER));
  if (isSizeable(changedLines)) classes.add('size');
  const added = addClasses.filter((name) => !classes.has(name));
  for (const name of addClasses) classes.add(name);
  const hasCode = files.some((file) => isCodeFile(file.path));
  const reviewInput = { classes, fileClasses, hits, landing, range, deltaOf, requiredReading, hasCode, changedLines, fileCount: files.length };
  return {
    tier: tierOf(classes),
    classes: Object.keys(CLASS_TIER).filter((name) => classes.has(name)),
    added,
    landing,
    range,
    files: files.length,
    changedLines,
    hits,
    fileClasses: { ...laneClasses, ...fileClasses },
    reviews: buildReviews(reviewInput),
    waivable: buildWaivable(reviewInput),
    weakened: weakenedChecks(files),
    principles: principlesOf(triggers),
    deltaOf,
  };
}

const hitText = (hit) => (hit.line > 0 ? `${hit.path}:${hit.line}` : hit.path);

/** The text output of A.1: summary line, `why:` (first hit per class), `run together:` and the fix-round command. */
export function formatText(report) {
  const lines = [`review-tier: tier ${report.tier} (${report.classes.join(', ') || 'none'}), ${report.files} files, ${report.changedLines} changed lines, ${report.range}`];
  lines.push('why:');
  for (const name of report.classes) {
    const hit = report.hits.find((candidate) => candidate.class === name);
    lines.push(`  ${name}${hit ? ` ${hitText(hit)}` : report.added.includes(name) ? ' (added by --add-class)' : ''}`);
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
  lines.push(`weakened: ${report.weakened.length === 0 ? 'none' : report.weakened.map((entry) => `${entry.path}:${entry.line} ${entry.kind}`).join(', ')}`);
  lines.push(`principles: ${report.principles.join(', ') || 'none'}`);
  lines.push(`fix round: ${FIX_ROUND_COMMAND}`);
  return lines.join('\n');
}

export const formatJson = (report) => JSON.stringify(report, null, 2);

/** The one log line of a run (no paths, no line text). */
export const logRecord = (report, repoName, now) => ({
  ts: now.toISOString(), repo: repoName, range: report.range, tier: report.tier, classes: report.classes,
  files: report.files, changedLines: report.changedLines, landing: report.landing, added: report.added,
});
