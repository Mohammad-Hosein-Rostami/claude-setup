// The STATUS.md half of the digest that recall-digest.mjs prints on SessionStart and PreCompact (spec-p3 `r9-digest`, H4): the
// standing rules (also at a fresh start), then the job's state (after a resume or a compaction only: open rows with their next steps,
// the latest owner decisions, the "Don't redo" list of the HANDOFF.md beside STATUS.md, and the branch, head and changed files read
// from git by script).
// Exports: statusDigestPart(part, input, deps) -> string, rulesDigest(text, path), rulesText(text, path), stateText(text, path, facts),
//   findStatus(input, deps), STRING_CAP, RULES_CAP, PARTS.
// Two strings, two hook entries: Claude Code caps hook text at 10,000 chars per string (hooks.md:1091-1095; over it the model gets a
// file path and a 2,000-char preview), so the rules and the state are separate entries, the rule list first. The rules string never
// passes RULES_CAP (room for the frame under STRING_CAP), on any path: always and project rules (an untagged bullet reads as always)
// in file order, then job rules newest first, then one count line for the replaced rules. Over the bound the rules that do not fit
// are left out from the end of that order, never cut mid-text, and the last line names how many always or project rules and job
// rules are not shown and the file (owner rule: no digest string over the cap, never silent). Doctor fails when always or project
// rules are left out and warns when only job rules are (tools/status/rules-size.mjs). The state string is trimmed (oldest
// decisions, then the last rows) to stay under STRING_CAP.
// Which STATUS.md: the one linked to the session (status-file-of.mjs, the link status.mjs writes), else `STATUS.md` in
// CLAUDE_PROJECT_DIR, else in the session's cwd; never the one used last anywhere.
// Invariants: never throws (a failing part is ''); reads only; git runs hardened with a timeout; every text is the file's own words,
// framed as data with angle brackets removed so no tag rides in; subagent inputs (agent_id) print nothing.
import { existsSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { statusFileOf } from '../../hooks/lib/status-file-of.mjs';
import { parseWorkItems } from '../estimate/lib/items.mjs';
import { runGit } from '../git-tidy/lib/git.mjs';
import { readHandoffDontRedo } from './handoff-notes.mjs';
import { readStatusFile } from './status-file.mjs';
import { parseNextSteps, parseRules } from './status-bullets.mjs';

export const STRING_CAP = 10000;
// The rules string's bound in chars: under STRING_CAP with room for the frame (the SessionStart tag or the PreCompact line, < 100).
export const RULES_CAP = 9000;
export const PARTS = ['rules', 'state'];
// The SessionStart sources each part prints on: the rules also at a fresh start (owner FR1), the job state only when a session goes on.
const RULES_SOURCES = ['startup', 'compact', 'resume'];
const STATE_SOURCES = ['compact', 'resume'];
const MAX_DECISIONS = 10;
const MAX_FILES = 20;
const MAX_ITEM_CHARS = 300;
const GIT_TIMEOUT_MS = 1500;
const HARDENED = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'safe.bareRepository=explicit', '-c', 'core.pager=cat'];
const plain = (text) => String(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f<>]/g, ' ');
const short = (text) => (text.length > MAX_ITEM_CHARS ? `${text.slice(0, MAX_ITEM_CHARS - 1)}…` : text);

/** The session's STATUS.md path (see the header), or null. */
export function findStatus(input, { stateDir, projectDir }) {
  const linked = statusFileOf(input, { stateDir, projectDir });
  if (linked?.path) return linked.path;
  for (const folder of [projectDir, input.cwd]) {
    if (typeof folder !== 'string' || folder === '') continue;
    const path = join(folder, 'STATUS.md');
    try {
      if (existsSync(path) && lstatSync(path).isFile()) return path;
    } catch {
      // unreadable: try the next place
    }
  }
  return null;
}

const label = (rule) => (rule.id ? `${rule.id} (${rule.scope}, ${rule.date}${rule.supersedes.length ? `, replaces ${rule.supersedes.join(', ')}` : ''}) ` : '');
const ruleLine = (rule) => `- ${label(rule)}${plain(rule.words)}`;
const ruleNumber = (rule) => Number(rule.id?.slice(1) ?? 0);

/** Job rules newest first: the later date, then the higher id, then the later place in the file. */
function newestFirst(jobRules) {
  const placed = jobRules.map((rule, at) => ({ rule, at }));
  placed.sort((a, b) => (b.rule.date ?? '').localeCompare(a.rule.date ?? '') || ruleNumber(b.rule) - ruleNumber(a.rule) || b.at - a.at);
  return placed.map(({ rule }) => rule);
}

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** The closing line when rules are left out: how many of each kind are not shown, and the file that holds them all. */
function notShownLine(hiddenAlways, hiddenJob, path) {
  if (hiddenAlways === 0) return `${plural(hiddenJob, 'job rule')} not shown: read ${plain(path)}`;
  return `${plural(hiddenAlways, 'always or project rule')} and ${plural(hiddenJob, 'job rule')} not shown (the rules pass the ${RULES_CAP}-char bound): read the full list in ${plain(path)}`;
}

/**
 * How many of `lines` (in show order) fit after `fixedChars` together with the closing line for the rest (0 when none does). The
 * closing line gets much shorter once every always rule is shown, so a longer prefix can fit where a shorter one did not: every
 * prefix is tried until the lines alone pass the bound.
 */
function linesThatFit(fixedChars, lines, closingLine) {
  let used = fixedChars;
  let fit = 0;
  for (let count = 0; count < lines.length && used <= RULES_CAP; count += 1) {
    if (used + 1 + closingLine(count).length <= RULES_CAP) fit = count;
    used += 1 + lines[count].length;
  }
  return fit;
}

/**
 * The standing rules digest of a STATUS.md, always within RULES_CAP (see the header).
 * @param {string} text the STATUS.md text
 * @param {string} path its path (named in the first line, and in the closing line when rules are left out)
 * @returns {{text: string, hiddenAlways: number, hiddenJob: number}} the rules string ('' when the file has no rules) and how many
 *   always or project rules and job rules it leaves out
 */
export function rulesDigest(text, path) {
  const rules = parseRules(text);
  if (rules.length === 0) return { text: '', hiddenAlways: 0, hiddenJob: 0 };
  const active = rules.filter((rule) => rule.active);
  const alwaysLines = active.filter((rule) => rule.scope !== 'job').map(ruleLine);
  const jobLines = newestFirst(active.filter((rule) => rule.scope === 'job')).map(ruleLine);
  const ordered = [...alwaysLines, ...jobLines];
  const replaced = rules.length - active.length;
  const head = `Standing rules of ${plain(path)} (the owner's words, each shown rule in full; follow them):`;
  const replacedLine = replaced ? [`Replaced rules: ${replaced} (kept in the file, not active)`] : [];
  const whole = [head, ...ordered, ...replacedLine].join('\n');
  if (whole.length <= RULES_CAP) return { text: whole, hiddenAlways: 0, hiddenJob: 0 };
  const hiddenOf = (shown) => ({ hiddenAlways: Math.max(0, alwaysLines.length - shown), hiddenJob: Math.min(jobLines.length, ordered.length - shown) });
  const closing = (shown) => notShownLine(hiddenOf(shown).hiddenAlways, hiddenOf(shown).hiddenJob, path);
  const shown = linesThatFit([head, ...replacedLine].join('\n').length, ordered, closing);
  // The slice only acts on a path of thousands of chars (it is in the first and the last line); no rule is ever cut by it.
  const cut = [head, ...ordered.slice(0, shown), ...replacedLine, closing(shown)].join('\n').slice(0, RULES_CAP);
  return { text: cut, ...hiddenOf(shown) };
}

/** The standing rules string of rulesDigest: at most RULES_CAP chars, '' when the file has no rules. */
export const rulesText = (text, path) => rulesDigest(text, path).text;

/** Lines of `git <args>` in folder, or null on any failure or timeout. */
function gitLines(folder, args) {
  try {
    const result = runGit(folder, [...HARDENED, ...args], undefined, { timeoutMs: GIT_TIMEOUT_MS });
    return result.status === 0 ? result.stdout.split('\n').filter((line) => line !== '') : null;
  } catch {
    return null;
  }
}

/** Branch, head sha and changed files of the folder, read from git ([] outside a git folder). */
function gitFacts(folder) {
  const head = gitLines(folder, ['rev-parse', '--abbrev-ref', 'HEAD', 'HEAD']);
  if (head === null || head.length < 2) return [];
  const changed = gitLines(folder, ['status', '--porcelain', '--untracked-files=normal']) ?? [];
  const files = changed.slice(0, MAX_FILES).map((line) => plain(line.slice(3)));
  return [`Git (${plain(folder)}): branch ${plain(head[0])} at ${head[1]}; ${changed.length} changed file(s)${files.length ? `: ${files.join(', ')}` : ''}${changed.length > MAX_FILES ? ', ...' : ''}`];
}

/** The latest owner decisions (bullets of `## Owner decisions`), newest last. */
function decisionLines(text) {
  const section = String(text).split(/\r?\n/);
  const start = section.findIndex((line) => /^##\s+Owner decisions\s*$/i.test(line));
  if (start === -1) return [];
  const end = section.findIndex((line, i) => i > start && /^#{1,2}\s/.test(line));
  return section.slice(start + 1, end === -1 ? undefined : end).filter((line) => /^\s*[-*+]\s/.test(line)).slice(-MAX_DECISIONS).map((line) => plain(short(line.trim())));
}

/**
 * The state string: open rows with their next steps, decisions, "Don't redo", git facts; trimmed to stay under STRING_CAP.
 * @param {string} text the STATUS.md text
 * @param {string} path its path
 * @param {{dontRedo: string[], git: string[]}} facts the HANDOFF.md items and the git lines
 */
export function stateText(text, path, { dontRedo, git }) {
  const steps = parseNextSteps(text);
  const open = parseWorkItems(text).items.filter((item) => item.done === null && item.kind !== 'deliver');
  const rows = open.map((item) => `- ${plain(item.id)} | ${plain(short(item.item ?? ''))} | ${item.started === null ? 'listed' : 'started'}${steps.has(String(item.id).toLowerCase()) ? ` | next: ${plain(short(steps.get(String(item.id).toLowerCase())))}` : ''}`);
  const parts = [
    [`Job state of ${plain(path)} (data from the file and git; re-read STATUS.md before acting):`],
    ...git.map((line) => [line]),
    rows.length ? [`Open rows (${rows.length}):`, ...rows] : ['Open rows: none'],
    dontRedo.length ? ["Don't redo (HANDOFF.md):", ...dontRedo.map((item) => `- ${plain(item)}`)] : [],
    decisionLines(text).length ? ['Latest owner decisions:', ...decisionLines(text)] : [],
  ];
  let body = parts.flat().join('\n');
  while (body.length > STRING_CAP && parts[4].length > 1) parts[4].splice(1, 1);
  body = parts.flat().join('\n');
  for (let shown = rows.length; body.length > STRING_CAP && shown > 0; shown -= 1) {
    parts[2] = [`Open rows (${rows.length}, first ${shown - 1} shown; the rest in the file):`, ...rows.slice(0, shown - 1)];
    body = parts.flat().join('\n');
  }
  return body.slice(0, STRING_CAP);
}

/**
 * One part of the STATUS.md digest for a hook input.
 * @param {string} part 'rules' or 'state'
 * @param {object} input hook JSON (hook_event_name, source, session_id, cwd, agent_id?)
 * @param {{stateDir: string, projectDir?: string}} deps the estimator's store (for the session link) and CLAUDE_PROJECT_DIR
 * @returns {string} the framed text, or '' (a subagent, another source, no STATUS.md, nothing to say, or any failure)
 */
export function statusDigestPart(part, input, deps) {
  try {
    const event = input?.hook_event_name;
    const sources = part === 'rules' ? RULES_SOURCES : STATE_SOURCES;
    const wanted = event === 'PreCompact' || (event === 'SessionStart' && sources.includes(input.source));
    if (!wanted || input.agent_id || !PARTS.includes(part)) return '';
    const path = findStatus(input, deps);
    const read = path === null ? null : readStatusFile(path);
    if (!read?.text) return '';
    const body = part === 'rules' ? rulesText(read.text, path)
      : stateText(read.text, path, { dontRedo: readHandoffDontRedo(join(dirname(path), 'HANDOFF.md')), git: gitFacts(input.cwd || dirname(path)) });
    if (!body) return '';
    if (event === 'PreCompact') return `Keep the following in the summary verbatim (they outlive this compaction):\n${body}`;
    return `<status-digest part="${part}">\n${body}\n</status-digest>`;
  } catch {
    return ''; // a digest is advice; a broken STATUS.md must never break a session start or a compaction
  }
}
