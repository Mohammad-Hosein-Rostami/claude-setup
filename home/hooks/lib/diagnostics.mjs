// Parses the output of a failed format run (tsc, eslint stylish and unix formats) into `file:line RULE-ID message` lines for post-edit.mjs.
// Exports: CODE_FILE, MAX_LINES, isSamePath(reported, target), diagnostics(output, file).
// Invariants: pure; at most MAX_LINES lines; failures that only concern other files yield [] so they never block.
export const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
export const MAX_LINES = 15;

const TSC_LINE = /^(.+?)\((\d+),\d+\): (?:error|warning) (TS\d+): (.*)$/;
// `path:line[:col]: message` (tsc --pretty false, eslint unix format); the lookahead keeps stylish rows out.
const COLON_LINE = /^(?!\d+:)(.+?):(\d+)(?::\d+)?:? (?:(?:error|warning)\s+)?(.*)$/;
const STYLISH_ROW = /^(\d+):\d+\s+(?:error|warning)\s+(.*)$/; // eslint default format row under a file header
const RULE_SEPARATOR = /\s{2,}(?=\S+$)/; // eslint prints the rule id after two or more spaces

/** "message  rule-id" -> "rule-id message"; messages without a rule id get the generic id LINT. */
function withRule(text) {
  const [message, rule] = text.split(RULE_SEPARATOR);
  return rule ? `${rule} ${message}` : `LINT ${text}`;
}

const normPath = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/** Whether a reported path is `target`: equal, or one is the other behind a `/` boundary (abs vs relative path). */
export function isSamePath(reported, target) {
  const p = normPath(reported);
  const t = normPath(target);
  return p === t || p.endsWith(`/${t}`) || t.endsWith(`/${p}`);
}

// An eslint stylish file header: a path-looking line without `:line`; pnpm's `> pkg@1 lint /dir` banner is not one.
const isStylishHeader = (l) => !l.startsWith('>') && !/:\d+/.test(l) && (CODE_FILE.test(l) || /[\\/]/.test(l));

/** One output line -> { path, text } for a `path:line message` diagnostic, or null; `header` is the stylish file in effect. */
function parseDiagnostic(l, header) {
  const t = TSC_LINE.exec(l);
  if (t) return { path: t[1], text: `${t[2]} ${t[3]} ${t[4]}` };
  const s = header ? STYLISH_ROW.exec(l) : null;
  if (s) return { path: header, text: `${s[1]} ${withRule(s[2])}` };
  const c = COLON_LINE.exec(l);
  return c ? { path: c[1], text: `${c[2]} ${withRule(c[3])}` } : null;
}

/**
 * Failure output (tsc, eslint stylish or unix format) -> at most 15 `file:line RULE-ID message` lines about `file`;
 * falls back to the raw tail. Failures that only concern other files yield no lines. Pure.
 * @param {string} output what the check printed
 * @param {string} file the file the lines must be about
 * @returns {string[]} `file:line RULE-ID message` lines, or the raw tail when nothing parses
 */
export function diagnostics(output, file) {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const found = [];
  let aboutOtherFiles = false;
  let header = null;
  for (const l of lines) {
    const d = parseDiagnostic(l, header);
    if (!d) {
      if (isStylishHeader(l)) header = l;
      continue;
    }
    if (isSamePath(d.path, file)) found.push(`${normPath(d.path)}:${d.text}`);
    else aboutOtherFiles = true;
  }
  if (!found.length && aboutOtherFiles) return [];
  return (found.length ? found : lines.slice(-MAX_LINES)).slice(0, MAX_LINES);
}
