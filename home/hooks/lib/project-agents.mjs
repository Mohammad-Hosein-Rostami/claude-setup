// Project agent files that cap or shadow the owner's personal agents. Exports: projectAgentNote(projectDir, personalDir), MAX_AGENT_FILES, NOTE_MAX_CHARS.
// A project's `.claude/agents/*.md` wins over a personal agent of the same name, and a `maxTurns:` line in its frontmatter
// stops the agent mid-task (the owner's rule is no maxTurns). Used by the SessionStart mode hook and by scripts/doctor.sh
// (run this file as `node project-agent-note <projectDir> <personalAgentsDir>`: it prints the note, or nothing).
// Invariants: read-only; never throws (an unreadable folder or file counts as "nothing found"). The files come from whatever repository
// the session opens, so they are untrusted: a link, FIFO, device or folder is never read (lstat, then O_NOFOLLOW and O_NONBLOCK with the
// type checked on the open handle), only the first AGENT_HEAD_BYTES of a file and at most MAX_AGENT_FILES files are read, and a file name or
// maxTurns value reaches the note only escaped on one line (a name outside SAFE_FILE_NAME is quoted with its control and format characters
// as \u escapes, cut to NAME_SHOWN_CHARS; a maxTurns value that is not a number shows as "maxTurns set"). The note is at most NOTE_MAX_CHARS
// long whatever the folder holds: it lists whole items only (never cut inside an item or a \u escape), always keeps the advice, and
// counts the items it left out together with the files not read in one "and N more files not shown".
import { constants, existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { UNPRINTABLE, readFileHead } from './agent-brief.mjs';

export const MAX_AGENT_FILES = 200; // a real project has a few dozen agents at most
// Longest note, in characters (String length). The note is one part of the single string mode.mjs prints at SessionStart, and Claude Code
// shows the lead only a 2,000-character preview of a hook's stdout above 10,000 characters. The other parts measure up to about 8,800
// (tests/session-start-size.test.mjs), which leaves room for 800: ten agents copied from the personal set fit whole, and so does the
// longest single item (about 435 characters) with the count and both pieces of advice.
export const NOTE_MAX_CHARS = 800;
const NOTE_START = 'Project agent files in .claude/agents: ';
const AGENT_HEAD_BYTES = 8 * 1024; // the frontmatter sits at the top; a longer file is cut there
const NAME_SHOWN_CHARS = 64;
const AGENT_FILE = /\.md$/i;
const SAFE_FILE_NAME = /^[\w.-]{1,64}\.md$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const MAX_TURNS_LINE = /^maxTurns:[ \t]*(\S+)/m;
const TURNS_NUMBER = /^\d{1,6}$/;
const NAME_LINE = /^name:\s*["']?([\w.-]+)/m;
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0); // Windows has neither flag: lstat stands alone

/** A file name as the note shows it: as it is when plain, else quoted with every control or format character escaped. */
function shownName(file) {
  if (SAFE_FILE_NAME.test(file)) return file;
  const cut = file.length > NAME_SHOWN_CHARS ? `${file.slice(0, NAME_SHOWN_CHARS)}...` : file;
  const escaped = cut.replace(/["\\]/g, '\\$&').replace(UNPRINTABLE, (char) => {
    const named = { '\n': '\\n', '\r': '\\r', '\t': '\\t' }[char];
    return named ?? `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`;
  });
  return `"${escaped}"`;
}

/** The head of a regular agent file, or '' for a link, FIFO, device, folder or unreadable file. */
function readAgentHead(path) {
  try {
    if (!lstatSync(path).isFile()) return '';
    return readFileHead(path, AGENT_HEAD_BYTES, OPEN_FLAGS) ?? '';
  } catch {
    return ''; // gone, a link swapped in after the lstat (ELOOP), or unreadable: nothing found
  }
}

function agentFiles(dir) {
  try {
    return readdirSync(dir).filter((file) => AGENT_FILE.test(file)).sort();
  } catch {
    return [];
  }
}

/**
 * One finding per project agent file that sets maxTurns or shares its name with a personal agent, plus how many files were not read (`unread`).
 * The flags say which reasons were found: the advice is chosen from them, never from the item text, which carries untrusted file names.
 */
function findings(projectAgents, personalAgents) {
  const personal = new Set(agentFiles(personalAgents).map((file) => basename(file, '.md')));
  const files = agentFiles(projectAgents);
  const found = { items: [], hasCap: false, hasShadow: false, unread: Math.max(0, files.length - MAX_AGENT_FILES) };
  for (const file of files.slice(0, MAX_AGENT_FILES)) {
    const frontmatter = readAgentHead(join(projectAgents, file)).match(FRONTMATTER)?.[1] ?? '';
    const name = frontmatter.match(NAME_LINE)?.[1] ?? basename(file, '.md');
    const reasons = [];
    const turns = frontmatter.match(MAX_TURNS_LINE)?.[1];
    if (turns) reasons.push(TURNS_NUMBER.test(turns) ? `maxTurns ${turns}` : 'maxTurns set');
    if (personal.has(name)) reasons.push('shadows the personal agent');
    if (reasons.length) found.items.push(`${shownName(file)} (${reasons.join(', ')})`);
    found.hasCap ||= Boolean(turns);
    found.hasShadow ||= personal.has(name);
  }
  return found;
}

/** The note that lists the first `shown` items; the other items and the unread files become one count. The advice never depends on `shown`. */
function noteWith({ items, hasCap, hasShadow, unread }, shown) {
  const listed = items.slice(0, shown);
  const notShown = items.length - shown + unread;
  if (notShown > 0) listed.push(`and ${notShown} more files not shown`);
  const advice = [];
  if (hasCap) advice.push('the lead deletes each frontmatter maxTurns: line in its own commit, no need to ask');
  if (hasShadow) advice.push('tell the owner (project repos keep only project config)');
  return `${NOTE_START}${listed.join(', ')} - ${advice.join('; ')}.`;
}

/**
 * The note with as many leading items as fit in NOTE_MAX_CHARS. The first item always fits: an item is about 435 characters at most
 * (NAME_SHOWN_CHARS escapes of six characters plus the reasons), far below the cap less the start, the count and the advice.
 */
function cappedNote(found) {
  const whole = noteWith(found, found.items.length);
  if (whole.length <= NOTE_MAX_CHARS) return whole;
  let shown = 0;
  while (shown + 1 < found.items.length && noteWith(found, shown + 1).length <= NOTE_MAX_CHARS) shown += 1;
  return noteWith(found, shown);
}

/**
 * The one-line note, at most NOTE_MAX_CHARS long, for a session whose project has agent files that cap turns or shadow personal agents.
 * @param {string} projectDir - the session's project folder.
 * @param {string} personalDir - the personal agents folder (`~/.claude/agents`).
 * @returns {string} the note, or '' when there is nothing to say (also when the project agents folder is the personal one).
 */
export function projectAgentNote(projectDir, personalDir) {
  if (typeof projectDir !== 'string' || projectDir === '') return '';
  const projectAgents = join(projectDir, '.claude', 'agents');
  try {
    if (existsSync(personalDir) && realpathSync(projectAgents) === realpathSync(personalDir)) return '';
  } catch {
    // no project agents folder: findings() returns nothing
  }
  const found = findings(projectAgents, personalDir);
  return found.items.length ? cappedNote(found) : '';
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const note = projectAgentNote(process.argv[2], process.argv[3]);
  if (note) console.log(note);
}
