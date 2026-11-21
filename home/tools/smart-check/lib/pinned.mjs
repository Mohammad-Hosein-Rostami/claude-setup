// Purpose: the smart check's pinned checks (spec r9-smart-check 3): run on every change, never sampled, about 0 tokens: parse,
//   imports and named exports resolve, new dependencies exist, never-weaken scan (report only), secrets on added lines, placeholders
//   and conflict markers, size caps (C3, C4 and the session-start caps), files touched vs the brief's list, hook files load.
// Exports: runPinned(plan, {briefFiles, deadline}), PLACEHOLDER, CONFLICT_MARKER.
// Invariants: each check returns {name, findings[], block, seconds}; `block` false means report only. Findings name a path, a line and
//   a kind, never the line's text (a secret is named by its kind only). Every subprocess has its own timeout inside the deadline; a check
//   that cannot run says so in one finding-free note and never blocks.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { weakenedChecks } from '../../review-tier/lib/weakened.mjs';
import { findLiteralSecret } from '../../../hooks/lib/secrets.mjs';
import { depFindings, importFindings } from './pinned-code.mjs';
import { newFileReader } from './git-changes.mjs';

const PARSE_TIMEOUT_MS = 5_000;
const MAX_PARSED_FILES = 40;
const FILE_MAX_LINES = 300; // C4
const FUNCTION_MAX_LINES = 40; // C3
const MODE_TEXT_MAX = 9_850; // tests/session-start-size.test.mjs: 10,000 less 150 headroom
const LEAD_TEXT_MAX = 10_000; // Claude Code's cap on one hook string
// Built from parts so this file does not match its own scan.
export const CONFLICT_MARKER = new RegExp(`^(${'<'.repeat(7)}|${'='.repeat(7)}|${'>'.repeat(7)})( |$)`);
export const PLACEHOLDER = new RegExp(['not ' + 'implemented', 'rest (of (the )?(code|file) )?' + 'unchanged', '\\.\\.\\. ?(existing|previous) ' + 'code', 'TODO: ' + 'implement', 'FIX' + 'ME'].join('|'), 'i');
const PLAIN_TODO = new RegExp(`^\\s*${'TO'}DO\\b(?!\\()`); // a comment that starts with the word, with no (ref)
const JS = /\.(mjs|cjs|js)$/;
const CODE = /\.(m?[jt]sx?|cjs)$/;
const DOC = /\.(md|mdx|txt|rst)$/;
const HOOK_CODE = /(^|\/)(home\/hooks|\.claude\/hooks)\/.+\.(mjs|cjs|js)$/;

const timed = (name, block, work) => {
  const started = Date.now();
  try {
    return { name, block, findings: work(), seconds: (Date.now() - started) / 1000 };
  } catch (error) {
    return { name, block: false, findings: [], note: `${name}: could not run (${String(error.message).slice(0, 100)})`, seconds: (Date.now() - started) / 1000 };
  }
};
const run = (cmd, args, options = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: PARSE_TIMEOUT_MS, windowsHide: true, ...options });
const firstLine = (text) => String(text ?? '').split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 200) ?? '';
const present = (plan) => plan.files.filter((file) => existsSync(join(plan.top, file.path)));

/** P1: node --check, JSON.parse (comments allowed in tsconfig), bash -n. */
function parseFindings(plan, readNew) {
  const findings = [];
  for (const file of present(plan).slice(0, MAX_PARSED_FILES)) {
    const full = join(plan.top, file.path);
    if (JS.test(file.path)) {
      const result = run(process.execPath, ['--check', full]);
      if (result.status !== 0 && !result.error) findings.push(`${file.path}: does not parse: ${firstLine(result.stderr.split('\n').find((l) => /Error/.test(l)) ?? result.stderr)}`);
    } else if (file.path.endsWith('.json')) {
      const text = readNew(file.path) ?? '';
      try { JSON.parse(text); } catch (error) {
        const relaxed = /tsconfig|jsconfig|\.vscode\//.test(file.path) ? text.replace(/\/\*[\s\S]*?\*\/|(^|[^:"])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1') : null;
        try { if (relaxed === null) throw error; JSON.parse(relaxed); } catch { findings.push(`${file.path}: not valid JSON (${firstLine(error.message)})`); }
      }
    } else if (file.path.endsWith('.sh') || /(^|\/)\.githooks\/[^/.]+$/.test(file.path)) {
      const result = run('bash', ['-n', full]);
      if (result.status !== 0 && !result.error) findings.push(`${file.path}: bash -n: ${firstLine(result.stderr)}`);
    }
  }
  return findings;
}

/** P5: literal secrets on added lines (kind only); docs are report only, so they come back as a second list. */
function secretFindings(plan) {
  const found = [];
  for (const file of plan.files) {
    for (const { line, text } of file.added) {
      const kind = findLiteralSecret(text);
      if (kind) found.push({ doc: DOC.test(file.path), text: `${file.path}:${line}: ${kind} on an added line` });
    }
  }
  return found;
}

/** The part of a code line where a stub hides: its comment, or the whole line of a `throw`; '' for plain code and strings. */
const stubPartOf = (text) => (/^\s*throw\b/.test(text) ? text : (/(?:^\s*(?:\/\/|\/\*|\*|#)|\s\/\/)(.*)$/.exec(text)?.[1] ?? ''));

/** P6: conflict markers and stubs block; a plain TODO without a reference is report only. */
function placeholderFindings(plan, { blocking }) {
  const found = [];
  for (const file of plan.files.filter((f) => !DOC.test(f.path) || CONFLICT_MARKER.test(f.added.map((l) => l.text).join('\n')))) {
    for (const { line, text } of file.added) {
      if (CONFLICT_MARKER.test(text)) found.push({ block: true, text: `${file.path}:${line}: conflict marker` });
      else if (CODE.test(file.path) && PLACEHOLDER.test(stubPartOf(text))) found.push({ block: true, text: `${file.path}:${line}: placeholder or stub left in new code` });
      else if (CODE.test(file.path) && PLAIN_TODO.test(stubPartOf(text))) found.push({ block: false, text: `${file.path}:${line}: TODO without a reference (C27: TODO(ref): reason)` });
    }
  }
  return found.filter((f) => f.block === blocking).map((f) => f.text);
}

/** Functions (declarations and arrow bodies at line start) longer than C3 that hold an added line. */
function longFunctions(path, text, addedLines) {
  const lines = text.split('\n');
  const found = [];
  lines.forEach((line, index) => {
    const start = /^(\s*)(export\s+)?(default\s+)?(async\s+)?function\b|^(\s*)(export\s+)?const\s+\w+\s*=\s*(async\s+)?\([^)]*\)\s*=>\s*\{\s*$/.exec(line);
    if (!start) return;
    const indent = (start[1] ?? start[5] ?? '').length;
    const end = lines.findIndex((other, j) => j > index && new RegExp(`^\\s{${indent}}\\}`).test(other) && other.trim().startsWith('}'));
    const length = end < 0 ? 0 : end - index + 1;
    if (length > FUNCTION_MAX_LINES && [...addedLines].some((n) => n > index && n <= end + 1)) found.push(`${path}:${index + 1}: function of ${length} lines (C3: at most ${FUNCTION_MAX_LINES})`);
  });
  return found;
}

/** P7: files over 300 lines that this change grew past the cap or created, long functions it touched. */
function sizeFindings(plan, readNew) {
  const findings = [];
  for (const file of plan.files.filter((f) => CODE.test(f.path))) {
    const text = readNew(file.path);
    if (text === null) continue;
    const count = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    const before = count - file.added.length + file.removed.length;
    if (count > FILE_MAX_LINES && (file.isNew || before <= FILE_MAX_LINES)) findings.push(`${file.path}: ${count} lines (C4: at most ${FILE_MAX_LINES})`);
    findings.push(...longFunctions(file.path, text, new Set(file.added.map(({ line }) => line))));
  }
  return findings;
}

/** The session-start caps of this setup (mode.mjs string, lead text), measured when their text changed. */
function sessionCapFindings(plan) {
  const modeHook = join(plan.top, 'home', 'hooks', 'mode.mjs');
  if (!existsSync(modeHook) || !plan.facts.paths.some((p) => /^home\/(modes\/|lead\.md$|agents\/|hooks\/(mode|lead-text)\.mjs$)/.test(p))) return [];
  const home = mkdtempSync(join(tmpdir(), 'smart-check-caps-'));
  mkdirSync(join(home, '.claude'));
  for (const name of ['modes', 'agents']) symlinkSync(join(plan.top, 'home', name), join(home, '.claude', name));
  const input = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'smart-check-caps', source: 'startup', model: 'claude-haiku-5-5', cwd: home });
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_MODE: 'ultra-high' };
  const findings = [];
  const mode = run(process.execPath, [modeHook], { input, env });
  if (mode.stdout && mode.stdout.length > MODE_TEXT_MAX) findings.push(`home/hooks/mode.mjs prints ${mode.stdout.length} characters at start (cap ${MODE_TEXT_MAX})`);
  const lead = run(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(pathToFileURL(join(plan.top, 'home', 'hooks', 'lead-text.mjs')).href)}); process.stdout.write(await m.leadText({ hook_event_name: 'SessionStart' }, ${JSON.stringify(join(plan.top, 'home', 'lead.md'))}))`], { env });
  if (lead.stdout && lead.stdout.length > LEAD_TEXT_MAX) findings.push(`home/lead.md prints ${lead.stdout.length} characters (cap ${LEAD_TEXT_MAX})`);
  return findings;
}

/** P8: files touched that the brief does not list, and listed files never touched (report only). */
function scopeFindings(plan, briefFiles) {
  if (!briefFiles) return [];
  const listed = new Set(briefFiles);
  const touched = new Set(plan.facts.paths);
  return [...[...touched].filter((p) => !listed.has(p)).map((p) => `${p}: touched, not in the brief's file list`),
    ...[...listed].filter((p) => !touched.has(p)).map((p) => `${p}: in the brief's file list, never touched`)];
}

/** Hook files load: each changed hook module is imported in a child with a scratch HOME (its own main does not run). */
function hookLoadFindings(plan) {
  const home = mkdtempSync(join(tmpdir(), 'smart-check-load-'));
  const findings = [];
  for (const path of plan.facts.paths.filter((p) => HOOK_CODE.test(p) && existsSync(join(plan.top, p)))) {
    const href = pathToFileURL(join(plan.top, path)).href;
    const result = run(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(href)})`, process.execPath], { cwd: home, input: '', env: { ...process.env, HOME: home, USERPROFILE: home } });
    if (result.error?.code === 'ETIMEDOUT') findings.push(`${path}: loading it did not end within ${PARSE_TIMEOUT_MS / 1000} s`);
    else if (result.status !== 0) findings.push(`${path}: does not load: ${firstLine(result.stderr.split('\n').find((l) => /Error|Cannot/.test(l)) ?? result.stderr)}`);
  }
  return findings;
}

/**
 * Runs every pinned check.
 * @param {object} plan from buildPlan
 * @param {{briefFiles: string[] | null, deadline: number}} options the brief's file list (P8), when the caller has one
 * @returns {{name: string, findings: string[], block: boolean, seconds: number, note?: string}[]}
 */
export function runPinned(plan, { briefFiles }) {
  const readNew = newFileReader(plan.top);
  const secrets = secretFindings(plan);
  return [
    timed('parse', true, () => parseFindings(plan, readNew)),
    timed('imports', true, () => importFindings(plan)),
    timed('deps', true, () => depFindings(plan)),
    timed('never-weaken', false, () => weakenedChecks(plan.files).map((hit) => `${hit.path}:${hit.line}: ${hit.kind} (C13)`)),
    timed('secrets', true, () => secrets.filter((s) => !s.doc).map((s) => s.text)),
    timed('secrets-in-docs', false, () => secrets.filter((s) => s.doc).map((s) => s.text)),
    timed('placeholders', true, () => placeholderFindings(plan, { blocking: true })),
    timed('todo', false, () => placeholderFindings(plan, { blocking: false })),
    timed('size-caps', false, () => sizeFindings(plan, readNew)),
    timed('session-caps', true, () => sessionCapFindings(plan)),
    timed('scope', false, () => scopeFindings(plan, briefFiles)),
    timed('hook-load', true, () => hookLoadFindings(plan)),
  ];
}
