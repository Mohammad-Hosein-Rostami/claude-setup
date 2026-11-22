// The bullet lists of a STATUS.md for status.mjs and the digest: standing rules with ids, owner decisions, next steps per row.
// Exports: BULLET_EDITS { rule, decision, next } (status.mjs edit functions: (lines, args, now) -> {} | { usage } | { error }),
//   parseRules(text) -> [{ id, date, scope, words, supersedes, supersededBy, active }], parseNextSteps(text) -> Map<rowId, step>,
//   SCOPES, RULE_TAG.
// Rule bullet (spec-p3 `r9-digest`, research2/state.md P1): `- <owner words> {R<n> <YYYY-MM-DD> <scope>[; supersedes R<m>][; superseded by R<k>]}`.
//   The owner's words come first and stay whole; a rule that a newer one replaces is marked `superseded by`, never deleted. A bullet
//   without the tag (written before ids) is an active rule with no id. A rule added without `--scope` is `always` (OD-7); tags `job`
//   and `project` written earlier still read.
// Next step bullet: `- <row id>: <step>` under `## Next steps`, one per row, replaced in place by a newer `next` for the same row.
// Invariants: an edit touches only the lines it adds or changes (a `rule --supersedes` changes the new and the replaced bullet);
//   sections and fences are found with the estimator's findSection, so a fenced example is never edited or read; dates are UTC.
import { findSection } from '../estimate/lib/items.mjs';
import { WORK_ITEMS, hiddenEndReason, oneLine, sectionEnd } from './status-table.mjs';

export const SCOPES = ['job', 'project', 'always'];
export const RULE_TAG = /\s\{(R\d+) (\d{4}-\d{2}-\d{2}) (job|project|always)((?:; (?:supersedes|superseded by) R\d+)*)\}\s*$/;
const DEFAULT_SCOPE = 'always'; // owner decision OD-7 (2026-11-21): a rule without `--scope` holds for every job; `job` and `project` are said on purpose
const SECTION_FOR = { rule: 'Standing rules', decision: 'Owner decisions', next: 'Next steps' };
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NEXT_BULLET = /^- ([A-Za-z0-9][\w.:-]{0,39}): (.*)$/;
const ROW_ID = /^[A-Za-z0-9][\w.:-]{0,39}$/;
const RULE_ID = /^R\d+$/;

const day = (now) => now.toISOString().slice(0, 10);

/** The visible bullet line indexes of one section ([] when it is missing). */
function bulletIndexes(lines, name) {
  const section = findSection(lines, name);
  if (section.start === -1) return [];
  const found = [];
  for (let i = section.start + 1; i < section.end; i += 1) if (section.visible[i] && BULLET.test(lines[i])) found.push(i);
  return found;
}

/** Puts a bullet at the end of its section, making the section (before `## Work items`) when there is none. */
function placeBullet(lines, name, bullet) {
  const section = findSection(lines, name);
  if (section.start === -1) {
    const workItems = findSection(lines, WORK_ITEMS).start;
    const hidden = workItems === -1 ? hiddenEndReason(lines) : null;
    if (hidden !== null) return { error: hidden };
    lines.splice(workItems === -1 ? lines.length : workItems, 0, `## ${name}`, bullet, '');
    return {};
  }
  if (section.openFence > section.start && section.openFence < section.end) {
    return { error: `unclosed code fence at line ${section.openFence + 1}, inside the \`## ${name}\` section: a bullet added at its end would be hidden in the fence; close the fence first` };
  }
  lines.splice(sectionEnd(lines, section), 0, bullet);
  return {};
}

/** One rule bullet's parts; words is the owner's text without the tag. */
function parseRule(text) {
  const tag = RULE_TAG.exec(text);
  if (tag === null) return { id: null, date: null, scope: null, words: text.trim(), supersedes: [], supersededBy: [], active: true };
  const links = tag[4].split('; ').filter(Boolean);
  const supersedes = links.filter((link) => link.startsWith('supersedes ')).map((link) => link.split(' ').at(-1));
  const supersededBy = links.filter((link) => link.startsWith('superseded by ')).map((link) => link.split(' ').at(-1));
  return { id: tag[1], date: tag[2], scope: tag[3], words: text.slice(0, tag.index).trim(), supersedes, supersededBy, active: supersededBy.length === 0 };
}

/**
 * The rules under `## Standing rules`, in file order.
 * @param {string} text a STATUS.md
 * @returns {{id: string|null, date: string|null, scope: string|null, words: string, supersedes: string[], supersededBy: string[], active: boolean}[]}
 */
export function parseRules(text) {
  const lines = String(text).split(/\r?\n/);
  return bulletIndexes(lines, SECTION_FOR.rule).map((i) => parseRule(BULLET.exec(lines[i])[1]));
}

/** The `rule` flags: `--scope <s>`, `--supersedes R<n>`; the rest is the owner's text. */
function ruleArgs(args) {
  const words = [];
  const flags = { scope: DEFAULT_SCOPE, supersedes: null };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--scope' || args[i] === '--supersedes') flags[args[i].slice(2)] = args[++i] ?? '';
    else words.push(args[i]);
  }
  return { text: oneLine(words.join(' ')), ...flags };
}

function addRule(lines, args, now) {
  const { text, scope, supersedes } = ruleArgs(args);
  if (!text || !SCOPES.includes(scope) || (supersedes !== null && !RULE_ID.test(supersedes))) {
    return { usage: `rule needs "<text>" [--scope ${SCOPES.join('|')}] [--supersedes R<n>]` };
  }
  const indexes = bulletIndexes(lines, SECTION_FOR.rule);
  const rules = indexes.map((i) => parseRule(BULLET.exec(lines[i])[1]));
  if (rules.some((rule) => rule.active && rule.words === text)) return {};
  const replaced = supersedes === null ? -1 : rules.findIndex((rule) => rule.id === supersedes);
  if (supersedes !== null && replaced === -1) return { error: `no rule ${supersedes} under \`## ${SECTION_FOR.rule}\`` };
  const id = `R${Math.max(0, ...rules.map((rule) => Number(rule.id?.slice(1) ?? 0))) + 1}`;
  const placed = placeBullet(lines, SECTION_FOR.rule, `- ${text} {${id} ${day(now)} ${scope}${supersedes ? `; supersedes ${supersedes}` : ''}}`);
  if (placed.error || replaced === -1) return placed;
  const at = bulletIndexes(lines, SECTION_FOR.rule)[replaced]; // the new bullet comes after it, so its index is unchanged
  lines[at] = lines[at].replace(/\}\s*$/, `; superseded by ${id}}`);
  return {};
}

function addDecision(lines, [text], now) {
  const body = oneLine(text ?? '');
  if (!body) return { usage: 'decision needs the text' };
  const bullet = `- ${day(now)} ${body}`;
  if (bulletIndexes(lines, SECTION_FOR.decision).some((i) => lines[i] === bullet)) return {};
  return placeBullet(lines, SECTION_FOR.decision, bullet);
}

/**
 * The next step stored per row under `## Next steps`.
 * @param {string} text a STATUS.md
 * @returns {Map<string, string>} row id (lower case) -> step
 */
export function parseNextSteps(text) {
  const lines = String(text).split(/\r?\n/);
  const steps = new Map();
  for (const i of bulletIndexes(lines, SECTION_FOR.next)) {
    const match = NEXT_BULLET.exec(lines[i]);
    if (match) steps.set(match[1].toLowerCase(), match[2]);
  }
  return steps;
}

function setNext(lines, [id, ...words]) {
  const step = oneLine(words.join(' '));
  if (!ROW_ID.test(id ?? '') || !step) return { usage: 'next needs <id> "<step>"' };
  const bullet = `- ${id}: ${step}`;
  const same = bulletIndexes(lines, SECTION_FOR.next).find((i) => NEXT_BULLET.exec(lines[i])?.[1].toLowerCase() === id.toLowerCase());
  if (same === undefined) return placeBullet(lines, SECTION_FOR.next, bullet);
  lines[same] = bullet;
  return {};
}

export const BULLET_EDITS = { rule: addRule, decision: addDecision, next: setNext };
