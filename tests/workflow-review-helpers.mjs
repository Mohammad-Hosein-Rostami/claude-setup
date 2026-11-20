// Shared fixtures for the review.js workflow tests: what a well-behaved tier runner and lens return in a delta round, where the
//   script asks for the prior findings file and the `prior: <n> fixed, <m> open` line (lane r7-delta, decision D3).
// Exports: priorOfTierPrompt(prompt), withPriorLine(prompt, reply).
// Invariants: both read only the prompt the script sent, the way the real runner and lens would; outside a delta round they add nothing.

const FINDING_LINE = /^- \[(?:blocking|should-fix)\] /gm;
const FAKE_SHA256 = 'ab'.repeat(32);

/**
 * The `prior` object review-tier prints for the one file the tier prompt tells the runner to write: one finding per `- [severity]` line.
 * @returns {object} `{ prior }` to spread into the tier JSON, or `{}` when the prompt asks for no `--prior`
 */
export function priorOfTierPrompt(prompt) {
  if (!/ --prior /.test(prompt)) return {};
  const findings = (prompt.match(FINDING_LINE) ?? []).length;
  return { prior: { files: [{ file: '/scratch/close-2-prior.md', sha256: FAKE_SHA256, blocking: findings, shouldFix: 0, findings, ids: [] }], blocking: findings, shouldFix: 0, findings } };
}

/**
 * A lens reply with the `prior` line of a lens that verified every prior finding as fixed; a reply that sets `prior` itself, a
 * stopped lens (null) and a round with no prior file stay as they are. `reply` may be a promise (a lens a test holds back).
 */
export async function withPriorLine(prompt, reply) {
  const result = await reply;
  const asked = /over those (\d+) findings/.exec(prompt);
  if (asked === null || result === null || typeof result !== 'object' || 'prior' in result) return result;
  return { ...result, prior: `prior: ${asked[1]} fixed, 0 open` };
}
