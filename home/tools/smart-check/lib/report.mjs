// Purpose: the smart check's report block (spec r9-smart-check 8), in a fixed form, one line each:
//   `checked: <kind level result, ...>` / `not checked: <kind (reason), ...>` / `suggest: /check <cat>` (only when a skipped heavy check
//   matters), then, only when there is something to act on, the findings (at most MAX_FINDING_LINES) and the hand-overs.
// Exports: reportBlock(outcome), mustAct(outcome), suggestions(outcome).
// Invariants: "pass" never covers a check that did not run: every row is in exactly one of checked / not checked; pure text, no I/O.
import { CATEGORY_OF } from './rules.mjs';
import { MAX_FINDING_LINES } from './runners.mjs';

const SHORT_REASON_CHARS = 60;
const RAN = ['pass', 'catch', 'owner']; // `owner`: the category is on, its own gate ran it
const short = (text) => (text.length > SHORT_REASON_CHARS ? `${text.slice(0, SHORT_REASON_CHARS - 3)}...` : text);
/** A not-run note means a heavier check matters (not "no file of that kind"). */
const MATTERS = /out of time|no running page|project references|could not judge|> \d+|no scoped runner|lens call failed/;

/** The `/check` categories worth suggesting: a planned check that could not run, or a deep step the lead was handed. */
export function suggestions({ runs }) {
  const cats = runs.filter((run) => (run.result === 'not-run' && MATTERS.test(run.note ?? '')) || run.result === 'error').map((run) => CATEGORY_OF[run.check]).filter(Boolean);
  return [...new Set(cats)];
}

/** True when the agent must act before it stops: a pinned block, a catch (not of a noisy, report-only kind), or a hand-over. */
export const mustAct = ({ pinned, runs }) => pinned.some((p) => p.block && p.findings.length) || runs.some((run) => (run.result === 'catch' && !run.reportOnly) || run.result === 'handoff');

/**
 * The report block.
 * @param {{pinned: {name: string, findings: string[], block: boolean}[], runs: {check: string, level: string, result: string, note?: string,
 *   reason: string, findings?: string[]}[], seconds: number, tokens: number, change: string}} outcome what run.mjs collected
 * @returns {string}
 */
export function reportBlock(outcome) {
  const { pinned, runs } = outcome;
  const pinnedFailed = pinned.filter((p) => p.findings.length);
  const ran = runs.filter((run) => RAN.includes(run.result));
  const notRun = runs.filter((run) => !RAN.includes(run.result));
  const status = mustAct(outcome) ? 'FAIL' : 'PASS';
  const checked = [`pinned ${pinned.length - pinnedFailed.length}/${pinned.length}${pinnedFailed.length ? ` (${pinnedFailed.map((p) => p.name).join(', ')} found)` : ''}`,
    ...ran.map((run) => `${run.check} ${run.level} ${run.result}`)];
  const notChecked = notRun.map((run) => `${run.check} (${short((run.note ?? run.reason).replace(`${run.check}: `, ''))})`);
  const lines = [
    `smart-check ${status} (${outcome.seconds.toFixed(1)} s, ${outcome.tokens} tokens, change ${outcome.change})`,
    `checked: ${checked.join(', ')}`,
    `not checked: ${notChecked.length ? notChecked.join(', ') : 'none'}`,
  ];
  const cats = suggestions(outcome);
  if (cats.length) lines.push(`suggest: /check ${cats.join(' ')}`);
  const findings = [...pinnedFailed.flatMap((p) => p.findings.map((line) => `${p.block ? '' : '(report only) '}${p.name}: ${line}`)), ...runs.flatMap((run) => run.findings ?? [])];
  lines.push(...findings.slice(0, MAX_FINDING_LINES));
  if (findings.length > MAX_FINDING_LINES) lines.push(`... ${findings.length - MAX_FINDING_LINES} more`);
  lines.push(...runs.filter((run) => run.result === 'handoff').map((run) => `do: ${run.note}`));
  return lines.join('\n');
}
