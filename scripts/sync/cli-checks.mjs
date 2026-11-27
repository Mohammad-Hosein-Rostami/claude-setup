// Purpose: the pure checks of scripts/sync-machines.mjs: reading a machine's claude report, comparing the machines, and the floor.
// Exports: VERSION, CLAUDE_FLOOR, CLAUDE_READ, NODE_READ, atLeast, readReport, cliProblems, afterInstallProblem.
// Invariants: fail closed: a missing or unreadable value (version, pin) is a problem for that machine, never a pass. A problem
//   names its real cause: a target ssh did not reach, a claude not on the remote PATH, and a claude that gave no version differ.

export const VERSION = /^\d+\.\d+\.\d+$/;
/**
 * The oldest Claude Code every machine must run: the floor every phase pins (spec-p0-close.md 0.7). npm's stable channel gives
 * 2.1.323, below it. It lived in scripts/doctor.sh until doctor was removed (guard-removal plan, 2026-11-25). The installer's
 * --claude-version refuses a version below it too (scripts/install/cli.mjs).
 */
export const CLAUDE_FLOOR = '2.1.326';

const CLAUDE_MISSING = 'claude is not on the PATH of the ssh shell';
/**
 * The remote `== version` section: the claude path and its version, or CLAUDE_MISSING with the PATH searched, so a missing claude
 * is not reported as "gave no version". No single quote inside: it sits in the '...' of the ssh command.
 */
export const CLAUDE_READ = `echo "== version"; if command -v claude; then claude --version; else echo "${CLAUDE_MISSING} (PATH=$PATH)"; fi`;
/** The remote `== node` section: the node the install on that machine ran (install.sh runs the first node on its PATH). */
export const NODE_READ = 'echo "== node"; command -v node';

/** The sections of a remote read: `== name` header lines, each followed by the lines of its output. */
function sections(text) {
  const found = {};
  let name = null;
  for (const line of text.split('\n')) {
    const header = /^== (.+)$/.exec(line);
    if (header) { name = header[1]; found[name] = []; } else if (name) found[name].push(line);
  }
  return found;
}

/**
 * version, missing (the CLAUDE_MISSING line, else ''), channel, pinned, pin (the target's own local.json pin), checkout, sha and
 * node (the NODE_READ path, else '') from a target's remote output.
 */
export function readReport(text) {
  const found = sections(text);
  const settings = (found.settings ?? []).join('\n');
  const pinText = (found.pin ?? []).join('\n');
  const pinLine = (found.pin ?? []).find((line) => line.trim().startsWith('{'));
  let pin = null; // null: unreadable
  try { pin = pinLine ? String(JSON.parse(pinLine).cliVersion ?? '') : null; } catch { pin = null; }
  return {
    version: (found.version ?? []).map((line) => /^(\d+\.\d+\.\d+)\b/.exec(line.trim())?.[1]).find(Boolean) ?? '',
    missing: (found.version ?? []).find((line) => line.startsWith(CLAUDE_MISSING)) ?? '',
    channel: /autoUpdatesChannel"?\s*:\s*"([^"]+)"/.exec(settings)?.[1] ?? 'latest',
    pinned: /DISABLE_UPDATES"?\s*:\s*"?1\b/.test(settings) || /^DISABLE_UPDATES=1$/m.test((found['shell env'] ?? []).join('\n')),
    sha: (found.head ?? []).map((line) => line.trim()).find((line) => /^[0-9a-f]{40}$/.test(line)) ?? '',
    checkout: !pinText.includes('NO_CHECKOUT'),
    pin,
    node: (found.node ?? []).map((line) => line.trim()).find(Boolean) ?? '',
  };
}

/** True when `version` is `floor` or later (2.1.99 is older than 2.1.326). */
export function atLeast(version, floor) {
  const [a, b] = [version, floor].map((text) => text.split('.').map(Number));
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index];
  return true;
}

/**
 * Every reason a machine must not sync before the install, by machine name (fail closed: a missing value is a problem). A target
 * report with `unreachable` (ssh's own error) or `missing` (no claude on its PATH) gets that cause, not "gave no version".
 */
export function cliProblems(names, reports, { floor, localName, pin }) {
  const problems = Object.fromEntries(names.map((name) => [name, []]));
  names.forEach((machine, index) => {
    const report = reports[index];
    const add = (text) => problems[machine].push(`${machine}: ${text}`);
    if (report.unreachable) return add(`ssh did not reach it (sync again once it is on and reachable): ${report.unreachable}`);
    if (report.missing) return add(report.missing);
    if (!VERSION.test(report.version)) return add('claude --version gave no version');
    if (!atLeast(report.version, floor)) add(`claude ${report.version} is below the floor ${floor}`);
    if (!report.checkout) add('no checkout of the repo');
    if (machine === localName && !report.pinned) add('DISABLE_UPDATES=1 is not set, so the phase pin does not hold');
    if (report.pin === null) add('the pin in settings/local.json is unreadable');
    const wanted = machine === localName ? pin : report.pin;
    if (wanted && wanted !== report.version) add(`claude ${report.version}, but settings/local.json pins ${wanted}`);
  });
  for (const key of ['version', 'channel']) {
    if (new Set(reports.map((report) => report[key])).size > 1) {
      const text = `the machines differ in claude ${key}: ${names.map((name, index) => `${name} ${reports[index][key] || '?'}`).join(', ')}`;
      names.forEach((name) => problems[name].push(text));
    }
  }
  return problems;
}

/** Why a machine that installed fine is still not synced (no claude, no x.y.z claude, another version than before, no DISABLE_UPDATES=1 after), else ''. */
export function afterInstallProblem(machine, before, after, isTarget) {
  if (after.missing) return `${machine}: ${after.missing} after the install`;
  if (!VERSION.test(after.version)) return `${machine}: claude --version gave no x.y.z after the install`;
  if (after.version !== before.version) return `${machine}: claude is ${after.version} after the install, but was ${before.version} before it`;
  if (isTarget && after.pinned !== true) return `${machine}: DISABLE_UPDATES=1 is not set after the install, so the phase pin does not hold (put env.DISABLE_UPDATES "1" in that machine's settings/local.json, then sync again)`;
  return '';
}
