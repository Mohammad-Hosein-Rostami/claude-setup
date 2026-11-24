// Purpose: the UI step of `git-tidy land` (ui-kinds-spec.md section 3): the check plan of base..tip and its proof, by `ui-proof check
//   --plan` of the tool next to this one. That command recomputes the plan from the diff, the brief and the lane matrix; nothing a lane
//   writes about itself feeds it (P14).
// Exports: runPlanCheck({ repoDir, baseSha, tip, brief, matrix }) -> { why, plan, depth }, PLAN_CHECK_TIMEOUT_MS.
// Invariants (P3): a check that cannot start, times out or prints no verdict is a refusal, never a pass. A plan other than none needs the
//   brief: without it the owner's request is unread and the plan may be too light. `plan` (the pointer a landing row ends with, ` (ui plan
//   <depth>: proved)`) is set only for a proved plan that printed its depth and is not pixel: the visual and pixel chains print today's
//   pixel-qa check, so their output stays as before (F5); a none plan sets it only when a UI file changed (a docs page), so a lane with no
//   UI file lands with the output it had before.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changedUiFiles } from '../../ui-proof/lib/ui-files.mjs';

export const PLAN_CHECK_TIMEOUT_MS = 120_000; // the plan reads the screens of both commits (cached) and the proof records
const UI_PROOF = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui-proof', 'ui-proof.mjs');
const MAX_OUTPUT_BYTES = 16 << 20;
const PLAN_LINE = /^plan: (\S+)$/; // the first line `ui-proof check --plan` prints for a planned check
const VERDICT = 'ui-proof: ';
const FAIL = 'ui-proof: FAIL';
const FOLLOW_UP = 'follow-up: ';

const linesOf = (text) => String(text ?? '').split('\n').map((line) => line.trimEnd()).filter((line) => line !== '');

/** The `ui-proof check --plan` arguments; the brief is the request and the lane matrix adds its frames, widths and locales. */
const checkArgs = ({ repoDir, baseSha, tip, brief, matrix }) => ['check', '--tip', tip, '--plan', '--base', baseSha,
  ...(brief === null ? [] : ['--request', brief]), ...(matrix === null ? [] : ['--matrix', matrix]), '--repo', repoDir];

/** The failing line of a check that did not exit 0: its FAIL line, else its first line, else why it did not finish. */
function failureOf(run, lines) {
  const fail = lines.find((line) => line.startsWith(FAIL));
  if (fail !== undefined) return fail;
  const first = lines[0] ?? linesOf(run.stderr)[0];
  return first ?? `ui-proof check did not finish (${run.error?.message ?? `exit ${run.status}`})`;
}

/**
 * The check plan of `baseSha..tip` and whether the proof records hold it.
 * @param {{ repoDir: string, baseSha: string, tip: string, brief?: string|null, matrix?: string|null }} input full shas; brief: the lane's
 *   brief file (the request); matrix: the lane's coverage matrix (absolute), null for none
 * @returns {{ why: string|null, plan: { depth: string, followUps: string[] }|null, depth: string|null }} why: null when the plan is
 *   proved, else the line that says what is missing (for a visual or pixel plan the same line `ui-proof check --tip` gives); plan: the
 *   row's pointer (see the header); depth: the plan's depth as printed, null when the check printed today's pixel-qa check
 */
export function runPlanCheck({ repoDir, baseSha, tip, brief = null, matrix = null }) {
  const run = spawnSync(process.execPath, [UI_PROOF, ...checkArgs({ repoDir, baseSha, tip, brief, matrix })],
    { encoding: 'utf8', timeout: PLAN_CHECK_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, shell: false });
  const lines = linesOf(run.stdout);
  const depth = PLAN_LINE.exec(lines[0] ?? '')?.[1] ?? null; // null: a visual or pixel plan, printed as today's pixel-qa check
  if (run.error !== undefined || run.status !== 0) return { why: failureOf(run, lines), plan: null, depth };
  if (!lines.some((line) => line.startsWith(VERDICT))) return { why: 'ui-proof check --plan printed no verdict line, so the plan is not proved', plan: null, depth };
  if (brief === null && depth !== 'none') {
    const named = depth ?? 'visual or pixel';
    return { why: `the lane changes the app (plan ${named}) and no --brief was given: the plan must read the lane's brief (land again with --brief <file>)`, plan: null, depth: named };
  }
  if (depth === null || depth === 'pixel') return { why: null, plan: null, depth };
  if (depth === 'none' && changedUiFiles(repoDir, baseSha, tip).length === 0) return { why: null, plan: null, depth };
  return { why: null, plan: { depth, followUps: lines.filter((line) => line.startsWith(FOLLOW_UP)) }, depth };
}
