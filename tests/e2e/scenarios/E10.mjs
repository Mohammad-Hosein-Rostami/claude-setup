// E10, doctor (plan section 9, no claude session): `scripts/doctor.sh` of the checkout under test exits 0; a WARN does not fail
// it, and a finding the owner accepted (doctor-accepted) prints as INFO, so exit 0 is the whole check.
// It runs with the real HOME (plan-change): doctor checks the real ~/.claude links, settings and plugins, and only reads them
// (scripts/doctor.sh header: read-only report); the temp HOME would make every link check fail.
// Exports the scenario interface (run.mjs): id, title, model, minutes, needsShims, setup(ctx), run(ctx), check(ctx).
import { join } from 'node:path';
import { checkLine, LIMITS } from '../lib/checks.mjs';

export const id = 'E10';
export const title = 'doctor exits 0';
export const model = 'none';
export const minutes = LIMITS.defaultScenarioMinutes;
export const needsShims = false;

const DOCTOR_TIMEOUT_MS = 5 * 60_000;
const FINDING = /^(?:FAIL|WARN)\s+.*/gm;

export function setup(ctx) {
  ctx.mkdir(ctx.dir);
}

export function run(ctx) {
  ctx.notes.doctor = ctx.exec('bash', [join(ctx.setupFrom, 'scripts', 'doctor.sh')], {
    cwd: ctx.setupFrom, extra: { HOME: ctx.realHome, USERPROFILE: ctx.realHome }, timeoutMs: DOCTOR_TIMEOUT_MS,
  });
}

export function check(ctx) {
  const { doctor } = ctx.notes;
  const findings = String(doctor?.stdout ?? '').match(FINDING) ?? [];
  return [
    checkLine('doctor exits 0', 'exit 0 (WARN and accepted findings allowed)', `exit ${doctor?.code ?? '?'}; ${findings.slice(0, 5).join('; ') || 'no finding'}`,
      doctor?.code === 0),
  ];
}
