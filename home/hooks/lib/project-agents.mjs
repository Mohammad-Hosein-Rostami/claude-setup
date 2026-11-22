// Project agent files that cap or shadow the owner's agents. Exports: projectAgentNote(sessionDir, personalDir), MAX_AGENT_FILES,
// NOTE_MAX_CHARS.
// A project agent wins over a personal or built-in agent of the same name, and a `maxTurns:` line in its frontmatter stops the agent
// mid-task (the owner's rule is no maxTurns). Used by the SessionStart session-notes hook and by scripts/doctor.sh (run this file as
// `node project-agents.mjs <sessionDir> <personalAgentsDir>`: it prints the note, or nothing).
// The parts: agent-folders.mjs (which folders Claude Code loads), agent-file-walk.mjs (their entries, under limits, never through a
// link), agent-frontmatter.mjs (what a frontmatter says, when it is plain), project-agents-text.mjs (the wording and the cap),
// shown-name.mjs (how a path from the repository is shown). Each cites what it read in the Claude Code 2.1.328 bundle.
// Read there for this file:
//   eZ(): H=[built-in,plugin,userSettings,projectSettings,flagSettings,policySettings];for(...)z.set(Q.agentType,Q)
//     a later source replaces an earlier one under the exact same name, so a project agent replaces a personal and a built-in one;
//     names are compared as they are (for example `Scout` and `scout` are two names).
//   Re-read in 2.1.329: the same order and `z.set(Q.agentType,Q)`; project agents of additional directories now come first.
//   Re-read in 2.1.330: the same order, plus `flagSettings` agents that carry `isEnabled` come first
//     (`z=[e.filter((Q)=>Q.source==="flagSettings"&&Q.isEnabled!==void 0),o,r,g,y,R,k]`); a project agent still replaces a
//     personal and a built-in one.
// Principle: the note is exact where it can be, says "check by hand" for everything else Claude Code could load, and is silent only
// for a file Claude Code itself does not load (no frontmatter, no closing ---, no `name`). It never states a guess as a fact:
// - "Shadowed personal agents" and "shadows the ... agent" come only from the exact `name` of a plain frontmatter.
// - The delete advice comes only from a `maxTurns` key line of a plain frontmatter, in a regular file with one hard link, inside the
//   session's git repository and reached through no link.
// - A frontmatter that is not plain, or longer than the head that is read, is one item "check by hand" with no other claim. So is a
//   name that only looks like one of the owner's (other case, spaces), and a maxTurns outside a git repository.
// - A file that is not read (a link, a hard link, past a limit) is checked by its base name only and called "named like".
// The SessionStart hook does not call this file in its own process: project-agents-timed.mjs runs it in a child with a timeout.
// Invariants: read-only; never throws; bounded work (see agent-file-walk.mjs and agent-folders.mjs). The check of a folder and the
// reads are separate calls: a folder swapped for a link between them is not caught. Personal agents are the `*.md` base names of the
// personal folder itself (in this setup a file is named like its agent; tests/agent-files.test.mjs).
import { readdirSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentEntries, newBudget, readAgentFile } from './agent-file-walk.mjs';
import { agentFolders } from './agent-folders.mjs';
import { frontmatterOf, plainFrontmatter } from './agent-frontmatter.mjs';
import { FIXED_ITEMS, REASONS, cappedNote } from './project-agents-text.mjs';
import { quotedPath, shownPath } from './shown-name.mjs';

export { MAX_AGENT_FILES } from './agent-file-walk.mjs';
export { NOTE_MAX_CHARS } from './project-agents-text.mjs';

// The built-in agents this setup relies on (security review p0-0.1 round 2, R2-6): untyped Agent calls go to general-purpose, the
// lead uses Explore and Plan. A fixed list: the CLI's own list is not read at run time.
const BUILT_IN_AGENTS = ['general-purpose', 'Explore', 'Plan', 'claude', 'claude-code-guide', 'statusline-setup'];
const AGENT_FILE = /\.md$/i;
const AGENTS_FOLDER = 'agents';
const SHADOW_REASONS = { personal: REASONS.shadowsPersonal, builtIn: REASONS.shadowsBuiltIn };
const NAMED_LIKE_REASONS = { personal: REASONS.namedLikePersonal, builtIn: REASONS.namedLikeBuiltIn };
const UNREAD_REASONS = { unread: REASONS.notRead, link: REASONS.link, 'hard-link': REASONS.hardLink };

const baseName = (file) => file.replace(AGENT_FILE, '');
/** A name as look-alikes are compared: compatibility forms, case and outer spaces removed. */
const folded = (name) => name.normalize('NFKC').toLowerCase().trim();

/** The personal agent names: the `*.md` base names of the owner's own folder (trusted), sorted; none when it cannot be listed. */
function personalAgents(personalDir) {
  try {
    return readdirSync(personalDir).filter((file) => AGENT_FILE.test(file)).map(baseName).sort();
  } catch {
    return [];
  }
}

/** The owner's agents a project agent can replace: the personal ones, and the built-in ones no personal agent has replaced. */
function ownerAgents(personalDir) {
  const personal = personalAgents(personalDir);
  return { personal, builtIn: BUILT_IN_AGENTS.filter((name) => !personal.includes(name)) };
}

/**
 * Which of the owner's agents a name is.
 * @returns {{ set?: 'personal' | 'builtIn', like?: string }} `set`: the name is exactly one of that set; `like`: it is not, but
 *   equals this one of the owner's names once both are folded.
 */
function ownerAgentFor(name, agents) {
  if (agents.personal.includes(name)) return { set: 'personal' };
  if (agents.builtIn.includes(name)) return { set: 'builtIn' };
  return { like: [...agents.personal, ...agents.builtIn].find((agent) => folded(agent) === folded(name)) };
}

const newFindings = () => ({
  groups: { shadowing: [], suspect: [], linked: [], byHand: [], capping: [] },
  shadowed: { personal: new Set(), builtIn: new Set() },
  hasCap: false,
  hasLink: false,
  unchecked: 0,
  folders: 0,
  byHand: 0,
});

/** Adds an entry that was not read: counted, and listed when it is a link or is named like one of the owner's agents. */
function addUnread(found, entry, kind, scope) {
  const { set } = ownerAgentFor(baseName(entry.name), scope.agents);
  if (kind === 'unread') found.unchecked += 1;
  else found.hasLink = true;
  if (kind === 'unread' && set === undefined) return;
  const reasons = [UNREAD_REASONS[kind], ...(set ? [NAMED_LIKE_REASONS[set]] : [])];
  found.groups[set ? 'suspect' : 'linked'].push(`${quotedPath(entry.folder, entry.name)} (${reasons.join(', ')})`);
}

/** Adds a file the hook makes no claim about: one item that says why it is to be checked by hand. */
function addByHand(found, entry, reason) {
  found.byHand += 1;
  found.groups.byHand.push(`${quotedPath(entry.folder, entry.name)} (${reason})`);
}

/**
 * Adds an agent whose name and maxTurns are exact, when it caps turns, shadows one of the owner's agents or looks like one.
 * `scope` is { agents, inRepository }: the owner's agents, and whether the session's git root is certain (see findings).
 */
function addAgent(found, entry, { name, turns }, { agents, inRepository }) {
  const { set, like } = ownerAgentFor(name, agents);
  const byHand = like !== undefined || (turns !== '' && !inRepository);
  const reasons = [
    ...(turns ? [inRepository ? turns : `${turns}, ${REASONS.noRepository}`] : []),
    ...(set ? [SHADOW_REASONS[set]] : []),
    ...(like ? [REASONS.looksLike(like)] : []),
  ];
  if (reasons.length === 0) return;
  if (set) found.shadowed[set].add(name);
  if (byHand) found.byHand += 1;
  found.hasCap ||= turns !== '' && !byHand; // "check by hand" means edit nothing, so such a file never brings the delete advice
  const group = (set && 'shadowing') || (like && 'suspect') || (byHand && 'byHand') || 'capping';
  found.groups[group].push(`${shownPath(entry.folder, entry.name)} (${reasons.join(', ')})`);
}

/** Adds what one agent file that was read says. A file Claude Code loads no agent from adds nothing. */
function addRead(found, entry, { head, cutShort }, scope) {
  const frontmatter = frontmatterOf(head);
  if (frontmatter.kind === 'none') return;
  if (frontmatter.kind === 'open') {
    if (cutShort) addByHand(found, entry, REASONS.longFrontmatter); // in a whole file an opening without a closing is no frontmatter
    return;
  }
  const facts = plainFrontmatter(frontmatter.text);
  if (!facts.plain) addByHand(found, entry, REASONS.notPlain);
  else if (facts.name !== '') addAgent(found, entry, facts, scope);
}

/** Adds one entry of a real agents folder. */
function addEntry(found, entry, scope) {
  if (entry.kind === 'folder-not-read') {
    found.folders += 1;
    return;
  }
  const read = entry.kind === 'file' ? readAgentFile(entry.path) : entry;
  if (read.kind === 'file') addRead(found, entry, read, scope);
  else if (read.kind !== 'gone') addUnread(found, entry, read.kind, scope);
}

/**
 * What the project's agent files do to the owner's agents.
 * @param {string} sessionDir - the session's folder.
 * @param {string} personalDir - the personal agents folder; the home folder is taken to be two levels above it.
 * @returns {object} the findings: see newFindings (`groups` hold the list items, the most important group first).
 */
function findings(sessionDir, personalDir) {
  const where = agentFolders(sessionDir, dirname(dirname(personalDir)), personalDir);
  const scope = { agents: ownerAgents(personalDir), inRepository: where.inRepository };
  const found = newFindings();
  const budget = newBudget();
  for (const [applies, item] of [[where.unsure, FIXED_ITEMS.foldersAbove], [where.mainCheckout, FIXED_ITEMS.mainCheckout]]) {
    if (!applies) continue;
    found.folders += 1;
    found.groups.linked.push(item);
  }
  for (const folder of where.folders) {
    if (folder.kind === 'real') {
      for (const entry of agentEntries(folder.path, folder.shown, budget)) addEntry(found, entry, scope);
      continue;
    }
    found.folders += 1;
    found.hasLink = true;
    found.groups.linked.push(`${quotedPath(folder.parentShown, AGENTS_FOLDER)} (${folder.kind === 'link' ? REASONS.link : REASONS.linkOutside})`);
  }
  return found;
}

/**
 * The one-line note for a session whose project has agent files that cap turns, shadow one of the owner's agents or cannot be
 * judged; at most NOTE_MAX_CHARS long (project-agents-text.mjs says when it can be longer).
 * @param {string} sessionDir - the session's folder (the hook input's `cwd`).
 * @param {string} personalDir - the personal agents folder (`~/.claude/agents`).
 * @returns {string} the note; '' when nothing was found and everything was checked (also for a session in the home folder).
 */
export function projectAgentNote(sessionDir, personalDir) {
  if (typeof sessionDir !== 'string' || sessionDir === '' || typeof personalDir !== 'string') return '';
  const { groups, shadowed, ...rest } = findings(sessionDir, personalDir);
  const items = [...groups.shadowing, ...groups.suspect, ...groups.linked, ...groups.byHand, ...groups.capping];
  return cappedNote({ ...rest, items, personal: [...shadowed.personal].sort(), builtIn: [...shadowed.builtIn].sort() });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const note = projectAgentNote(process.argv[2], process.argv[3]);
  if (note) console.log(note);
}
